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

// =====================
// DATA LOADING
// Normalize all tag fields to arrays at startup so we never branch on string vs array again.
// =====================
const bridgesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bridges.json'), 'utf8'));
const rawSongsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));
const songsData = {
  songs: rawSongsData.songs.map(song => ({
    ...song,
    // Always an array — split strings, dedupe, trim
    tags: Array.isArray(song.tags)
      ? song.tags.map(t => t.trim().toLowerCase()).filter(Boolean)
      : (song.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
  }))
};
const favoritesPath = path.join(__dirname, 'data', 'favorites.json');

const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      playedSongs: [], lastSongTags: null, lastSongArtist: null, lastSong: null,
      songCount: 0, askedFavorite: false, askedMoreOf: false, lastInterruptSong: 0,
      _pendingRelatedSong: null, _pendingBridge: null,
    });
  }
  return sessions.get(sessionId);
}

function normalize(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// =====================
// GENRE WORD LIST
// Words that should ONLY match genre/mood/tags — never artist names or song titles.
// This prevents "country" → Country Joe, "house" → Beach House, "rap" → Tractor Rape Chain.
// =====================
const GENRE_WORDS = new Set([
  // Core genres
  'jazz', 'electronic', 'folk', 'punk', 'soul', 'rap', 'hip-hop', 'hip hop',
  'ambient', 'funk', 'country', 'reggae', 'classical', 'experimental', 'r&b',
  'latin', 'afrobeat', 'blues', 'pop', 'noise', 'indie', 'dance', 'rock',
  'metal', 'gospel', 'disco', 'techno', 'house', 'grunge', 'ska', 'dub',
  'psychedelic', 'acoustic', 'outsider', 'lo-fi', 'americana',
  // Subgenres
  'new wave', 'post-punk', 'synth', 'electro', 'downtempo', 'trip-hop',
  'proto-punk', 'art rock', 'garage', 'shoegaze', 'post-rock', 'math rock',
  'krautrock', 'drone', 'abstract', 'avant-garde', 'country rock', 'alt-country',
  'honky-tonk', 'singer-songwriter', 'noise rock', 'noise pop', 'dream pop',
  'slowcore', 'emo', 'hardcore', 'thrash', 'death metal', 'black metal',
  'bossa nova', 'samba', 'tropicalia', 'cumbia', 'salsa', 'merengue',
  'east coast rap', 'west coast rap', 'southern rap', 'trap',
  // Moods — also genre-like in that they should hit mood/tag fields, not titles
  'mellow', 'chill', 'upbeat', 'energetic', 'melancholy', 'dreamy',
  'raw', 'smooth', 'sparse', 'minimal', 'intense', 'gentle', 'soft',
  'dark', 'atmospheric', 'haunting', 'brooding', 'romantic', 'tender',
  'heavy', 'loud', 'quiet', 'slow', 'fast', 'aggressive', 'peaceful',
]);

// =====================
// TAG HELPERS
// Tags often include the artist name (e.g. "velvet underground" tag on a VU song).
// These are useful for search-by-artist but pollute genre/mood scoring.
// getDescriptiveTags strips those out so they don't score when you're searching by mood/genre.
// =====================
function getDescriptiveTags(song) {
  const artistNorm = normalize(song.artist);
  const artistWords = new Set(artistNorm.split(/\s+/));
  return song.tags.filter(t => {
    const tNorm = normalize(t);
    // Exclude if it IS the artist name
    if (tNorm === artistNorm) return false;
    // Exclude if all its words are contained in the artist name
    const tagWords = tNorm.split(/\s+/);
    if (tagWords.length > 0 && tagWords.every(w => artistWords.has(w))) return false;
    return true;
  });
}

// =====================
// SCORING
//
// Tiered approach with three separate text fields:
//   Tier 1 (genre/mood/descriptive tags): 2pts for genre words, 1pt for others
//   Tier 2 (title): 1pt, blocked for genre words
//   Tier 3 (artist): 1pt, blocked for genre words
//
// Genre words are ONLY allowed to score in Tier 1.
// This means "country" only matches songs where country appears in genre/mood/tags —
// not in artist names or song titles.
// =====================
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
    const descriptiveTags = getDescriptiveTags(song);
    // Tier 1: genre, mood, and descriptive tags (not artist-name tags)
    const genreText = normalize(`${song.genre} ${song.mood} ${descriptiveTags.join(' ')}`);
    // Derive decade strings from year so "90s" and "1990s" match songs with year 1990-1999
    const year = parseInt(song.year);
    const decadeText = !isNaN(year)
      ? `${Math.floor(year / 10) * 10 % 100}s ${Math.floor(year / 10) * 10}s`
      : '';
    // Tier 2: title + year + decade
    const titleText = normalize(`${song.title} ${song.year || ''} ${decadeText}`);
    // Tier 3: artist only
    const artistText = normalize(song.artist);
    // Tier 4: commentary (non-stopwords only, never genre words)
    const commentaryText = normalize(song.commentary || '');

    let score = 0;
    keywords.forEach(keyword => {
      const normKw = normalize(keyword);
      const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'i');
      const isGenreWord = GENRE_WORDS.has(normKw);

      if (re.test(genreText)) {
        // Genre/mood/tags match — 2x for genre words so they outrank fuzzy matches
        score += isGenreWord ? 2 : 1;
      } else if (!isGenreWord && re.test(titleText)) {
        score += 1;
      } else if (!isGenreWord && re.test(artistText)) {
        score += 1;
      } else if (!isGenreWord && !COMMENTARY_STOPWORDS.has(normKw) && re.test(commentaryText)) {
        score += 1;
      }
    });

    const isYT = song.spotify_url && (song.spotify_url.includes('youtube.com') || song.spotify_url.includes('youtu.be'));
    if (preferVideo && isYT) score += 5;
    return { ...song, score };
  });
}

