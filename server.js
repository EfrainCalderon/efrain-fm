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
    sessions.set(sessionId, { playedSongs: [], lastSongTags: null, lastSongArtist: null });
  }
  return sessions.get(sessionId);
}

// Helper: Check if user is asking for more of the same thing
function isMoreRequest(message) {
  return /\b(more|yes|another|again|keep going|similar|same vibe|like that|more please|more of that|yes more|love it|love this|keep it|that kind)\b/i.test(message);
}

// Helper: Find songs by artist name — exact match on artist field, case-insensitive
function findSongsByArtist(message) {
  const msgLower = message.toLowerCase();
  // Build a list of all unique artists, sort longest first to match "The Velvet Underground" before "Velvet"
  const artists = [...new Set(songsData.songs.map(s => s.artist))];
  artists.sort((a, b) => b.length - a.length);

  for (const artist of artists) {
    if (msgLower.includes(artist.toLowerCase())) {
      return songsData.songs.filter(s => s.artist.toLowerCase() === artist.toLowerCase());
    }
  }
  return null;
}

// Helper: Extract keywords from user message using Claude (small, cheap call)
async function extractKeywords(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `Extract music-related search keywords from this request. Return ONLY a JSON array of keywords.

Be semantic — expand to related terms, but stay specific and accurate:
- "rap" or "hip-hop" → ["rap", "hip-hop", "hip hop", "MC"]
- "outsider" or "outsider music" → ["outsider", "lo-fi", "primitive", "raw", "weird", "eccentric", "homemade", "diy"]
- "sad" → ["sad", "melancholy", "heartbreak", "lonely", "grief"]
- "chill" or "mellow" → ["chill", "mellow", "relaxed", "ambient", "downtempo"]
- "brazil" or "brazilian" → ["brazil", "brazilian", "bossa nova", "samba", "mpb", "tropicalia", "latin"]
- "80s" → ["80s", "1980s", "synth", "new wave", "post-punk"]
- "electronic" → ["electronic", "synth", "electro", "techno", "dance"]
- artist names and song titles → return them as-is
- ALWAYS include the literal words from the user's message in addition to any expansions
- Do not sanitize or omit words for any reason, even if they seem crude or sensitive

IMPORTANT: Do NOT expand "outsider" to "alternative", "indie", or "underground" — those are different genres.
Do NOT use vague terms like "classic", "good", or "popular".

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
      // Word boundary matching so "rap" doesn't match "rape", etc.
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'i');
      if (re.test(searchText)) {
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
        response: "That's the whole collection — nothing left I haven't played you.",
        song: null
      });
    }

    // Step 0a: Check if user is asking for more of the same thing
    if (isMoreRequest(message) && session.lastSongTags) {
      const availableSongs = songsData.songs.filter(s => !session.playedSongs.includes(s.title));
      // Score available songs against last song's tags
      const scored = scoreSongs(availableSongs, session.lastSongTags).filter(s => s.score > 0);
      // Exclude same artist if we have enough options
      const differentArtist = scored.filter(s => s.artist !== session.lastSongArtist);
      const pool = differentArtist.length > 0 ? differentArtist : scored;

      if (pool.length > 0) {
        const topScore = Math.max(...pool.map(s => s.score));
        const topMatches = pool.filter(s => s.score === topScore);
        const selectedSong = topMatches[Math.floor(Math.random() * topMatches.length)];
        session.playedSongs.push(selectedSong.title);
        session.lastSongTags = Array.isArray(selectedSong.tags) ? selectedSong.tags : selectedSong.tags.split(',').map(t => t.trim());
        session.lastSongArtist = selectedSong.artist;
        return res.json({
          response: selectedSong.commentary,
          song: {
            title: selectedSong.title,
            artist: selectedSong.artist,
            spotify_url: selectedSong.spotify_url,
            tag_title: selectedSong.tag_title || "",
            tag_url: selectedSong.tag_url || ""
          }
        });
      }
      // Fall through to normal flow if no similar songs left
    }

    // Step 0b: Check if user mentioned an artist name directly
    const artistSongs = findSongsByArtist(message);
    if (artistSongs) {
      const available = artistSongs.filter(s => !session.playedSongs.includes(s.title));
      if (available.length === 0) {
        const artistName = artistSongs[0].artist;
        return res.json({
          response: `I've already played everything I have from ${artistName}. Want to try something else?`,
          song: null
        });
      }
      const selectedSong = available[Math.floor(Math.random() * available.length)];
      session.playedSongs.push(selectedSong.title);
      session.lastSongTags = Array.isArray(selectedSong.tags) ? selectedSong.tags : selectedSong.tags.split(',').map(t => t.trim());
      session.lastSongArtist = selectedSong.artist;
      return res.json({
        response: selectedSong.commentary,
        song: {
          title: selectedSong.title,
          artist: selectedSong.artist,
          spotify_url: selectedSong.spotify_url,
          tag_title: selectedSong.tag_title || "",
          tag_url: selectedSong.tag_url || ""
        }
      });
    }

    // Step 1: Extract keywords from user message
    const keywords = await extractKeywords(message);
    console.log('Extracted keywords:', keywords);

    // Detect generic "give me anything" requests
    const genericRequestPattern = /\b(another|random|something|anything|surprise|different|else)\b/i;
    const isGenericRequest = genericRequestPattern.test(message) || keywords.length === 0;

    // Check if user is asking for a specific song by title (exact match only)
    const specificSongRequest = songsData.songs.find(song => 
      keywords.some(k => song.title.toLowerCase() === k)
    );

    if (specificSongRequest) {
      if (session.playedSongs.includes(specificSongRequest.title)) {
        return res.json({
          response: `I already shared ${specificSongRequest.title} with you earlier in our conversation! Want to explore something else?`,
          song: null
        });
      }
      
      session.playedSongs.push(specificSongRequest.title);
      session.lastSongTags = Array.isArray(specificSongRequest.tags) ? specificSongRequest.tags : specificSongRequest.tags.split(',').map(t => t.trim());
      session.lastSongArtist = specificSongRequest.artist;
      
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
      session.lastSongTags = Array.isArray(randomSong.tags) ? randomSong.tags : randomSong.tags.split(',').map(t => t.trim());
      session.lastSongArtist = randomSong.artist;
      
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
    session.lastSongTags = Array.isArray(selectedSong.tags) ? selectedSong.tags : selectedSong.tags.split(',').map(t => t.trim());
    session.lastSongArtist = selectedSong.artist;

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
