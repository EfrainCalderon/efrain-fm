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
  message: { response: "Slow down a little — you've hit the request limit. Try again in a minute.", song: null },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/chat', limiter);

// =====================
// DATA LOADING
// New schema: songs have traits object with weights, streaming object with spotify/apple_music/youtube.
// No more flat genre/mood/tags strings to normalize.
// =====================
const songsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));
const favoritesPath = path.join(__dirname, 'data', 'favorites.json');

const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      playedSongs: [], lastSongTraits: null, lastSongArtist: null, lastSong: null,
      songCount: 0, askedMoreOf: false, lastInterruptSong: 0,
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
// Words that should ONLY match trait keys — never artist names or song titles.
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
  // Moods — also genre-like in that they should hit trait fields, not titles
  'mellow', 'chill', 'upbeat', 'energetic', 'melancholy', 'dreamy',
  'raw', 'smooth', 'sparse', 'minimal', 'intense', 'gentle', 'soft',
  'dark', 'atmospheric', 'haunting', 'brooding', 'romantic', 'tender',
  'heavy', 'loud', 'quiet', 'slow', 'fast', 'aggressive', 'peaceful',
  // Common words that are also band/artist names — blocked from raw keyword matching
  // so "love", "pop", "can", "wire", "yes" never match Love, Iggy Pop, CAN, Wire, Yes
  'love', 'pop', 'can', 'wire', 'yes',
]);

// =====================
// TRAIT VOCABULARY
// Maps user-facing words to trait IDs in our controlled vocabulary.
// This is how we bridge between what users type and what's in the traits object.
// =====================
const TRAIT_ALIASES = {
  // Energy
  'high energy': 'energy:high', 'energetic': 'energy:high', 'loud': 'energy:high', 'fast': 'energy:high',
  'low energy': 'energy:low', 'slow': 'energy:low', 'quiet': 'energy:low', 'soft': 'energy:low', 'mellow': 'energy:low',
  'hypnotic': 'energy:hypnotic', 'repetitive': 'energy:hypnotic', 'trance': 'energy:hypnotic',
  'chaotic': 'energy:chaotic', 'frantic': 'energy:chaotic', 'hectic': 'energy:chaotic',

  // Mood
  'sad': 'mood:melancholic', 'melancholy': 'mood:melancholic', 'melancholic': 'mood:melancholic', 'wistful': 'mood:melancholic',
  'dark': 'mood:dark', 'heavy': 'mood:dark', 'bleak': 'mood:dark', 'brooding': 'mood:dark',
  'happy': 'mood:joyful', 'joyful': 'mood:joyful', 'upbeat': 'mood:joyful', 'uplifting': 'mood:joyful', 'feel good': 'mood:joyful',
  'tense': 'mood:tense', 'anxious': 'mood:tense', 'nervous': 'mood:tense',
  'tender': 'mood:tender', 'gentle': 'mood:tender', 'soft': 'mood:tender', 'sweet': 'mood:tender',
  'angry': 'mood:defiant', 'defiant': 'mood:defiant', 'aggressive': 'mood:defiant', 'confrontational': 'mood:defiant', 'political': 'mood:defiant',
  'dreamy': 'mood:dreamlike', 'hazy': 'mood:dreamlike', 'surreal': 'mood:dreamlike', 'dreamlike': 'mood:dreamlike',
  'weird': 'mood:playful', 'playful': 'mood:playful', 'funny': 'mood:playful', 'quirky': 'mood:playful',
  'sexy': 'mood:erotic', 'erotic': 'mood:erotic', 'sensual': 'mood:erotic',
  'spiritual': 'mood:spiritual', 'transcendent': 'mood:spiritual', 'devotional': 'mood:spiritual',

  // Texture
  'lo-fi': 'texture:lo-fi', 'lofi': 'texture:lo-fi', 'raw': 'texture:lo-fi', 'rough': 'texture:lo-fi', 'tape': 'texture:lo-fi',
  'lush': 'texture:lush', 'orchestral': 'texture:lush', 'layered': 'texture:lush', 'dense': 'texture:lush', 'produced': 'texture:lush',
  'sparse': 'texture:sparse', 'minimal': 'texture:sparse', 'stripped': 'texture:sparse', 'bare': 'texture:sparse',
  'noisy': 'texture:noisy', 'distorted': 'texture:noisy', 'abrasive': 'texture:noisy', 'feedback': 'texture:noisy',
  'warm': 'texture:warm', 'analog': 'texture:warm', 'cozy': 'texture:warm',
  'cold': 'texture:cold', 'clinical': 'texture:cold', 'digital': 'texture:cold', 'icy': 'texture:cold',
  'psychedelic': 'texture:psychedelic', 'trippy': 'texture:psychedelic', 'warped': 'texture:psychedelic',
  'cinematic': 'texture:cinematic', 'dramatic': 'texture:cinematic', 'score': 'texture:cinematic',

  // Genre → trait IDs
  'punk': 'genre:punk', 'post-punk': 'genre:post-punk', 'garage': 'genre:garage', 'krautrock': 'genre:krautrock',
  'electronic': 'genre:electronic', 'synth': 'genre:electronic', 'hip-hop': 'genre:hip-hop', 'rap': 'genre:hip-hop',
  'hip hop': 'genre:hip-hop', 'soul': 'genre:soul', 'funk': 'genre:funk', 'folk': 'genre:folk',
  'experimental': 'genre:experimental', 'avant-garde': 'genre:experimental', 'noise': 'genre:noise',
  'ambient': 'genre:ambient', 'dance': 'genre:dance', 'disco': 'genre:dance',
  'psychedelic': 'genre:psychedelic', 'art rock': 'genre:art-rock', 'afrobeat': 'genre:afrobeat',
  'r&b': 'genre:r&b', 'jazz': 'genre:jazz', 'country': 'genre:country', 'latin': 'genre:latin',
  // Pop — maps to danceable/joyful rather than a genre:pop trait we don't have.
  // This prevents raw keyword fallback from matching "Iggy Pop", "Pop Levi", k-pop artists by text.
  'pop': 'mood:joyful', 'mainstream pop': 'mood:joyful', 'mainstream': 'mood:joyful',
  'pop music': 'mood:joyful', 'popular': 'mood:joyful',
  // Western — in most contexts means country. "Eastern/Western music" is a rarely used framing;
  // safer to treat 'western' as a country alias for this audience.
  'western': 'genre:country', 'country western': 'genre:country',

  // Era
  '50s': 'era:50s', '1950s': 'era:50s',
  '60s': 'era:60s', '1960s': 'era:60s',
  '70s': 'era:70s', '1970s': 'era:70s',
  '80s': 'era:80s', '1980s': 'era:80s',
  '90s': 'era:90s', '1990s': 'era:90s',
  '00s': 'era:00s', '2000s': 'era:00s', 'aughts': 'era:00s',
  'modern': 'era:modern', 'contemporary': 'era:modern', 'recent': 'era:modern',

  // Character
  'outsider': 'char:outsider', 'homemade': 'char:outsider', 'diy': 'char:outsider', 'bedroom': 'char:outsider',
  'political': 'char:political', 'protest': 'char:political',
  'intimate': 'char:intimate', 'personal': 'char:intimate', 'close': 'char:intimate',
  'beautiful': 'char:beautiful', 'gorgeous': 'char:beautiful',
  'late night': 'char:late-night', 'night': 'char:late-night', 'midnight': 'char:late-night', '2am': 'char:late-night',
  'danceable': 'char:danceable', 'dance': 'char:danceable',
  'nostalgic': 'char:nostalgic', 'nostalgia': 'char:nostalgic', 'vintage': 'char:nostalgic', 'retro': 'char:nostalgic',
};