// =====================
// ARTIST LOOKUP
// Separated cleanly from genre scoring. Only runs when message looks like an artist name query.
// Genre words like "house", "country", "dance" are excluded from partial matching.
// =====================
function findSongsByArtist(message) {
  const msgNorm = normalize(message);
  const msgWords = new Set(msgNorm.split(/\s+/));
  const isMultiWord = msgWords.size >= 2;
  const artists = [...new Set(songsData.songs.map(s => s.artist))];
  // Sort longest-first so "LCD Soundsystem" matches before a partial like "System"
  artists.sort((a, b) => b.length - a.length);

  // Pass 1: full-name match — bidirectional
  // "the velvet underground" in "velvet underground"? No. But "velvet underground" in "the velvet underground"? Yes.
  // "country joe" in "country joe and the fish"? Yes.
  // Both directions covered.
  for (const artist of artists) {
    const artistNorm = normalize(artist);
    if (msgNorm.includes(artistNorm) || (isMultiWord && artistNorm.includes(msgNorm))) {
      return songsData.songs.filter(s => normalize(s.artist) === artistNorm);
    }
  }

  // Pass 2: meaningful-word match
  // Single-word query (e.g. "radiohead", "burial", "milton"):
  //   → any single meaningful word match is enough
  // Multi-word query (e.g. "lcd soundsystem", "velvet underground"):
  //   → ALL meaningful words must appear (prevents partial false positives)
  for (const artist of artists) {
    const artistNorm = normalize(artist);
    const meaningfulArtistWords = artistNorm.split(/\s+/).filter(w =>
      w.length >= 5 &&
      !GENRE_WORDS.has(w) &&
      !ARTIST_STOPWORDS.has(w)
    );
    if (meaningfulArtistWords.length === 0) continue;

    const matched = isMultiWord
      ? meaningfulArtistWords.every(aw => msgWords.has(aw))
      : meaningfulArtistWords.some(aw => msgWords.has(aw));

    if (matched) {
      return songsData.songs.filter(s => normalize(s.artist) === artistNorm);
    }
  }
  return null;
}

// Words too generic to use as partial artist name signals
const ARTIST_STOPWORDS = new Set([
  'music', 'band', 'sound', 'sounds', 'group', 'club', 'party',
  'world', 'street', 'city', 'boys', 'girls', 'kids', 'men', 'women',
  'people', 'gang', 'crew', 'young', 'true', 'pure', 'wild',
  'black', 'white', 'red', 'blue', 'gold', 'silver',
  'tapes', 'records', 'collective', 'project', 'unit',
]);

