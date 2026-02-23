require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { response: "You're moving fast! Take a breath and try again in a minute.", song: null },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/chat', limiter);

const songsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));
const favoritesPath = path.join(__dirname, 'data', 'favorites.json');

const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      playedSongs: [], lastSongTags: null, lastSongArtist: null, lastSong: null,
      songCount: 0, askedFavorite: false, askedMoreOf: false, lastInterruptSong: 0,
      _pendingRelatedSong: null,
    });
  }
  return sessions.get(sessionId);
}

function normalize(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function isMoreRequest(msg) {
  return /\b(more|yes|another|again|keep going|similar|same vibe|like that|more please|more of that|yes more|love it|love this|keep it|that kind)\b/i.test(msg);
}

function isVideoRequest(msg) {
  return /\b(video|music video|youtube|visual|watch|clip)\b/i.test(msg);
}

// Common words too generic to use as partial artist name signals
const ARTIST_STOPWORDS = new Set([
  'music', 'band', 'sound', 'sounds', 'noise', 'group', 'club', 'party',
  'world', 'street', 'city', 'house', 'rock', 'pop', 'jazz', 'soul',
  'boys', 'girls', 'kids', 'men', 'women', 'people', 'gang', 'crew',
  'new', 'old', 'young', 'good', 'real', 'true', 'pure', 'wild',
  'black', 'white', 'red', 'blue', 'gold', 'silver',
  'tapes', 'records', 'collective', 'project', 'unit',
]);

function findSongsByArtist(message) {
  const msgNorm = normalize(message);
  const words = msgNorm.split(/\s+/);
  const artists = [...new Set(songsData.songs.map(s => s.artist))];
  artists.sort((a, b) => b.length - a.length);
  for (const artist of artists) {
    const artistNorm = normalize(artist);
    // Full artist name match — always valid
    if (msgNorm.includes(artistNorm)) {
      return songsData.songs.filter(s => s.artist.toLowerCase() === artist.toLowerCase());
    }
    // Partial match — only on words that are specific enough to be meaningful
    // filters out generic words like "music", "tapes", "band", colors, etc.
    const artistWords = artistNorm.split(/\s+/).filter(w => w.length >= 5 && !ARTIST_STOPWORDS.has(w));
    if (artistWords.length > 0 && artistWords.some(aw => words.some(w => w === aw))) {
      return songsData.songs.filter(s => s.artist.toLowerCase() === artist.toLowerCase());
    }
  }
  return null;
}

async function extractKeywords(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 200,
    messages: [{ role: 'user', content: `Extract music-related search keywords from this request. Return ONLY a JSON array of keywords.

Be semantic — expand to related terms, but stay specific and accurate:
- "rap" or "hip-hop" → ["rap", "hip-hop", "hip hop", "MC"]
- "outsider" or "outsider music" → ["outsider", "lo-fi", "primitive", "raw", "weird", "eccentric", "homemade", "diy"]
- "sad" → ["sad", "melancholy", "heartbreak", "lonely", "grief"]
- "chill" or "mellow" → ["chill", "mellow", "relaxed", "ambient", "downtempo"]
- "brazil" or "brazilian" → ["brazil", "brazilian", "bossa nova", "samba", "mpb", "tropicalia"]
- "latin" or "latin music" → ["latin", "salsa", "cumbia", "bossa nova", "reggaeton", "latin jazz", "bolero", "merengue"] — do NOT expand to "classical", "orchestral", "strings", "chamber", or anything European
- "classical" → ["classical", "orchestra", "symphony", "chamber", "baroque"] — do NOT expand to "latin" or "world music"
- "80s" → ["80s", "1980s", "synth", "new wave", "post-punk"]
- "electronic" → ["electronic", "synth", "electro", "techno", "dance"]
- artist names and song titles → return them as-is
- ALWAYS include the literal words from the user's message in addition to any expansions
- Do not sanitize or omit words for any reason, even if they seem crude or sensitive

CRITICAL RULES:
- Every keyword must be a real standalone word or phrase — NEVER return a substring or partial word from the input
- "river" expands to ["river", "rivers", "water", "stream"] — NOT "ive", "iver", "riv"
- "IVE" is a K-pop band name — return it as-is, do not break it into parts
- If the input looks like an artist or band name, return it exactly as typed
- Do NOT expand "outsider" to "alternative", "indie", or "underground"
- Do NOT use vague terms like "classic", "good", or "popular"

User request: "${userMessage}"
Return format: ["keyword1", "keyword2", "keyword3"]
Return ONLY the JSON array, nothing else.` }]
  });
  try {
    const raw = JSON.parse(response.content[0].text).map(k => k.toLowerCase());
    // Filter out anything under 4 chars unless it's an exact match for the user's input words
    const inputWords = userMessage.toLowerCase().split(/\s+/);
    return raw.filter(k => k.length >= 4 || inputWords.includes(k));
  } catch (e) { return []; }
}