// =====================
// SCORING
// New approach: sum trait weights instead of counting tag matches.
// Each keyword is mapped to a trait ID via TRAIT_ALIASES.
// The song's score = sum of trait weights for all matched traits.
// This means a song with energy:high 1.0 beats one with energy:high 0.5.
// =====================
function scoreSongs(songs, keywords, preferVideo = false, butWeightOverrides = null) {
  // First, map keywords to trait IDs
  const traitTargets = new Map(); // traitId → query weight (how strongly user asked for it)
  const rawKeywords = []; // keywords we couldn't map to traits — fall through to text search

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase().trim();
    // Haiku may return fully-formed trait IDs (e.g. "genre:jazz") — add directly
    if (kwLower.includes(':') && !kwLower.startsWith('http')) {
      traitTargets.set(kwLower, Math.max(traitTargets.get(kwLower) || 0, 1.0));
    } else if (TRAIT_ALIASES[kwLower]) {
      const traitId = TRAIT_ALIASES[kwLower];
      // If multiple keywords map to same trait, take the max weight (1.0)
      traitTargets.set(traitId, Math.max(traitTargets.get(traitId) || 0, 1.0));
    } else {
      // Try partial match against trait aliases
      let matched = false;
      for (const [alias, traitId] of Object.entries(TRAIT_ALIASES)) {
        if (alias.includes(kwLower) || kwLower.includes(alias)) {
          traitTargets.set(traitId, Math.max(traitTargets.get(traitId) || 0, 0.7));
          matched = true;
          break;
        }
      }
      if (!matched) rawKeywords.push(kwLower);
    }
  }

  // Apply but-modifier: reduce query weight for traits matching the "before but" clause
  if (butWeightOverrides) {
    for (const [traitId, _] of traitTargets) {
      const traitLabel = traitId.split(':')[1] || traitId;
      if (butWeightOverrides.reduce && (butWeightOverrides.reduce.includes(traitLabel) || traitLabel.includes(butWeightOverrides.reduce))) {
        traitTargets.set(traitId, traitTargets.get(traitId) * 0.3); // heavily reduce
      }
      if (butWeightOverrides.boost && (butWeightOverrides.boost.includes(traitLabel) || traitLabel.includes(butWeightOverrides.boost))) {
        traitTargets.set(traitId, Math.min(traitTargets.get(traitId) * 1.5, 1.5)); // boost
      }
    }
  }

  return songs.map(song => {
    const traits = song.traits || {};
    let score = 0;

    // Primary scoring: sum weighted trait matches
    for (const [traitId, queryWeight] of traitTargets) {
      if (traits[traitId] !== undefined) {
        // Score = song's trait weight × query weight
        // A song with energy:high 1.0 scores higher than energy:high 0.5
        score += traits[traitId] * queryWeight;
      }
    }

    // Secondary scoring: raw keyword fallback against title and artist
    // Only for keywords that didn't map to a trait (usually proper names)
    // Require minimum 4 chars to prevent partial substring false positives (e.g. "ive" in "aggressive" matching IVE)
    if (rawKeywords.length > 0) {
      const titleText = normalize(song.title);
      const artistText = normalize(song.artist);
      const commentaryText = normalize(song.commentary || '');

      for (const kw of rawKeywords) {
        if (GENRE_WORDS.has(kw)) continue; // never match genre words against title/artist
        if (kw.length < 4) continue; // too short — substring false positive risk
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('\\b' + escaped + '\\b', 'i');
        if (re.test(titleText)) score += 0.8;
        else if (re.test(artistText)) score += 0.8;
        else if (!COMMENTARY_STOPWORDS.has(kw) && re.test(commentaryText)) score += 0.3;
      }
    }

    // Year/decade matching — derive era trait from year field
    const year = parseInt(song.year);
    if (!isNaN(year)) {
      const decade = Math.floor(year / 10) * 10;
      const eraId = `era:${decade % 100 || decade}s`.replace('era:0s', 'era:00s');
      if (traitTargets.has(eraId) && !traits[eraId]) {
        // Song year matches requested era but era trait wasn't explicitly set
        // Give it partial credit
        score += 0.5;
      }
    }

    const isYT = song.streaming && song.streaming.youtube;
    if (preferVideo && isYT) score += 5;

    return { ...song, score };
  });
}

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