// =====================
// KEYWORD EXTRACTION
// =====================
async function extractKeywords(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 200,
    messages: [{ role: 'user', content: `You are a music search assistant. Convert any request — including moods, situations, metaphors, and feelings — into music genre/mood/tag keywords. Return ONLY a JSON array.

EXPLICIT GENRE/MOOD MAPPINGS:
- "rap" or "hip-hop" → ["rap", "hip-hop", "hip hop"]
- "808" or "trap beats" → ["808", "trap", "hip hop", "rap", "bass-heavy"]
- "nyc" or "new york" hip hop → ["new york", "nyc", "east coast", "boom bap", "hip hop", "rap"]
- "outsider" → ["outsider", "lo-fi", "primitive", "raw", "weird", "eccentric"]
- "sad" or "heartbreak" → ["sad", "melancholy", "heartbreak", "lonely", "slowcore"]
- "chill" or "mellow" → ["chill", "mellow", "relaxed", "ambient", "downtempo"]
- "brazil" → ["brazil", "brazilian", "bossa nova", "samba", "tropicalia"]
- "80s" → ["80s", "1980s", "synth", "new wave", "post-punk"]
- "electronic" → ["electronic", "synth", "electro", "techno", "dance"]
- "good lyrics" or "lyrical" or "songwriting" → ["singer-songwriter", "folk", "indie", "lyrical", "poetic"]
- "instrumental" or "no vocals" → ["instrumental", "ambient", "post-rock", "jazz", "electronic"]
- "female vocalist" → ["female vocalist", "singer-songwriter"]
- "uplifting" or "feel good" → ["uplifting", "upbeat", "joyful", "warm"]
- "weird" or "strange" or "unusual" → ["experimental", "outsider", "avant-garde", "lo-fi", "weird"]
- "dark" or "brooding" → ["dark", "brooding", "gothic", "post-punk", "industrial", "noir"]
- "political" or "protest" → ["political", "protest", "punk", "rap", "folk"]

SITUATIONAL/CONTEXTUAL MAPPINGS (translate the feeling, not the words):
- "late night", "2am", "city at night", "driving at night" → ["atmospheric", "nocturnal", "ambient", "electronic", "downtempo", "dark"]
- "working", "focus", "concentration" → ["instrumental", "ambient", "post-rock", "electronic", "downtempo"]
- "recorded in a basement", "lo-fi feeling", "raw recording", "imperfect" → ["lo-fi", "outsider", "raw", "primitive", "garage", "DIY"]
- "dad in the 70s", "parents music", "classic rock era" → ["70s", "1970s", "rock", "folk rock", "soul", "funk"]
- "dinner party", "sophisticated", "background music" → ["jazz", "soul", "bossa nova", "ambient", "downtempo", "elegant"]
- "feels old", "from another era", "timeless", "vintage" → ["60s", "70s", "soul", "jazz", "folk", "vintage"]
- "changed how I think about music", "influential", "important" → ["experimental", "avant-garde", "influential", "art rock", "post-punk"]
- "just got out of relationship", "breakup", "heartbroken" → ["sad", "melancholy", "heartbreak", "slowcore", "folk", "indie"]
- "nostalgic for time I never lived", "wistful", "bittersweet" → ["nostalgic", "dreamy", "shoegaze", "dream pop", "psychedelic", "vintage"]
- "genuinely strange", "weird but love it", "acquired taste" → ["outsider", "experimental", "avant-garde", "lo-fi", "weird", "eccentric"]
- "punk but melodic", "aggressive but catchy" → ["punk", "post-punk", "new wave", "power pop", "melodic"]
- "hip hop but experimental", "not mainstream rap" → ["experimental", "hip hop", "abstract", "noise rap", "avant-garde", "underground"]
- "soul but weirder" → ["soul", "psychedelic soul", "funk", "experimental", "outsider"]
- "between jazz and electronic" → ["jazz", "electronic", "ambient", "downtempo", "IDM", "fusion"]

RULES:
- Always translate situation/feeling into musical descriptors — never return narrative words like "basement", "night", "driving", "dinner"
- Never return partial words or substrings
- Artist names and song titles → return as-is
- Do not use vague terms like "classic" or "popular"
- Return 4–10 keywords minimum for longer requests

Request: "${userMessage}"
Return ONLY the JSON array, no explanation.` }]
  });
  try {
    const text = response.content[0].text.trim();
    console.log('Raw keyword response:', text);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) { console.log('No JSON array found'); return []; }
    const raw = JSON.parse(match[0]).map(k => k.toLowerCase());
    const inputWords = userMessage.toLowerCase().split(/\s+/);
    return raw.filter(k => k.length >= 3 || inputWords.includes(k));
  } catch (e) { console.log('Keyword parse error:', e.message); return []; }
}