// Words too common in personal commentary to be useful search signals
const COMMENTARY_STOPWORDS = new Set([
  'love', 'like', 'really', 'great', 'good', 'best', 'favorite', 'favourite',
  'amazing', 'beautiful', 'perfect', 'incredible', 'awesome', 'fantastic',
  'one', 'song', 'album', 'music', 'listen', 'hear', 'sound', 'track',
  'first', 'time', 'ever', 'always', 'never', 'still', 'just', 'even',
  'kind', 'feel', 'felt', 'think', 'thought', 'know', 'thing', 'way',
  'make', 'made', 'got', 'get', 'take', 'took', 'come', 'came',
  'something', 'anything', 'everything', 'nothing', 'someone',
  'year', 'years', 'day', 'days', 'life', 'world', 'back', 'little',
]);

function scoreSongs(songs, keywords, preferVideo = false) {
  return songs.map(song => {
    let score = 0;
    const tags = Array.isArray(song.tags) ? song.tags.join(' ') : (song.tags || '');
    // Structured fields — all keywords match here
    const structuredText = normalize(`${song.title} ${song.artist} ${song.genre} ${song.mood} ${song.year} ${tags}`);
    // Commentary — only non-stopwords match here
    const commentaryText = normalize(song.commentary || '');

    keywords.forEach(keyword => {
      const normKw = normalize(keyword);
      const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'i');
      if (re.test(structuredText)) {
        score++;
      } else if (!COMMENTARY_STOPWORDS.has(normKw) && re.test(commentaryText)) {
        score++;
      }
    });

    const isYT = song.spotify_url && (song.spotify_url.includes('youtube.com') || song.spotify_url.includes('youtu.be'));
    if (preferVideo && isYT) score += 5;
    return { ...song, score };
  });
}

const EFRAIN_CHARACTER = `You are Efrain — a product designer based in New Jersey. You built efrain.fm as a personal music discovery project and portfolio piece. You're not typing live; you've pre-shared real stories and experiences that visitors can explore.

Background: You made music in your teens and 20s. You spent 8 years in health tech at NYC-area startups before pivoting into product design. Your design portfolio is at www.efrain.design. You love talking about music, sharing stories, and recommending songs to people.

Personality: Warm, direct, a little dry. Deep music knowledge spanning outsider, lo-fi, experimental, jazz, proto-punk, international sounds. Never pretentious. You don't name-drop to impress — you share because you genuinely love it.

Keep responses SHORT — 2-3 sentences max. You're a curator, not a chatbot. If someone asks something music-adjacent, steer back toward asking them what they want to hear. Plain text only, no markdown.`;

async function generateConversationalResponse(userMessage, lastSong) {
  const songContext = lastSong ? `The last song you shared was "${lastSong.title}" by ${lastSong.artist}.` : '';
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 120,
    system: EFRAIN_CHARACTER,
    messages: [{ role: 'user', content: `${userMessage}${songContext ? '\n\n' + songContext : ''}` }]
  });
  return r.content[0].text;
}