// =====================
// ARTIST LOOKUP
// =====================
const ARTIST_STOPWORDS = new Set([
  'music', 'band', 'sound', 'sounds', 'group', 'club', 'party',
  'world', 'street', 'city', 'boys', 'girls', 'kids', 'men', 'women',
  'people', 'gang', 'crew', 'young', 'true', 'pure', 'wild',
  'black', 'white', 'red', 'blue', 'gold', 'silver',
  'tapes', 'records', 'collective', 'project', 'unit',
]);

function findSongsByArtist(message) {
  const msgNorm = normalize(message);
  const msgWords = new Set(msgNorm.split(/\s+/));
  const isMultiWord = msgWords.size >= 2;
  const artists = [...new Set(songsData.songs.map(s => s.artist))];
  artists.sort((a, b) => b.length - a.length);

  for (const artist of artists) {
    const artistNorm = normalize(artist);
    // Guard: single-word artist names under 5 chars are too ambiguous (e.g. "Love", "CAN", "Wire")
    // They need an additional signal to match — either 'by', 'from', or the artist name is in title case
    // in the original message. This prevents "something my mother would love" → Love (band).
    const isSingleShortWord = !artistNorm.includes(' ') && artistNorm.length < 5;
    if (isSingleShortWord) {
      // Only match if message contains "by <artist>" or "<artist> song/music/track"
      const hasExplicitArtistSignal = new RegExp(`\\bby\\s+${artistNorm}\\b|\\b${artistNorm}\\s+(song|music|track|band|album)\\b`, 'i').test(message);
      if (!hasExplicitArtistSignal) continue;
    }
    if (msgNorm.includes(artistNorm) || (isMultiWord && artistNorm.includes(msgNorm))) {
      return songsData.songs.filter(s => normalize(s.artist) === artistNorm);
    }
  }

  for (const artist of artists) {
    const artistNorm = normalize(artist);
    const meaningfulArtistWords = artistNorm.split(/\s+/).filter(w =>
      w.length >= 5 && !GENRE_WORDS.has(w) && !ARTIST_STOPWORDS.has(w)
    );
    if (meaningfulArtistWords.length === 0) continue;
    const matched = isMultiWord
      ? meaningfulArtistWords.every(aw => msgWords.has(aw))
      : meaningfulArtistWords.some(aw => msgWords.has(aw));
    if (matched) return songsData.songs.filter(s => normalize(s.artist) === artistNorm);
  }
  return null;
}

// =====================
// KEYWORD EXTRACTION
// =====================
async function extractKeywords(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 200,
    messages: [{ role: 'user', content: `You are a music search assistant. Convert any request — including moods, situations, metaphors, and feelings — into music trait keywords. Return ONLY a JSON array.

MAP TO THESE TRAIT VOCABULARY TERMS WHERE POSSIBLE:
Energy: "energy:high", "energy:low", "energy:hypnotic", "energy:chaotic"
Mood: "mood:melancholic", "mood:dark", "mood:joyful", "mood:tense", "mood:tender", "mood:defiant", "mood:dreamlike", "mood:playful", "mood:erotic", "mood:spiritual"
Texture: "texture:lo-fi", "texture:lush", "texture:sparse", "texture:noisy", "texture:warm", "texture:cold", "texture:psychedelic", "texture:cinematic"
Genre: "genre:punk", "genre:post-punk", "genre:garage", "genre:krautrock", "genre:electronic", "genre:hip-hop", "genre:soul", "genre:funk", "genre:folk", "genre:experimental", "genre:noise", "genre:ambient", "genre:dance", "genre:psychedelic", "genre:art-rock", "genre:afrobeat", "genre:r&b", "genre:jazz", "genre:country", "genre:latin"
Era: "era:50s", "era:60s", "era:70s", "era:80s", "era:90s", "era:00s", "era:modern"
Character: "char:outsider", "char:political", "char:intimate", "char:beautiful", "char:late-night", "char:danceable", "char:nostalgic", "char:weird", "char:heavy", "char:cinematic"

SITUATIONAL MAPPINGS:
- "late night", "2am", "driving at night" → ["char:late-night", "mood:dreamlike", "energy:low"]
- "feel good", "happy" → ["mood:joyful", "char:danceable"]
- "sad", "heartbreak", "breakup" → ["mood:melancholic", "char:intimate"]
- "weird", "strange", "outsider" → ["char:outsider", "mood:playful", "texture:lo-fi"]
- "political", "protest" → ["char:political", "mood:defiant"]
- "dance", "club" → ["char:danceable", "genre:dance", "energy:high"]
- "chill", "relax" → ["energy:low", "texture:warm", "mood:dreamlike"]
- "aggressive", "angry", "loud" → ["mood:defiant", "energy:high", "texture:noisy"]
- "nostalgic", "old feeling", "retro" → ["char:nostalgic"]
- "beautiful", "gorgeous", "stunning" → ["char:beautiful"]
- "intimate", "personal", "quiet" → ["char:intimate", "texture:sparse"]
- "cosmic", "space", "otherworldly" → ["genre:experimental", "mood:dreamlike", "char:weird"]

RULES:
- Prefer trait vocabulary terms over raw words whenever possible
- For artist names or song titles, return them as plain strings
- Return 3–8 items
- Return ONLY the JSON array
- If the input is gibberish, a random string of characters, or clearly not a word in any language, return []. Do NOT return [] for real words, genre names, mood words, artist names, or any legitimate request — even if it is very short or vague

Request: "${userMessage}"` }]
  });
  try {
    const text = response.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const raw = JSON.parse(match[0]).map(k => k.toLowerCase().trim());
    return raw.filter(k => k.length >= 2);
  } catch (e) { console.log('Keyword parse error:', e.message); return []; }
}