// =====================
// CHARACTER + RESPONSE GENERATION
// =====================
const EFRAIN_CHARACTER = `You are Efrain — a product designer and music obsessive based in New Jersey. You built efrain.fm because you love sharing music and the stories behind it. It's a creative project that lets you do that with anyone who finds the site.

Background: You made music in your teens and 20s. You've spent years in health tech and design. You love talking about music, sharing cool discoveries, and recommending songs to people. Your design work is at www.efrain.design if anyone's curious.

About the site: Songs play as 30-second Spotify previews by default — but if someone's logged into Spotify they can save tracks and hear them in full there. Apple Music support (full playback) is something you're working on adding. Occasionally you share YouTube videos instead of Spotify embeds — either because a song isn't on streaming services, or because there's a specific live performance or version you wanted to share.

Personality: Warm, direct, a little dry. Deep music knowledge — outsider, lo-fi, experimental, jazz, proto-punk, international. Never pretentious. You share because you genuinely love it, not to impress anyone.

Important: Don't mention this being a portfolio piece, case study, or that you're looking for work. It's just a project you made because you wanted to. Keep responses SHORT — 2-3 sentences max. Steer music-adjacent questions back toward asking what they want to hear. Plain text only, no markdown. NEVER invent or describe features that don't exist — if something doesn't work a certain way, just redirect to what you can do (play songs from your collection). NEVER say things like "that search isn't set up yet" or "that feature isn't available."`;

async function generateConversationalResponse(userMessage, lastSong) {
  const songContext = lastSong ? `The last song you shared was "${lastSong.title}" by ${lastSong.artist}.` : '';
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 120,
    system: EFRAIN_CHARACTER,
    messages: [{ role: 'user', content: `${userMessage}${songContext ? '\n\n' + songContext : ''}` }]
  });
  return r.content[0].text;
}

function generateNoMatchResponse(userMessage) {
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
  const lines = [
    "Can't think of anything like that.",
    "I'm not remembering anything that fits.",
    "Can't remember anything like that.",
    "Nothing's coming to mind for that.",
    "I don't remember having anything like that.",
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

// =====================
// BRIDGE LOOKUP
// Checks if there is a curated bridge between the last song and the next song.
// =====================
function findBridge(fromSong, toSong) {
  if (!fromSong) return null;
  // If toSong provided, check exact pair. Otherwise find any bridge FROM this song.
  return bridgesData.find(b => {
    const fromMatch = normalize(b.from) === normalize(fromSong.title) &&
      normalize(b.fromArtist) === normalize(fromSong.artist);
    if (!fromMatch) return false;
    if (!toSong) return true; // just checking if a bridge exists from this song
    return normalize(b.to) === normalize(toSong.title) &&
      normalize(b.toArtist) === normalize(toSong.artist);
  }) || null;
}

// =====================
// RELATED SONG + INTERRUPT LOGIC
// =====================
function findRelatedSong(lastSong, playedTitles) {
  if (!lastSong) return null;
  const lastTags = getDescriptiveTags(lastSong);
  let best = null, bestOverlap = 0;
  for (const song of songsData.songs) {
    if (playedTitles.includes(song.title) || song.artist === lastSong.artist) continue;
    const sTags = getDescriptiveTags(song);
    const overlap = lastTags.filter(t => sTags.includes(t)).length;
    if (overlap >= 3 && overlap > bestOverlap) { bestOverlap = overlap; best = song; }
  }
  return best;
}

const COLLECTION_GENRES = [
  'jazz', 'electronic', 'folk', 'punk', 'soul', 'hip-hop', 'ambient',
  'funk', 'country', 'reggae', 'experimental', 'R&B',
  'latin', 'afrobeat', 'blues', 'pop', 'noise', 'indie', 'dance',
];

function getDynamicOptions(justPlayedSong, playedTitles = []) {
  const songTagText = normalize(`${justPlayedSong.genre} ${justPlayedSong.mood} ${getDescriptiveTags(justPlayedSong).join(' ')}`);

  const contrasting = COLLECTION_GENRES.filter(g => {
    if (new RegExp('\\b' + g + '\\b').test(songTagText)) return false;
    const re = new RegExp('\\b' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const matchCount = songsData.songs.filter(s => {
      if (playedTitles.includes(s.title)) return false;
      const structured = normalize(`${s.genre} ${s.mood} ${getDescriptiveTags(s).join(' ')}`);
      return re.test(structured);
    }).length;
    return matchCount >= 2;
  });

  return contrasting.sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map(g => g.charAt(0).toUpperCase() + g.slice(1));
}

function decideInterrupt(session, justPlayedSong) {
  const count = session.songCount;
  const sinceLastInterrupt = count - session.lastInterruptSong;
  if (sinceLastInterrupt < 3) return null;

  if (count === 6 && !session.askedFavorite) {
    session.askedFavorite = true;
    session.lastInterruptSong = count;
    return { type: 'favorite_prompt', message: "I've been doing a lot of recommending — do you have any song recommendations for me?", options: ['Yes', 'No'] };
  }

  if (count >= 5 && sinceLastInterrupt >= 4) {
    // Check for a curated bridge first — these take priority over generic related songs
    const related = findRelatedSong(justPlayedSong, session.playedSongs);
    if (related) {
      const bridge = findBridge(justPlayedSong, related);
      session.lastInterruptSong = count;
      session._pendingRelatedSong = related.title;
      session._pendingBridge = bridge ? bridge.bridge : null;
      const msg = bridge
        ? "This reminds me of something I always play after this — want to hear it?"
        : "Oh that reminds me of another song actually...";
      return { type: 'related', message: msg, options: ['Tell me more', 'Not right now'] };
    }
  }

  if (count >= 9 && (count - 9) % 4 === 0 && sinceLastInterrupt >= 4) {
    session.lastInterruptSong = count;
    const options = getDynamicOptions(justPlayedSong, session.playedSongs);
    if (options.length < 2) return null;
    return { type: 'vibe_check', message: "Want to go somewhere different?", options };
  }

  if (count >= 12 && !session.askedMoreOf && sinceLastInterrupt >= 4) {
    session.askedMoreOf = true;
    session.lastInterruptSong = count;
    const options = getDynamicOptions(justPlayedSong, session.playedSongs);
    if (options.length < 2) return null;
    return { type: 'more_of', message: "What else are you in the mood for?", options };
  }

  return null;
}

// =====================
// FAVORITES
// =====================
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
    matchContext = `You already shared "${collectionMatch.match.title}" by ${collectionMatch.match.artist} with them earlier. Respond warmly — like "oh yeah, I already threw that on for you!" Do NOT offer to play it again.`;
  } else if (collectionMatch) {
    matchContext = `You have "${collectionMatch.match.title}" by ${collectionMatch.match.artist} in your collection and it's playing now. Acknowledge their taste warmly. Do NOT say you'll play it — it is already playing.`;
  } else {
    matchContext = `You don't have that. Say "I'll check that out" or similar — warm, brief, one sentence.`;
  }
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 100,
    system: EFRAIN_CHARACTER,
    messages: [{ role: 'user', content: `Visitor's favorite: "${userInput}"\n${matchContext}\n\n1-2 sentences MAX. React like a person, not a critic.` }]
  });
  return r.content[0].text;
}