async function generateNoMatchResponse(userMessage) {
  const quick = [
    [/\bpolka\b/i, "No polka in here, sorry."],
    [/\bbluegrass\b/i, "Nothing with a banjo unfortunately."],
    [/\bchristmas|holiday\b/i, "No holiday music in this collection."],
    [/\bclassical|orchestra|symphony\b/i, "Not much classical in here — mostly contemporary stuff."],
    [/\bnursery|children'?s|kids music\b/i, "Nothing for kids in here."],
    [/\bkaraoke\b/i, "This isn't a karaoke spot."],
    [/\bnational\s*anthem\b/i, "Nope."],
  ];
  for (const [re, reply] of quick) {
    if (re.test(userMessage)) return reply;
  }
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 80,
    system: EFRAIN_CHARACTER,
    messages: [{ role: 'user', content: `No match for: "${userMessage}". One short sentence. Don't say "I'd love to help" or reference your collection. Just be direct.` }]
  });
  return r.content[0].text;
}

function findRelatedSong(lastSong, playedTitles) {
  if (!lastSong) return null;
  const lastTags = Array.isArray(lastSong.tags) ? lastSong.tags.map(t => normalize(t)) : (lastSong.tags || '').split(',').map(t => normalize(t.trim()));
  let best = null, bestOverlap = 0;
  for (const song of songsData.songs) {
    if (playedTitles.includes(song.title) || song.artist === lastSong.artist) continue;
    const sTags = Array.isArray(song.tags) ? song.tags.map(t => normalize(t)) : (song.tags || '').split(',').map(t => normalize(t.trim()));
    const overlap = lastTags.filter(t => sTags.includes(t)).length;
    if (overlap >= 3 && overlap > bestOverlap) { bestOverlap = overlap; best = song; }
  }
  return best;
}

// Core genres/moods we have solid representation for in the collection
const COLLECTION_GENRES = [
  'jazz', 'electronic', 'folk', 'punk', 'soul', 'hip-hop', 'ambient',
  'funk', 'country', 'reggae', 'classical', 'experimental', 'r&b',
  'latin', 'afrobeat', 'blues', 'pop', 'noise', 'indie', 'dance',
];

// Pick 3 genres that contrast with the current song's tags
function getDynamicOptions(justPlayedSong, playedTitles = []) {
  const songTags = Array.isArray(justPlayedSong.tags)
    ? justPlayedSong.tags.map(t => normalize(t))
    : (justPlayedSong.tags || '').toLowerCase().split(/[,\s]+/);
  const songGenre = normalize(justPlayedSong.genre || '');

  const contrasting = COLLECTION_GENRES.filter(g => {
    // Skip if current song already matches this genre
    if (songTags.some(t => t === g || t.includes(g)) || songGenre.includes(g)) return false;

    // Count unplayed songs that genuinely match this genre via word boundary
    const re = new RegExp('\\b' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const matchCount = songsData.songs.filter(s => {
      if (playedTitles.includes(s.title)) return false;
      // Only match against structured fields — not commentary
      const structured = normalize(`${s.genre || ''} ${Array.isArray(s.tags) ? s.tags.join(' ') : (s.tags || '')} ${s.mood || ''}`);
      return re.test(structured);
    }).length;

    // Require at least 2 real matches so it's not a one-off fluke
    return matchCount >= 2;
  });

  const shuffled = contrasting.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).map(g => g.charAt(0).toUpperCase() + g.slice(1));
}

function decideInterrupt(session, justPlayedSong) {
  const count = session.songCount; // already incremented
  const sinceLastInterrupt = count - session.lastInterruptSong;
  if (sinceLastInterrupt < 3) return null;

  // Song 6: ask favorite
  if (count === 6 && !session.askedFavorite) {
    session.askedFavorite = true;
    session.lastInterruptSong = count;
    return { type: 'favorite_prompt', message: "I've been doing a lot of recommending — do you have any song recommendations for me?", options: ['Yes', 'No'] };
  }

  // Opportunistic related song (song 5+, every 4 songs)
  if (count >= 5 && sinceLastInterrupt >= 4) {
    const related = findRelatedSong(justPlayedSong, session.playedSongs);
    if (related) {
      session.lastInterruptSong = count;
      session._pendingRelatedSong = related.title;
      return { type: 'related', message: "This makes me think of something else. Want to hear it?", options: ['Tell me more', 'Not right now'] };
    }
  }

  // Every 4th song starting at 9: pivot offer with dynamic genre options
  if (count >= 9 && (count - 9) % 4 === 0 && sinceLastInterrupt >= 4) {
    session.lastInterruptSong = count;
    const options = getDynamicOptions(justPlayedSong, session.playedSongs);
    if (options.length < 2) return null; // not enough contrast, skip
    return { type: 'vibe_check', message: "Want to go somewhere different?", options };
  }

  // Song 12+: genre pivot with dynamic options
  if (count >= 12 && !session.askedMoreOf && sinceLastInterrupt >= 4) {
    session.askedMoreOf = true;
    session.lastInterruptSong = count;
    const options = getDynamicOptions(justPlayedSong, session.playedSongs);
    if (options.length < 2) return null;
    return { type: 'more_of', message: "What else are you in the mood for?", options };
  }

  return null;
}