// =====================
// ARTIST SIMILARITY — "like Nico", "something like Portishead"
// Detects "like [artist]" patterns and extracts that artist's sonic traits
// rather than doing a name lookup. Works for any artist Haiku knows about,
// not just ones in the collection.
// =====================
function detectLikeArtist(message) {
  // Match: "like Nico", "something like early radiohead", "in the style of chet baker",
  //        "reminds me of portishead", "sounds like the velvet underground"
  // Also detects negation: "nothing like nico", "not like portishead", "anything but radiohead"
  // Case-insensitive — people don't always capitalize artist names in chat
  const patterns = [
    /\blike\s+(?:early\s+|late\s+|classic\s+)?([a-z][^\.,!?]{1,40}?)(?:\s*$|[,!?.]|\s+but\b|\s+only\b|\s+except\b)/i,
    /\bin\s+the\s+style\s+of\s+([a-z][^\.,!?]{1,40}?)(?:\s*$|[,!?.])/i,
    /\breminds?\s+me\s+of\s+([a-z][^\.,!?]{1,40}?)(?:\s*$|[,!?.])/i,
    /\bsounds?\s+like\s+([a-z][^\.,!?]{1,40}?)(?:\s*$|[,!?.])/i,
    /\bvibes?\s+(?:like|of)\s+([a-z][^\.,!?]{1,40}?)(?:\s*$|[,!?.])/i,
  ];
  // Negation words that can precede "like" — "not like X", "nothing like X", "anything but X"
  const NEGATION_RE = /\b(not|nothing|never|no|opposite\s+of|anything\s+but|far\s+from)\s+(?:like\s+|sounds?\s+like\s+|reminds?\s+me\s+of\s+)?/i;

  for (const re of patterns) {
    const m = message.match(re);
    if (m) {
      const name = m[1].trim();
      // Check if negation appears before the match position
      const beforeMatch = message.slice(0, m.index);
      const negated = NEGATION_RE.test(beforeMatch) || NEGATION_RE.test(message.slice(0, (m.index || 0) + 10));
      // Capitalize each word so Haiku gets "Portishead" not "portishead"
      const artistName = name.replace(/\b\w/g, c => c.toUpperCase());
      return { artist: artistName, negated };
    }
  }
  return null;
}

async function extractArtistTraits(artistName) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 200,
    messages: [{ role: 'user', content: `You are a music search assistant. Describe the sonic characteristics of the artist "${artistName}" using ONLY trait vocabulary terms from this list. Return ONLY a JSON array of 4–7 traits.

Energy: "energy:high", "energy:low", "energy:hypnotic", "energy:chaotic"
Mood: "mood:melancholic", "mood:dark", "mood:joyful", "mood:tense", "mood:tender", "mood:defiant", "mood:dreamlike", "mood:playful", "mood:erotic", "mood:spiritual"
Texture: "texture:lo-fi", "texture:lush", "texture:sparse", "texture:noisy", "texture:warm", "texture:cold", "texture:psychedelic", "texture:cinematic"
Genre: "genre:punk", "genre:post-punk", "genre:garage", "genre:krautrock", "genre:electronic", "genre:hip-hop", "genre:soul", "genre:funk", "genre:folk", "genre:experimental", "genre:noise", "genre:ambient", "genre:dance", "genre:psychedelic", "genre:art-rock", "genre:afrobeat", "genre:r&b", "genre:jazz", "genre:country", "genre:latin"
Era: "era:50s", "era:60s", "era:70s", "era:80s", "era:90s", "era:00s", "era:modern"
Character: "char:outsider", "char:political", "char:intimate", "char:beautiful", "char:late-night", "char:danceable", "char:nostalgic", "char:weird", "char:heavy", "char:cinematic"

Examples:
- "Nico" → ["texture:sparse", "mood:melancholic", "mood:dark", "genre:art-rock", "era:60s", "char:intimate"]
- "Portishead" → ["genre:electronic", "mood:melancholic", "mood:tense", "texture:cold", "char:late-night", "energy:low"]
- "Chet Baker" → ["genre:jazz", "mood:tender", "texture:sparse", "energy:low", "char:intimate", "char:late-night"]
- "Fela Kuti" → ["genre:afrobeat", "energy:high", "char:political", "mood:defiant", "texture:lush"]

If you don't recognize the artist, return an empty array [].
Return ONLY the JSON array.` }]
  });
  try {
    const text = response.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]).map(k => k.toLowerCase().trim()).filter(k => k.length >= 2);
  } catch (e) { console.log('Artist trait parse error:', e.message); return []; }
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
    model: 'claude-haiku-4-5-20251001', max_tokens: 120,
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
// BRIDGE LOOKUP — disabled, manual bridges.json removed
// Future: curated bridges will live in songs.json using song IDs
// For now, findRelatedSong handles organic related-song suggestions
// =====================
function findBridge() { return null; }