// =====================
// REACTION DETECTION
// =====================
function isMoreRequest(msg) {
  return /\b(more|yes|another|again|keep going|similar|same vibe|like that|more please|more of that|yes more|love it|love this|keep it|that kind)\b/i.test(msg);
}

function isVideoRequest(msg) {
  return /\b(video|music video|youtube|visual|watch|clip)\b/i.test(msg);
}

function isAffirmation(msg) {
  const t = msg.trim();
  if (/^(wow|damn|whoa|yes!?|yep|yeah|haha|lol|ha|nice|great|dope|sick|banger|bop|slaps|perfect|incredible|wild|crazy|hell yeah|no way|omg|oh wow|oh nice|love it|love this|loved it|so good|good one|that's?\s*(great|awesome|amazing|cool|nice|sick|dope|perfect|wild|crazy|so good|a banger))[\s!.]*$/i.test(t)) return true;
  if (/\b(i\s+(loved?|liked?|enjoyed|dug|vibed\s+with)\s+(that|this|it|that\s+song|this\s+song|that\s+one|this\s+one)|that\s+(song\s+)?(was|is)\s+(great|amazing|awesome|cool|so\s+good|perfect|really\s+good|fire)|this\s+(song\s+)?(is|was)\s+(great|amazing|awesome|cool|so\s+good|perfect|really\s+good|fire)|i\s+(like|love)\s+(this|that|it|this\s+song|that\s+song|this\s+one)|really\s+(good|like\s+(it|this|that))|loved\s+(it|this|that|that\s+song|this\s+song))\b/i.test(t)) return true;
  return false;
}

function isNegativeReaction(msg) {
  const t = msg.trim();
  if (/^(meh|nah|nope|pass)[\s!.]*$/i.test(t)) return true;
  if (/\b(i\s+(hated?|disliked?|didn'?t\s+(like|enjoy)|wasn'?t\s+into)\s+(that|this|it|that\s+song|this\s+song|that\s+one|this\s+one)|not\s+(for\s+me|my\s+thing|feeling\s+it)|this\s+isn'?t\s+(for\s+me|my\s+thing)|don'?t\s+(like|love)\s+(it|this|that)|not\s+into\s+(it|this)|skip\s+(it|this)?)\b/i.test(t)) return true;
  return false;
}

function isOffScript(msg) {
  return /\b(who\s+(are|is)\s+(you|efrain)|what\s+(are|is)\s+(you|this|efrain\.?fm|this\s+site|this\s+place)|tell\s+me\s+about\s+(yourself|you|efrain)|are\s+you\s+(a\s+)?(real|bot|ai|human|person|robot)|do\s+you\s+(have|make|play|listen)|what\s+do\s+you\s+do|where\s+are\s+you\s+from|what'?s\s+your\s+(deal|story|background)|how\s+(does\s+this\s+work|did\s+you|old\s+are)|did\s+you\s+(make|build|create)\s+this|is\s+this\s+your|what\s+kind\s+of\s+music\s+do\s+you|do\s+you\s+like\s+music|what'?s\s+efrain|why\s+did\s+you|what\s+inspired)\b/i.test(msg);
}

function isConversational(msg) {
  return /\b(just listened|listened to that|already heard|heard that|love that|loved that|nice|great|good one|that was|anything else|what else|keep going|what about|how about)\b/i.test(msg);
}

// =====================
// SONG RESPONSE BUILDER
// =====================
function buildSongResponse(song, session, interrupt = null, bridge = null) {
  const prevSong = session.lastSong;
  session.playedSongs.push(song.title);
  session.lastSong = song;
  session.lastSongTags = song.tags; // already normalized arrays at load time
  session.lastSongArtist = song.artist;
  session.songCount++;

  // Bridge check runs BEFORE decideInterrupt timing gates —
  // curated pairs always fire regardless of interrupt cooldown.
  let int = interrupt;
  if (!int) {
    const bridgeMatch = findBridge(song, null); // find any bridge FROM this song
    if (bridgeMatch) {
      // Look up the destination song in the collection
      const bridgeDest = songsData.songs.find(s =>
        normalize(s.title) === normalize(bridgeMatch.to) &&
        normalize(s.artist) === normalize(bridgeMatch.toArtist) &&
        !session.playedSongs.includes(s.title)
      );
      if (bridgeDest) {
        session._pendingBridge = bridgeMatch.bridge;
        session._pendingRelatedSong = bridgeDest.title;
        session.lastInterruptSong = session.songCount;
        int = {
          type: 'related',
          message: "This reminds me of something I always play after this — want to hear it?",
          options: ['Play it', 'Maybe later'],
          isBridge: true,
        };
      } else {
        int = decideInterrupt(session, song);
      }
    } else {
      int = decideInterrupt(session, song);
    }
  }

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

    if (collectionMatch && session.playedSongs.includes(collectionMatch.match.title)) {
      const responseText = await generateFavoriteResponse(input, { match: collectionMatch.match, alreadyPlayed: true });
      return res.json({ response: responseText, song: null });
    }

    const responseText = await generateFavoriteResponse(input, collectionMatch);
    let song = null;
    if (collectionMatch && !session.playedSongs.includes(collectionMatch.match.title)) {
      const s = collectionMatch.match;
      session.playedSongs.push(s.title);
      session.lastSong = s;
      session.lastSongTags = s.tags;
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

    // ---- Fast-path: no API call needed ----

    // "Efrain/your favorite" redirect
    if (/\b(your|efrain'?s?)\s+(favorite|favourite|fave|best|top|pick|picks)\b/i.test(message)) {
      const redirects = [
        "Honestly, they're all favorites in different ways — is there a genre, mood, or era you want to explore?",
        "That's a trap, I can't pick just one. What are you feeling right now?",
        "Hard to say. Give me a vibe and I'll find you something good.",
        "Too many to count. What kind of mood are you in?",
      ];
      return res.json({ response: redirects[Math.floor(Math.random() * redirects.length)], song: null });
    }

    // ---- Button choice handlers — MUST run before affirmation/reaction checks ----
    // These are exact string matches from button clicks and must take priority.
    const available = () => songsData.songs.filter(s => !session.playedSongs.includes(s.title));

    const pickTopScoring = (pool) => {
      if (!pool.length) return null;
      const top = Math.max(...pool.map(s => s.score || 0));
      const picks = pool.filter(s => (s.score || 0) === top);
      return picks[Math.floor(Math.random() * picks.length)];
    };

    if (msgLower === 'keep this vibe' && session.lastSongTags) {
      const scored = scoreSongs(available(), session.lastSongTags).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      const song = pickTopScoring(diff.length ? diff : scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    if ((msgLower === 'tell me more' || msgLower === 'play it') && session._pendingRelatedSong) {
      const related = songsData.songs.find(s => s.title === session._pendingRelatedSong);
      const bridgeText = session._pendingBridge || null;
      session._pendingRelatedSong = null;
      session._pendingBridge = null;
      if (related && !session.playedSongs.includes(related.title)) {
        return res.json(buildSongResponse(related, session, null, bridgeText));
      }
    }

    if (msgLower === 'not right now' || msgLower === 'maybe later') {
      session._pendingRelatedSong = null;
      return res.json({ response: "No problem — keep asking.", song: null });
    }

    if (msgLower === 'yes') {
      return res.json({ response: null, song: null, interrupt: { type: 'favorite', message: "What's the song or artist?", freeText: true } });
    }

    if (msgLower === 'no' || msgLower === "i don't" || msgLower === 'not sure' || msgLower === 'idk') {
      const replies = ["No worries — what do you want to hear next?", "All good. What are you in the mood for?", "That's fine. Keep asking."];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    // Negative reactions
    if (isNegativeReaction(message)) {
      const s = session.lastSong;
      const replies = s
        ? [`Fair enough — ${s.artist} isn't for everyone. What are you in the mood for instead?`, `No worries. What direction do you want to go?`, `Got it. What would hit better right now?`]
        : ["No worries. What are you in the mood for?"];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    // Affirmations
    if (isAffirmation(message)) {
      const s = session.lastSong;
      const replies = s
        ? [`Yeah, ${s.title} is a good one. What are you in the mood for next?`, `Right? ${s.artist} doesn't miss. What do you want to hear next?`, `Glad that one landed. What else are you feeling?`, `${s.title} holds up every time. What are you feeling next?`]
        : ["Right? Keep going — what else are you in the mood for?", "Good stuff. What do you want to hear next?", "Yeah. What else can I find you?", "Glad it landed. What are you feeling next?"];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    // Playback / Spotify question
    if (/\b(whole\s+song|full\s+(song|track|version)|can'?t\s+(hear|play|listen)|only\s+(hear|get|playing)\s+(30|thirty)|30\s+seconds|thirty\s+seconds|why\s+(only|can'?t)|preview|just\s+a\s+clip|stream\s+full|listen\s+in\s+full|full\s+playback)\b/i.test(message)) {
      return res.json({ response: "Spotify only lets me embed 30-second previews here — but if you're logged in you can save any track and hear it in full on Spotify. Apple Music support with full playback is something I'm working on adding.", song: null });
    }

    // Apple Music
    if (/\bapple\s+music\b/i.test(message)) {
      return res.json({ response: "Apple Music support is something I'm working on — the plan is to let you switch players and hear full tracks without needing Spotify. Not live yet though.", song: null });
    }

    // YouTube format question
    if (/\b(why\s+(did\s+you\s+use|is\s+this|a)\s+youtube|why\s+youtube|youtube\s+video\?|what'?s\s+with\s+the\s+youtube|youtube\s+instead)\b/i.test(message)) {
      const ytContext = session.lastSong ? `You just shared "${session.lastSong.title}" by ${session.lastSong.artist}.` : '';
      const reply = await generateConversationalResponse(
        `Someone asked why you used a YouTube video. ${ytContext} Explain briefly — either the song isn't on streaming services, or you wanted to share a specific live performance. Keep it to 1-2 sentences.`,
        session.lastSong
      );
      return res.json({ response: reply, song: null });
    }

    // Off-script conversational
    if (isOffScript(message)) {
      const reply = await generateConversationalResponse(message, session.lastSong);
      return res.json({ response: reply, song: null });
    }

    if (msgLower === 'more of that energy' && session.lastSongTags) {
      const scored = scoreSongs(available(), session.lastSongTags).filter(s => s.score > 0);
      const song = pickTopScoring(scored);
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

    // "More like this" — use last song's tags as keywords
    if (isMoreRequest(message) && session.lastSongTags) {
      const scored = scoreSongs(available(), session.lastSongTags).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      const song = pickTopScoring(diff.length ? diff : scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    // ---- Direct title request — "play me [title]" or "play [title] by [artist]" ----
    // Runs before artist lookup to handle specific song requests correctly.
    const playMeMatch = message.match(/^play(?:\s+me)?\s+(.+?)(?:\s+by\s+.+)?$/i);
    if (playMeMatch) {
      const requestedTitle = normalize(playMeMatch[1].trim());
      const exactSong = songsData.songs.find(s =>
        !session.playedSongs.includes(s.title) &&
        normalize(s.title) === requestedTitle
      );
      if (exactSong) return res.json(buildSongResponse(exactSong, session));
    }

    // Artist lookup — runs before keyword extraction so no API call needed for artist queries
    const artistSongs = findSongsByArtist(message);
    if (artistSongs) {
      const av = artistSongs.filter(s => !session.playedSongs.includes(s.title));
      if (av.length) return res.json(buildSongResponse(av[Math.floor(Math.random() * av.length)], session));
      // All played — fall through to keyword search
    }

    // Keyword extraction (API call)
    const keywords = await extractKeywords(message);
    console.log('Keywords:', keywords);

    const preferVideo = isVideoRequest(message);
    const conversational = isConversational(message);
    const bridge = conversational ? "Okay, let me find something else." : null;
    const isGeneric = /\b(another|random|something|anything|surprise|different|else)\b/i.test(message) || keywords.length === 0;

    if (isGeneric) {
      const avSongs = available();
      if (!avSongs.length) return res.json({ response: "I've shared my entire collection with you! That's all I have for now.", song: null });
      return res.json(buildSongResponse(avSongs[Math.floor(Math.random() * avSongs.length)], session, null, bridge));
    }

    // ---- Specific title lookup ----
    // Only runs for keywords that look like song/album titles, not genre/mood words.
    // This prevents "mellow" from matching "Say Something" or "country" from matching
    // any song with those words in the title.
    const TITLE_MATCH_STOPWORDS = new Set([
      // UI/request words
      'song', 'music', 'track', 'tune', 'play', 'hear', 'listen', 'find',
      'give', 'want', 'need', 'show', 'another', 'more', 'that', 'this',
      // Descriptors too vague to be title signals
      'like', 'love', 'good', 'great', 'nice', 'best', 'cool', 'bad',
      'new', 'old', 'some', 'any', 'just', 'know', 'feel',
      // Common title words that create false positives
      'something', 'anything', 'everything', 'nothing', 'someone', 'anyone',
      'somewhere', 'sometime', 'somehow', 'somebody', 'nobody',
      'pop', 'body', 'rock', 'soul', 'mind', 'life', 'time', 'day',
      'girl', 'girls', 'boy', 'boys', 'man', 'woman', 'baby', 'home',
      'fire', 'rain', 'sun', 'moon', 'star', 'night', 'dark', 'light',
      'ride', 'walk', 'run', 'come', 'gone', 'lost', 'back', 'down',
      'heart', 'eyes', 'hand', 'face', 'head', 'world', 'away',
      'favorite', 'favourite',
      'can', 'let', 'get', 'got', 'set', 'put', 'see', 'say', 'use',
      'try', 'hit', 'big', 'low', 'high', 'hot', 'cold',
    ]);

    const titleKeywords = keywords.filter(k => {
      const n = normalize(k);
      return k.length >= 4 && !TITLE_MATCH_STOPWORDS.has(n) && !GENRE_WORDS.has(n);
    });

    if (titleKeywords.length > 0) {
      const specificSong = songsData.songs.find(s =>
        !session.playedSongs.includes(s.title) &&
        titleKeywords.some(k => {
          const normTitle = normalize(s.title);
          const normK = normalize(k);
          if (normTitle === normK) return true;
          const escaped = normK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp('\\b' + escaped + '\\b').test(normTitle);
        })
      );
      if (specificSong) return res.json(buildSongResponse(specificSong, session));
    }

    // ---- Scored matching ----
    const allScored = scoreSongs(songsData.songs, keywords, preferVideo);
    const hasAnyMatch = allScored.some(s => s.score >= 2);

    if (!hasAnyMatch) {
      const noMatchText = generateNoMatchResponse(message);
      const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
      const interrupt = genreOptions.length >= 2
        ? { type: 'genre_suggest', message: `${noMatchText} Pick from some of these.`, options: genreOptions }
        : null;
      return res.json({ response: interrupt ? null : noMatchText, song: null, interrupt });
    }

    const avSongs = available();
    const avScored = scoreSongs(avSongs, keywords, preferVideo);
    const avMatches = avScored.filter(s => s.score >= 2);

    if (!avMatches.length) {
      return res.json({ response: "Think I've played everything along those lines — is there another direction you want to go?", song: null });
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
