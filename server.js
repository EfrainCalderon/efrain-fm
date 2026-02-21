require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Rate limiting — 10 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    response: "You're moving fast! Take a breath and try again in a minute.",
    song: null
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/chat', limiter);

// Load songs database
const songsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));

// Session storage
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { playedSongs: [] });
  }
  return sessions.get(sessionId);
}

// Helper: Extract keywords from user message using Claude (small, cheap call)
async function extractKeywords(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `Extract music-related search concepts from this request. Return ONLY a JSON array of keywords.

Be semantic — expand concepts to related terms:
- "rap" or "hip-hop" → ["rap", "hip-hop", "hip hop", "MC", "rhymes"]
- "outsider" → ["outsider", "lo-fi", "raw", "DIY", "underground", "weird", "eccentric"]
- "sad" → ["sad", "melancholy", "heartbreak", "lonely", "grief"]
- "chill" → ["chill", "mellow", "relaxed", "laid back", "ambient"]
- "80s" → ["80s", "1980s", "synth", "new wave", "post-punk"]
- artist names and song titles → return them as-is

User request: "${userMessage}"

Return format: ["keyword1", "keyword2", "keyword3"]
Return ONLY the JSON array, nothing else.`
      }
    ]
  });

  try {
    const keywords = JSON.parse(response.content[0].text);
    return keywords.map(k => k.toLowerCase());
  } catch (e) {
    console.error('Failed to parse keywords:', e);
    return [];
  }
}

// Helper: Score songs based on keyword matches
function scoreSongs(songs, keywords) {
  return songs.map(song => {
    let score = 0;
    const tags = Array.isArray(song.tags) ? song.tags.join(' ') : song.tags;
    const searchText = `${song.title} ${song.artist} ${song.genre} ${song.mood} ${song.year} ${tags}`.toLowerCase();
    keywords.forEach(keyword => {
      // Use word boundary matching so "rap" doesn't match "rape", "trap", etc.
      const wordBoundary = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wordBoundary.test(searchText)) {
        score++;
      }
    });

    return { ...song, score };
  });
}

// Helper: Generate a response only when no song is found
async function generateNoMatchResponse(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 150,
    messages: [
      {
        role: 'user',
content: `You're a personal music curator. You don't have a match for this request in your collection. Respond in one short sentence saying you don't have anything like that. Do not mention catalogs, databases, or any technical limitations. Do not suggest other services. Keep it simple and human.

User asked: "${userMessage}"

IMPORTANT: Plain text only, no markdown.`
      }
    ]
  });

  return response.content[0].text;
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;

    // Input length guard
    if (!message || message.trim().length === 0) {
      return res.json({ response: "Say something and I'll find you a song.", song: null });
    }
    if (message.length > 500) {
      return res.json({ response: "Keep it short — I just need a vibe, not an essay.", song: null });
    }

    const session = getSession(sessionId);

    // Check if all songs exhausted
    if (session.playedSongs.length >= songsData.songs.length) {
      return res.json({
        response: "That's the whole collection. Nothing left I haven't played you.",
        song: null
      });
    }

    // Step 1: Extract keywords from user message
    const keywords = await extractKeywords(message);
    console.log('Extracted keywords:', keywords);

    // Detect generic "give me anything" requests
    const genericRequestPattern = /\b(another|random|something|anything|surprise|different|else)\b/i;
    const isGenericRequest = genericRequestPattern.test(message) || keywords.length === 0;

    // Check if user is asking for a specific song by title
    const specificSongRequest = songsData.songs.find(song => 
      keywords.some(k => song.title.toLowerCase().includes(k) || k.includes(song.title.toLowerCase()))
    );

    if (specificSongRequest) {
      if (session.playedSongs.includes(specificSongRequest.title)) {
        // Don't dead-end — fall through to normal matching below
        // (just skip the specific song logic and let scoring handle it)
      } else {
        session.playedSongs.push(specificSongRequest.title);
        return res.json({
          response: specificSongRequest.commentary,
          song: {
            title: specificSongRequest.title,
            artist: specificSongRequest.artist,
            spotify_url: specificSongRequest.spotify_url,
            tag_title: specificSongRequest.tag_title || "",
            tag_url: specificSongRequest.tag_url || ""
          }
        });
      }
    }

    // Score all songs in full collection
    const allSongsScored = scoreSongs(songsData.songs, keywords);
    const fullCollectionMatches = allSongsScored.filter(s => s.score > 1);

    // Filter to available (unplayed) songs only
    const availableSongs = songsData.songs.filter(s => !session.playedSongs.includes(s.title));
    const availableSongsScored = scoreSongs(availableSongs, keywords);
    const availableMatches = availableSongsScored.filter(s => s.score > 1);

    // Handle generic requests — pick a random available song
    if (isGenericRequest) {
      if (availableSongs.length === 0) {
        return res.json({
          response: "I've shared my entire collection with you! That's all the music I have for now.",
          song: null
        });
      }
      
      const randomSong = availableSongs[Math.floor(Math.random() * availableSongs.length)];
      session.playedSongs.push(randomSong.title);
      
      return res.json({
        response: randomSong.commentary,
        song: {
          title: randomSong.title,
          artist: randomSong.artist,
          spotify_url: randomSong.spotify_url,
          tag_title: randomSong.tag_title || "",
          tag_url: randomSong.tag_url || ""
        }
      });
    }

    // No matches at all in the full collection
    if (fullCollectionMatches.length === 0) {
      const noMatchResponse = await generateNoMatchResponse(message);
      return res.json({
        response: noMatchResponse,
        song: null
      });
    }

    // Had matches but all already played
    if (availableMatches.length === 0 && fullCollectionMatches.length > 0) {
      return res.json({
        response: "Already played everything that fits that. Try a different angle?",
        song: null
      });
    }

    // Pick random song from top matches
    const topScore = Math.max(...availableMatches.map(s => s.score));
    const topMatches = availableMatches.filter(s => s.score === topScore);
    const selectedSong = topMatches[Math.floor(Math.random() * topMatches.length)];

    session.playedSongs.push(selectedSong.title);

    res.json({
      response: selectedSong.commentary,
      song: {
        title: selectedSong.title,
        artist: selectedSong.artist,
        spotify_url: selectedSong.spotify_url,
        tag_title: selectedSong.tag_title || "",
        tag_url: selectedSong.tag_url || ""
      }
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: 'Something went wrong',
      details: error.message 
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