// =====================
// RELATED SONG — now uses trait overlap instead of tag overlap
// =====================
function findRelatedSong(lastSong, playedTitles) {
  if (!lastSong) return null;
  const lastTraits = lastSong.traits || {};
  const lastTraitKeys = Object.keys(lastTraits);

  // Traits that are too generic to drive a meaningful "related song" suggestion
  const WEAK_RELATION_TRAITS = new Set(['char:nostalgic', 'char:beautiful', 'texture:warm', 'era:60s', 'era:70s', 'era:80s', 'era:90s', 'era:00s', 'era:50s', 'era:modern']);

  let best = null, bestOverlap = 0;
  for (const song of songsData.songs) {
    if (playedTitles.includes(song.title)) continue;
    if (normalize(song.artist) === normalize(lastSong.artist)) continue; // never suggest same artist
    const sTrait = song.traits || {};
    // Only count overlap on meaningful traits, not generic crossover traits
    const meaningfulOverlap = lastTraitKeys
      .filter(key => !WEAK_RELATION_TRAITS.has(key))
      .reduce((sum, key) => {
        if (sTrait[key] !== undefined) return sum + (lastTraits[key] * sTrait[key]);
        return sum;
      }, 0);
    if (meaningfulOverlap >= 1.2 && meaningfulOverlap > bestOverlap) { bestOverlap = meaningfulOverlap; best = song; }
  }
  return best;
}

// =====================
// DYNAMIC OPTIONS — uses traits instead of genre/mood strings
// =====================
const COLLECTION_TRAIT_OPTIONS = [
  { label: 'Jazz', trait: 'genre:jazz' },
  { label: 'Electronic', trait: 'genre:electronic' },
  { label: 'Folk', trait: 'genre:folk' },
  { label: 'Punk', trait: 'genre:punk' },
  { label: 'Soul', trait: 'genre:soul' },
  { label: 'Hip-Hop', trait: 'genre:hip-hop' },
  { label: 'Ambient', trait: 'genre:ambient' },
  { label: 'Funk', trait: 'genre:funk' },
  { label: 'Experimental', trait: 'genre:experimental' },
  { label: 'Latin', trait: 'genre:latin' },
  { label: 'Afrobeat', trait: 'genre:afrobeat' },
  { label: 'Dance', trait: 'genre:dance' },
  { label: 'Late Night', trait: 'char:late-night' },
  { label: 'Outsider', trait: 'char:outsider' },
  { label: 'Melancholic', trait: 'mood:melancholic' },
  { label: 'Joyful', trait: 'mood:joyful' },
];

function getDynamicOptions(justPlayedSong, playedTitles = []) {
  const songTraits = justPlayedSong.traits || {};

  const contrasting = COLLECTION_TRAIT_OPTIONS.filter(opt => {
    // Skip if the last song already has this trait strongly
    if (songTraits[opt.trait] >= 0.7) return false;
    // Check if archive has enough unplayed songs with this trait
    const matchCount = songsData.songs.filter(s => {
      if (playedTitles.includes(s.title)) return false;
      return (s.traits || {})[opt.trait] >= 0.5;
    }).length;
    return matchCount >= 2;
  });

  return contrasting.sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map(opt => opt.label);
}