function saveFavorite(songTitle, artist) {
  let favorites = [];
  try { if (fs.existsSync(favoritesPath)) favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf8')); } catch (e) {}
  favorites.push({ songTitle, artist, timestamp: new Date().toISOString() });
  fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
}

function findFavoriteInCollection(input) {
  const norm = normalize(input);
  const byArtist = songsData.songs.find(s => normalize(s.artist).includes(norm) || norm.includes(normalize(s.artist)));
  if (byArtist) return { match: byArtist, matchType: 'artist' };
  const byTitle = songsData.songs.find(s => normalize(s.title).includes(norm) || norm.includes(normalize(s.title)));
  if (byTitle) return { match: byTitle, matchType: 'title' };
  return null;
}

async function generateFavoriteResponse(userInput, collectionMatch) {
  let matchContext;
  if (collectionMatch && collectionMatch.alreadyPlayed) {
    matchContext = `You already shared "${collectionMatch.match.title}" by ${collectionMatch.match.artist} with them earlier in this conversation. You know this. Respond warmly — like "oh yeah, I already threw that on for you!" or similar. Do NOT offer to play it again. Do NOT act like you haven't played it.`;
  } else if (collectionMatch) {
    matchContext = `You have "${collectionMatch.match.title}" by ${collectionMatch.match.artist} in your collection and it's playing for them right now. Acknowledge their taste with something warm and genuine about the song. Do NOT say you'll play it, throw it on, put it on, or offer to do anything — it is already playing. Just react to their taste.`;
  } else {
    matchContext = `You don't have that in your collection. Say "I'll check that out" or similar — warm, brief, one sentence.`;
  }

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 100,
    system: EFRAIN_CHARACTER,
    messages: [{ role: 'user', content: `Visitor's favorite: "${userInput}"\n${matchContext}\n\n1-2 sentences MAX. React like a person, not a critic.` }]
  });
  return r.content[0].text;
}