function decideInterrupt(session, justPlayedSong) {
  const count = session.songCount;
  const sinceLastInterrupt = count - session.lastInterruptSong;
  if (sinceLastInterrupt < 3) return null;

  if (count >= 5 && sinceLastInterrupt >= 4) {
    const related = findRelatedSong(justPlayedSong, session.playedSongs);
    if (related) {
      const bridge = findBridge(justPlayedSong, related);
      session.lastInterruptSong = count;
      session._pendingRelatedSong = related.title;
      session._pendingBridge = bridge ? bridge.bridge : null;
      const msg = bridge
        ? "This reminds me of another song — want to hear it?"
        : "Oh, this reminds me of another song — want to hear it?";
      return { type: 'related', message: msg, options: ['Okay', 'No thank you'] };
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
    model: 'claude-haiku-4-5-20251001', max_tokens: 100,
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
// HELPER: get spotify_url for frontend (handles new streaming object)
// =====================
function getSongUrl(song) {
  if (!song.streaming) return '';
  return song.streaming.spotify || song.streaming.youtube || song.streaming.apple_music || '';
}

// =====================
// SONG RESPONSE BUILDER
// =====================
function buildSongResponse(song, session, interrupt = null, bridge = null) {
  session.playedSongs.push(song.title);
  session.lastSong = song;
  session.lastSongTraits = song.traits || {};
  session.lastSongArtist = song.artist;
  session.songCount++;

  let int = interrupt;
  if (!int) {
    const bridgeMatch = findBridge(song, null);
    if (bridgeMatch) {
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
          message: "This reminds me of another song — want to hear it?",
          options: ['Okay', 'No thank you'],
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
    song: {
      title: song.title,
      artist: song.artist,
      spotify_url: getSongUrl(song), // frontend still expects spotify_url key
      tag_title: song.tag_title || '',
      tag_url: song.tag_url || '',
    },
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
      session.lastSongTraits = s.traits || {};
      session.lastSongArtist = s.artist;
      session.songCount++;
      song = { title: s.title, artist: s.artist, spotify_url: getSongUrl(s), tag_title: s.tag_title || '', tag_url: s.tag_url || '' };
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

    if (/\b(your|efrain'?s?)\s+(favorite|favourite|fave|best|top|pick|picks)\b/i.test(message)) {
      const redirects = [
        "Honestly, they're all favorites in different ways — is there a genre, mood, or era you want to explore?",
        "That's a trap, I can't pick just one. What are you feeling right now?",
        "Hard to say. Give me a vibe and I'll find you something good.",
        "Too many to count. What kind of mood are you in?",
      ];
      return res.json({ response: redirects[Math.floor(Math.random() * redirects.length)], song: null });
    }

    const available = () => songsData.songs.filter(s => !session.playedSongs.includes(s.title));

    const pickTopScoring = (pool) => {
      if (!pool.length) return null;
      const top = Math.max(...pool.map(s => s.score || 0));
      const picks = pool.filter(s => (s.score || 0) === top);
      return picks[Math.floor(Math.random() * picks.length)];
    };

    if (msgLower === 'keep this vibe' && session.lastSongTraits) {
      // Convert traits back to keyword-like format for scoring
      const traitKeywords = Object.keys(session.lastSongTraits);
      const scored = scoreSongs(available(), traitKeywords).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      const song = pickTopScoring(diff.length ? diff : scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    if ((msgLower === 'okay' || msgLower === 'tell me more' || msgLower === 'play it') && session._pendingRelatedSong) {
      const related = songsData.songs.find(s => s.title === session._pendingRelatedSong);
      const bridgeText = session._pendingBridge || null;
      session._pendingRelatedSong = null;
      session._pendingBridge = null;
      if (related && !session.playedSongs.includes(related.title)) {
        return res.json(buildSongResponse(related, session, null, bridgeText));
      }
    }

    if (msgLower === 'no thank you' || msgLower === 'not right now' || msgLower === 'maybe later') {
      session._pendingRelatedSong = null;
      return res.json({ response: "No problem — keep exploring.", song: null });
    }

    if (msgLower === 'no' || msgLower === "i don't" || msgLower === 'not sure' || msgLower === 'idk') {
      const replies = ["No worries — what do you want to hear next?", "All good. What are you in the mood for?", "That's fine. Keep asking."];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    if (isNegativeReaction(message)) {
      const s = session.lastSong;
      const replies = s
        ? [`Fair enough — ${s.artist} isn't for everyone. What are you in the mood for instead?`, `No worries. What direction do you want to go?`, `Got it. What would hit better right now?`]
        : ["No worries. What are you in the mood for?"];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    if (isAffirmation(message)) {
      const s = session.lastSong;
      const replies = s
        ? [`Yeah, ${s.title} is a good one. What are you in the mood for next?`, `Right? ${s.artist} doesn't miss. What do you want to hear next?`, `Glad that one landed. What else are you feeling?`, `${s.title} holds up every time. What are you feeling next?`]
        : ["Right? Keep going — what else are you in the mood for?", "Good stuff. What do you want to hear next?", "Yeah. What else can I find you?", "Glad it landed. What are you feeling next?"];
      return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
    }

    if (/\b(whole\s+song|full\s+(song|track|version)|can'?t\s+(hear|play|listen)|only\s+(hear|get|playing)\s+(30|thirty)|30\s+seconds|thirty\s+seconds|why\s+(only|can'?t)|preview|just\s+a\s+clip|stream\s+full|listen\s+in\s+full|full\s+playback)\b/i.test(message)) {
      return res.json({ response: "Spotify only lets me embed 30-second previews here — but if you're logged in you can save any track and hear it in full on Spotify. Apple Music support with full playback is something I'm working on adding.", song: null });
    }

    if (/\bapple\s+music\b/i.test(message)) {
      return res.json({ response: "Apple Music support is something I'm working on — the plan is to let you switch players and hear full tracks without needing Spotify. Not live yet though.", song: null });
    }

    if (/\b(why\s+(did\s+you\s+use|is\s+this|a)\s+youtube|why\s+youtube|youtube\s+video\?|what'?s\s+with\s+the\s+youtube|youtube\s+instead)\b/i.test(message)) {
      const ytContext = session.lastSong ? `You just shared "${session.lastSong.title}" by ${session.lastSong.artist}.` : '';
      const reply = await generateConversationalResponse(
        `Someone asked why you used a YouTube video. ${ytContext} Explain briefly — either the song isn't on streaming services, or you wanted to share a specific live performance. Keep it to 1-2 sentences.`,
        session.lastSong
      );
      return res.json({ response: reply, song: null });
    }

    if (isOffScript(message)) {
      const reply = await generateConversationalResponse(message, session.lastSong);
      return res.json({ response: reply, song: null });
    }

    if (msgLower === 'more of that energy' && session.lastSongTraits) {
      const traitKeywords = Object.keys(session.lastSongTraits);
      const scored = scoreSongs(available(), traitKeywords).filter(s => s.score > 0);
      const song = pickTopScoring(scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    if (msgLower === 'something slower') {
      const scored = scoreSongs(available(), ['energy:low', 'texture:sparse', 'mood:melancholic', 'char:intimate']).filter(s => s.score > 0);
      if (scored.length) return res.json(buildSongResponse(scored[Math.floor(Math.random() * scored.length)], session));
    }

    if (msgLower === 'something weirder') {
      const scored = scoreSongs(available(), ['char:outsider', 'char:weird', 'genre:experimental', 'texture:lo-fi']).filter(s => s.score > 0);
      if (scored.length) return res.json(buildSongResponse(scored[Math.floor(Math.random() * scored.length)], session));
    }

    // ---- Normal flow ----

    if (isMoreRequest(message) && session.lastSongTraits) {
      const traitKeywords = Object.keys(session.lastSongTraits);
      const scored = scoreSongs(available(), traitKeywords).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      const song = pickTopScoring(diff.length ? diff : scored);
      if (song) return res.json(buildSongResponse(song, session));
    }

    // Direct title request
    const playMeMatch = message.match(/^play(?:\s+me)?\s+(.+?)(?:\s+by\s+.+)?$/i);
    if (playMeMatch) {
      const requestedTitle = normalize(playMeMatch[1].trim());
      const exactSong = songsData.songs.find(s =>
        !session.playedSongs.includes(s.title) &&
        normalize(s.title) === requestedTitle
      );
      if (exactSong) return res.json(buildSongResponse(exactSong, session));
    }

    // "Like [artist]" detection — runs before artist lookup and keyword extraction.
    // "something like Nico", "vibes like Portishead", "sounds like Chet Baker"
    // Instead of looking up that artist in our collection, we extract their sonic traits
    // and use those to score across the full collection. Works for any artist Haiku knows.
    const likeArtistResult = detectLikeArtist(message);
    if (likeArtistResult) {
      const { artist: likeArtistName, negated } = likeArtistResult;
      console.log('Like-artist detected:', likeArtistName, negated ? '(negated)' : '');
      const artistKeywords = await extractArtistTraits(likeArtistName);
      console.log('Artist traits:', artistKeywords);
      if (artistKeywords.length > 0) {
        // Exclude the reference artist from results — "like Portishead" should never return Portishead
        const likeArtistNorm = normalize(likeArtistName);
        const avSongs = available().filter(s => normalize(s.artist) !== likeArtistNorm);

        if (negated) {
          // "nothing like Nico" — score normally, then INVERT: lowest scorers win.
          // This finds songs that share the fewest traits with the reference artist.
          const avScored = scoreSongs(avSongs, artistKeywords, false, null);
          const maxScore = Math.max(0, ...avScored.map(s => s.score));
          // Invert scores and pick from the bottom — songs that scored 0 are most "unlike"
          const inverted = avScored
            .map(s => ({ ...s, score: maxScore - s.score }))
            .filter(s => s.score >= 0); // all songs qualify, just reordered
          inverted.sort((a, b) => b.score - a.score);
          // Take a random pick from the top 20% most-unlike songs for variety
          const topN = Math.max(5, Math.floor(inverted.length * 0.2));
          const pool = inverted.slice(0, topN);
          return res.json(buildSongResponse(pool[Math.floor(Math.random() * pool.length)], session));
        } else {
          const avScored = scoreSongs(avSongs, artistKeywords, false, null);
          const avMatches = avScored.filter(s => s.score >= 0.4);
          if (avMatches.length) {
            const top = Math.max(...avMatches.map(s => s.score));
            const topPicks = avMatches.filter(s => s.score >= top * 0.85);
            return res.json(buildSongResponse(topPicks[Math.floor(Math.random() * topPicks.length)], session));
          }
        }
      }
      // Haiku didn't recognize the artist or nothing scored — fall through to regular flow
    }

    // Artist lookup
    const artistSongs = findSongsByArtist(message);
    if (artistSongs) {
      const av = artistSongs.filter(s => !session.playedSongs.includes(s.title));
      if (av.length) return res.json(buildSongResponse(av[Math.floor(Math.random() * av.length)], session));
    }

    // Strip common filler prefixes before keyword extraction
    // "something melancholic" → "melancholic", "give me something dark" → "dark"
    const strippedMessage = message
      .replace(/^(give\s+me\s+)?(something|anything|a\s+song|some\s+music|play\s+me\s+something)\s+(that'?s?\s+)?(kind\s+of\s+)?/i, '')
      .replace(/^(i\s+want\s+)(something|a\s+song)\s+/i, '')
      .trim() || message;

    // Keyword extraction (API call)
    const keywords = await extractKeywords(strippedMessage);
    console.log('Keywords:', keywords);

    const preferVideo = isVideoRequest(message);
    const conversational = isConversational(message);
    const bridge = conversational ? "Okay, let me find something else." : null;

    // Generic request — bare random/surprise requests only
    // "something" alone is generic but "something melancholic" is NOT — strippedMessage handles that
    const bareGeneric = /^(another|random|surprise me|something different|something else|anything)$/i.test(msgLower);

    if (bareGeneric) {
      const avSongs = available();
      if (!avSongs.length) return res.json({ response: "I've shared my entire collection with you! That's all I have for now.", song: null });
      return res.json(buildSongResponse(avSongs[Math.floor(Math.random() * avSongs.length)], session, null, bridge));
    }

    // No keywords extracted — input was gibberish, typo, or unrecognizable
    // Haiku is instructed to return [] for nonsense; this is the safety net for anything that slips through
    if (keywords.length === 0) {
      const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
      const trimmed = message.trim().slice(0, 40);
      const interrupt = genreOptions.length >= 2
        ? { type: 'genre_suggest', message: `I don't think I have anything related to "${trimmed}". Try one of these instead.`, options: genreOptions }
        : null;
      return res.json({
        response: interrupt ? null : `I don't think I have anything related to "${trimmed}". What are you in the mood for?`,
        song: null,
        interrupt
      });
    }

    // "but" modifier — "soul but weirder", "punk but melodic"
    // Detect before/after and pass weight overrides to scoreSongs
    let butWeightOverrides = null;
    const butMatch = strippedMessage.match(/^(.+?)\s+but\s+(.+)$/i);
    if (butMatch) {
      butWeightOverrides = { reduce: butMatch[1].trim().toLowerCase(), boost: butMatch[2].trim().toLowerCase() };
      console.log('But-modifier:', butWeightOverrides);
    }

    // Hardcoded genre no-match guards — genres we genuinely don't have
    const HARD_NO_MATCH = [
      [/\b(bluegrass|banjo|appalachian)\b/i, "No bluegrass in here — closest I have is some folk and country."],
      [/\b(christmas|holiday|xmas|festive)\b/i, "No holiday music in this collection."],
      [/\b(polka)\b/i, "No polka in here, sorry."],
      [/\b(classical|orchestra|symphony|concerto|sonata)\b/i, "Not much classical in here — mostly contemporary stuff."],
      [/\b(nursery|children's|kids\s+music|lullaby)\b/i, "Nothing for kids in here."],
      [/\b(karaoke)\b/i, "This isn't a karaoke spot."],
    ];
    for (const [re, reply] of HARD_NO_MATCH) {
      if (re.test(message)) {
        const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
        const interrupt = genreOptions.length >= 2
          ? { type: 'genre_suggest', message: `${reply} Try one of these instead.`, options: genreOptions }
          : null;
        return res.json({ response: interrupt ? null : reply, song: null, interrupt });
      }
    }

    // Title keyword lookup (unchanged — proper names still useful)
    const TITLE_MATCH_STOPWORDS = new Set([
      'song', 'music', 'track', 'tune', 'play', 'hear', 'listen', 'find',
      'give', 'want', 'need', 'show', 'another', 'more', 'that', 'this',
      'like', 'love', 'good', 'great', 'nice', 'best', 'cool', 'bad',
      'new', 'old', 'some', 'any', 'just', 'know', 'feel',
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
      // Common words that are also artist/band names — never match these via raw keyword
      // "love" → Love (band), "can" → CAN, "pop" → Iggy Pop / Pop Levi
      'love', 'pop',
    ]);

    const titleKeywords = keywords.filter(k => {
      const n = normalize(k);
      return k.length >= 4 && !TITLE_MATCH_STOPWORDS.has(n) && !GENRE_WORDS.has(n) && !n.includes(':');
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

    // Scored matching — confidence-gated
    // MIN_SCORE: minimum to serve a song at all
    // CONFIDENCE_FLOOR: below this, don't serve — offer genre buttons instead
    const MIN_SCORE = 0.4;
    const CONFIDENCE_FLOOR = 0.6; // below this score feels like a guess, not a match

    const allScored = scoreSongs(songsData.songs, keywords, preferVideo, butWeightOverrides);
    const bestScore = Math.max(0, ...allScored.map(s => s.score));
    const hasAnyMatch = bestScore >= MIN_SCORE;

    if (!hasAnyMatch) {
      const noMatchText = generateNoMatchResponse(message);
      const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
      const interrupt = genreOptions.length >= 2
        ? { type: 'genre_suggest', message: `${noMatchText} Try one of these directions instead.`, options: genreOptions }
        : null;
      return res.json({ response: interrupt ? null : noMatchText, song: null, interrupt });
    }

    // Low confidence — best match exists but score is weak
    // Better to offer choices than serve a song that won't land
    if (bestScore < CONFIDENCE_FLOOR) {
      const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
      if (genreOptions.length >= 2) {
        return res.json({
          response: null,
          song: null,
          interrupt: { type: 'genre_suggest', message: "I'm not sure I have anything like that in my collection. What would you like to explore?", options: genreOptions }
        });
      }
      // Not enough options — fall through and serve best available
    }

    const avSongs = available();
    const avScored = scoreSongs(avSongs, keywords, preferVideo, butWeightOverrides);
    const avMatches = avScored.filter(s => s.score >= MIN_SCORE);

    if (!avMatches.length) {
      return res.json({ response: "Think I've played everything along those lines — is there another direction you want to go?", song: null });
    }

    const top = Math.max(...avMatches.map(s => s.score));
    const topPicks = avMatches.filter(s => s.score >= top * 0.85); // top 15% range, not just exact top
    return res.json(buildSongResponse(topPicks[Math.floor(Math.random() * topPicks.length)], session, null, bridge));

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Something went wrong', details: error.message });
  }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