function isAffirmation(msg) {
  const t = msg.trim();
  if (/^(wow|damn|whoa|yes!?|yep|yeah|haha|lol|ha|nice|great|dope|sick|banger|bop|slaps|perfect|incredible|wild|crazy|hell yeah|no way|omg|oh wow|oh nice|love it|love this|loved it|so good|good one|that's?\s*(great|awesome|amazing|cool|nice|sick|dope|perfect|wild|crazy|so good|a banger))[\s!.]*$/i.test(t)) return true;
  if (/^(nice\s+i\s+(like|love)\s+(it|this)|i\s+(like|love)\s+(it|this(\s+one)?)|this\s+is\s+(great|amazing|awesome|cool|so\s+good|perfect|a\s+great\s+song)|that\s+(was|is)\s+(great|amazing|awesome|cool|so\s+good|perfect)|i\s+agree(\s+they\s+rule)?|they\s+rule|really\s+good|really\s+like\s+(it|this)|loved\s+(it|this|that))[\s!.]*$/i.test(t)) return true;
  return false;
}

function isNegativeReaction(msg) {
  const t = msg.trim();
  return /^(hated?\s+(it|this|that)|not\s+(for\s+me|my\s+thing|feeling\s+it|great|good)|this\s+isn'?t\s+(for\s+me|my\s+thing|great|good)|don'?t\s+(like|love)\s+(it|this|that)|not\s+into\s+(it|this)|meh|nah|nope|skip\s+(it|this)?|pass)[\s!.]*$/i.test(t);
}

function isOffScript(msg) {
  return /\b(who\s+(are|is)\s+(you|efrain)|what\s+(are|is)\s+(you|this|efrain\.?fm|this\s+site|this\s+place)|tell\s+me\s+about\s+(yourself|you|efrain)|are\s+you\s+(a\s+)?(real|bot|ai|human|person|robot)|do\s+you\s+(have|make|play|listen)|what\s+do\s+you\s+do|where\s+are\s+you\s+from|what'?s\s+your\s+(deal|story|background)|how\s+(does\s+this\s+work|did\s+you|old\s+are)|did\s+you\s+(make|build|create)\s+this|is\s+this\s+your|what\s+kind\s+of\s+music\s+do\s+you|do\s+you\s+like\s+music|what'?s\s+efrain|why\s+did\s+you|what\s+inspired)\b/i.test(msg);
}

function isConversational(msg) {
  // Detect messages that are chatty/contextual rather than direct music requests
  return /\b(just listened|listened to that|already heard|heard that|love that|loved that|nice|great|good one|that was|anything else|what else|keep going|what about|how about)\b/i.test(msg);
}

function buildSongResponse(song, session, interrupt = null, bridge = null) {
  session.playedSongs.push(song.title);
  session.lastSong = song;
  session.lastSongTags = Array.isArray(song.tags) ? song.tags : (song.tags || '').split(',').map(t => t.trim());
  session.lastSongArtist = song.artist;
  session.songCount++;
  const int = interrupt || decideInterrupt(session, song);
  return {
    response: song.commentary,
    bridgingResponse: bridge,
    song: { title: song.title, artist: song.artist, spotify_url: song.spotify_url, tag_title: song.tag_title || '', tag_url: song.tag_url || '' },
    interrupt: int,
  };
}

// =====================
// FAVORITE ENDPOINT
// =====================
app.post('/api/favorite', async (req, res) => {
  try {
    const { input, sessionId = 'default' } = req.body;
    if (!input || !input.trim()) return res.json({ response: "Tell me something and I'll see what I've got.", song: null });
    const session = getSession(sessionId);
    const byMatch = input.match(/^(.+?)\s+by\s+(.+)$/i);
    const songTitle = byMatch ? byMatch[1].trim() : null;
    const artistName = byMatch ? byMatch[2].trim() : input.trim();
    saveFavorite(songTitle || input, artistName);
    const collectionMatch = findFavoriteInCollection(input);

    // Already played — acknowledge warmly without re-sending the embed
    if (collectionMatch && session.playedSongs.includes(collectionMatch.match.title)) {
      const alreadyPlayedContext = `You already shared "${collectionMatch.match.title}" by ${collectionMatch.match.artist} with them earlier in this conversation. Acknowledge warmly — something like "oh yeah, I already shared that one with you!" Make them feel seen without replaying it.`;
      const responseText = await generateFavoriteResponse(input, { match: collectionMatch.match, alreadyPlayed: true, context: alreadyPlayedContext });
      return res.json({ response: responseText, song: null });
    }

    const responseText = await generateFavoriteResponse(input, collectionMatch);
    let song = null;
    if (collectionMatch && !session.playedSongs.includes(collectionMatch.match.title)) {
      const s = collectionMatch.match;
      session.playedSongs.push(s.title);
      session.lastSong = s;
      session.lastSongTags = Array.isArray(s.tags) ? s.tags : (s.tags || '').split(',').map(t => t.trim());
      session.lastSongArtist = s.artist;
      session.songCount++;
      song = { title: s.title, artist: s.artist, spotify_url: s.spotify_url, tag_title: s.tag_title || '', tag_url: s.tag_url || '' };
    }
    res.json({ response: responseText, song });
  } catch (e) {
    console.error('Favorite error:', e);
    res.status(500).json({ response: "Something went wrong.", song: null });
  }
});

// =====================
// CHAT ENDPOINT
// =====================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;
    if (!message || !message.trim()) return res.json({ response: "Say something and I'll find you a song.", song: null });
    if (message.length > 500) return res.json({ response: "Keep it short — I just need a vibe, not an essay.", song: null });

    const session = getSession(sessionId);
    if (session.playedSongs.length >= songsData.songs.length) {
      return res.json({ response: "That's the whole collection — nothing left I haven't played you.", song: null });
    }

    const msgLower = message.toLowerCase().trim();

    // "Efrain/your favorite" — redirect gracefully
    if (/\b(your|efrain'?s?)\s+(favorite|favourite|fave|best|top|pick|picks)\b/i.test(message)) {
      const redirects = [
        "Honestly, they're all favorites in different ways — is there a genre, mood, or era you want to explore?",
        "That's a trap, I can't pick just one. What are you feeling right now?",
        "Hard to say. Give me a vibe and I'll find you something good.",
        "Too many to count. What kind of mood are you in?",
      ];
      return res.json({ response: redirects[Math.floor(Math.random() * redirects.length)], song: null });
    }

    // Negative reactions — acknowledge and pivot
    if (isNegativeReaction(message)) {
      if (session.lastSong) {
        const s = session.lastSong;
        const replies = [
          `Fair enough — ${s.artist} isn't for everyone. What are you in the mood for instead?`,
          `No worries. What direction do you want to go?`,
          `Got it. What would hit better right now?`,
        ];
        return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
      }
      return res.json({ response: "No worries. What are you in the mood for?", song: null });
    }

    // Affirmations — reference the last song
    if (isAffirmation(message)) {
      if (session.lastSong) {
        const s = session.lastSong;
        const replies = [
          `Yeah, ${s.title} is a good one. What are you in the mood for next?`,
          `Right? ${s.artist} doesn't miss. What do you want to hear next?`,
          `Glad that one landed. What else are you feeling?`,
          `${s.title} holds up every time. What are you feeling next?`,
        ];
        return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
      }
      const replies = [
        "Right? Keep going — what else are you in the mood for?",
        "Good stuff. What do you want to hear next?",
        "Yeah. What else can I find you?",
        "Glad it landed. What are you feeling next?",
      ];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    // Off-script conversational messages — route to character fallback
    if (isOffScript(message)) {
      const reply = await generateConversationalResponse(message, session.lastSong);
      return res.json({ response: reply, song: null });
    }

    // ---- Button choice handlers ----
    const pickFromPool = (pool) => {
      if (!pool.length) return null;
      const top = Math.max(...pool.map(s => s.score || 0));
      const picks = pool.filter(s => (s.score || 0) === top);
      return picks[Math.floor(Math.random() * picks.length)];
    };

    const available = () => songsData.songs.filter(s => !session.playedSongs.includes(s.title));

    if (msgLower === 'keep this vibe' && session.lastSongTags) {
      const scored = scoreSongs(available(), session.lastSongTags).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      const song = pickFromPool(diff.length ? diff : scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    // Dynamic genre buttons (e.g. "Jazz", "Electronic") fall through to keyword search below

    if (msgLower === 'tell me more' && session._pendingRelatedSong) {
      const related = songsData.songs.find(s => s.title === session._pendingRelatedSong);
      session._pendingRelatedSong = null;
      if (related && !session.playedSongs.includes(related.title)) return res.json(buildSongResponse(related, session));
    }

    if (msgLower === 'not right now') {
      session._pendingRelatedSong = null;
      return res.json({ response: "No problem — keep asking.", song: null });
    }

    if (msgLower === 'yes') {
      return res.json({ response: null, song: null, interrupt: { type: 'favorite', message: "What's the song or artist?", freeText: true } });
    }

    if (msgLower === 'no' || msgLower === "i don't" || msgLower === 'not sure' || msgLower === 'idk') {
      const replies = [
        "No worries — what do you want to hear next?",
        "All good. What are you in the mood for?",
        "That's fine. Keep asking.",
      ];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    if (msgLower === 'more of that energy' && session.lastSongTags) {
      const scored = scoreSongs(available(), session.lastSongTags).filter(s => s.score > 0);
      const song = pickFromPool(scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    if (msgLower === 'something slower') {
      const scored = scoreSongs(available(), ['slow', 'mellow', 'gentle', 'quiet', 'ballad', 'acoustic', 'soft', 'folk', 'intimate', 'sparse', 'minimal', 'tender']).filter(s => s.score > 0);
      if (scored.length) return res.json(buildSongResponse(scored[Math.floor(Math.random() * scored.length)], session));
    }

    if (msgLower === 'something weirder') {
      const scored = scoreSongs(available(), ['outsider', 'weird', 'experimental', 'strange', 'lo-fi', 'eccentric', 'raw']).filter(s => s.score > 0);
      if (scored.length) return res.json(buildSongResponse(scored[Math.floor(Math.random() * scored.length)], session));
    }

    // ---- Normal flow ----
    if (isMoreRequest(message) && session.lastSongTags) {
      const scored = scoreSongs(available(), session.lastSongTags).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      const song = pickFromPool(diff.length ? diff : scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    const artistSongs = findSongsByArtist(message);
    if (artistSongs) {
      const av = artistSongs.filter(s => !session.playedSongs.includes(s.title));
      if (av.length) {
        return res.json(buildSongResponse(av[Math.floor(Math.random() * av.length)], session));
      }
      // All played — fall through to keyword search
    }

    const keywords = await extractKeywords(message);
    console.log('Keywords:', keywords);

    const preferVideo = isVideoRequest(message);
    const conversational = isConversational(message);
    const bridge = conversational ? "Okay, let me find something else." : null;
    const isGeneric = /\b(another|random|something|anything|surprise|different|else)\b/i.test(message) || keywords.length === 0;

    const TITLE_MATCH_STOPWORDS = new Set([
      'song', 'music', 'track', 'tune', 'play', 'hear', 'listen',
      'like', 'love', 'good', 'great', 'nice', 'best', 'cool', 'bad',
      'new', 'old', 'another', 'more', 'that', 'this', 'some', 'any',
      'just', 'want', 'need', 'give', 'find', 'know', 'feel',
      'pop', 'body', 'rock', 'soul', 'mind', 'life', 'time', 'day',
      'girl', 'girls', 'boy', 'boys', 'man', 'woman', 'baby', 'home',
      'fire', 'rain', 'sun', 'moon', 'star', 'night', 'dark', 'light',
      'ride', 'walk', 'run', 'come', 'gone', 'lost', 'back', 'down',
      'heart', 'eyes', 'hand', 'face', 'head', 'world', 'away',
      'favorite', 'favourite',
    ]);
    const titleMatchKeywords = keywords.filter(k => k.length >= 4 && !TITLE_MATCH_STOPWORDS.has(normalize(k)));
    let specificSong = null;
    if (titleMatchKeywords.length > 0) {
      specificSong = songsData.songs.find(s =>
        !session.playedSongs.includes(s.title) &&
        titleMatchKeywords.some(k => {
          const normTitle = normalize(s.title);
          const normK = normalize(k);
          if (normTitle === normK) return true;
          const escaped = normK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp('\\b' + escaped + '\\b').test(normTitle);
        })
      );
    }
    if (specificSong) {
      return res.json(buildSongResponse(specificSong, session));
    }

    const allScored = scoreSongs(songsData.songs, keywords, preferVideo);
    const fullMatches = allScored.filter(s => s.score > 1);
    const avSongs = available();
    const avScored = scoreSongs(avSongs, keywords, preferVideo);
    const avMatches = avScored.filter(s => s.score > 1);

    if (isGeneric) {
      if (!avSongs.length) return res.json({ response: "I've shared my entire collection with you! That's all I have for now.", song: null });
      return res.json(buildSongResponse(avSongs[Math.floor(Math.random() * avSongs.length)], session, null, bridge));
    }

    if (!fullMatches.length) {
      return res.json({ response: await generateNoMatchResponse(message), song: null });
    }

    if (!avMatches.length) {
      return res.json({ response: "Already played everything that fits that. Try a different angle?", song: null });
    }

    const top = Math.max(...avMatches.map(s => s.score));
    const topPicks = avMatches.filter(s => s.score === top);
    return res.json(buildSongResponse(topPicks[Math.floor(Math.random() * topPicks.length)], session, null, bridge));

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Something went wrong', details: error.message });
  }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
