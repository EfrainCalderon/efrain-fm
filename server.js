require('dotenv').config({ quiet: true });
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
const songsData = require('./data/songs.json');
const favoritesPath = path.join(__dirname, 'data', 'favorites.json');

const sessions = new Map();

// =====================
// GROOVE GLOW CONFIG
// Keystone songs that are withheld until a cluster is unlocked.
// Each cluster has one keystone identified by title + artist (normalized).
// The cluster label is used in the "Discovery: X" transmission header.
// Audio file: /audio/C1NeutralMilkHotelEngine.m4a etc.
// =====================
const GROOVE_KEYSTONES = [
  { cluster: 'C1', title: 'Engine (1993)', artist: 'Neutral Milk Hotel',  label: 'Outsider', audio: '/audio/C1NeutralMilkHotelEngine.m4a' },
  { cluster: 'C2', title: 'Untrue',  artist: 'Burial',             label: 'Night',    audio: '/audio/C2BurialUntrue.m4a' },
  { cluster: 'C3', title: 'Cat Claw', artist: 'The Kills',         label: 'Raw',      audio: '/audio/C3TheKillsCatClaw.m4a' },
  { cluster: 'C4', title: 'Take the Veil Cerpin Taxt', artist: 'The Mars Volta', label: 'Cosmic', audio: '/audio/C4TheMarsVoltaTakeTheVeil.m4a' },
  { cluster: 'C5', title: "That's How Strong My Love Is", artist: 'Otis Redding', label: 'Soul',  audio: '/audio/C5OtisReddingThatsHowStrong.m4a' },
  { cluster: 'C6', title: 'Iota',    artist: 'Angel Olsen',        label: 'Loss',     audio: '/audio/C6AngelOlsenIota.m4a' },
  { cluster: 'C7', title: 'Losing My Edge', artist: 'LCD Soundsystem', label: 'Art', audio: '/audio/C7LCDSoundSystemLosingMyEdge.m4a' },
  { cluster: 'C8', title: 'Into the Mystic', artist: 'Van Morrison', label: 'Memory', audio: '/audio/C8VanMorrisonIntoTheMystic.m4a' },
  { cluster: 'C9', title: 'Beautiful People', artist: 'Marilyn Manson', label: 'Static', audio: '/audio/C9MarilynMansonBeautifulPeople.m4a' },
];

// Quick lookup: normalized "title|||artist" → keystone config
const KEYSTONE_LOOKUP = new Map(
  GROOVE_KEYSTONES.map(k => [`${normalize(k.title)}|||${normalize(k.artist)}`, k])
);

const MAX_SESSIONS = 500;

function getSession(sessionId, initialPlayedTitles = []) {
  if (!sessions.has(sessionId)) {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(sessionId, {
      playedSongs: new Set(initialPlayedTitles),
      lastSongTraits: null, lastSongArtist: null, lastSong: null,
      songCount: 0, askedMoreOf: false, lastInterruptSong: 0,
      _pendingRelatedSong: null, _pendingBridge: null,
      // True only for the one turn right after a factual-info reply — lets an ambiguous
      // follow-up ("tell me more") continue the info thread instead of being read as
      // "give me a new song." Cleared the instant any new song is actually served.
      _infoThreadActive: false, _lastSongInfoText: null, _infoExhaustedFor: null,
    });
  }
  return sessions.get(sessionId);
}

function normalize(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// =====================
// BUT-MODIFIER RESOLUTION
// Resolves a raw "but X" term to a trait ID via TRAIT_ALIASES so comparisons are
// exact rather than substring-based. Falls back to null if nothing matches.
// =====================
function resolveButTerm(term) {
  const lower = term.trim().toLowerCase();
  if (TRAIT_ALIASES[lower]) return TRAIT_ALIASES[lower];
  let best = null, bestLen = 0;
  for (const [alias, traitId] of Object.entries(TRAIT_ALIASES)) {
    if ((lower.includes(alias) || alias.includes(lower)) && alias.length > bestLen) {
      best = traitId;
      bestLen = alias.length;
    }
  }
  return best;
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
  'yacht rock', 'soft rock', 'anti-folk', 'chamber folk', 'chamber pop',
  'blues rock', 'indie rock', 'indie folk', 'baroque pop', 'ye-ye',
  'synth pop', 'glam rock', 'glam', 'lo-fi folk',
  // Moods — also genre-like in that they should hit trait fields, not titles
  'mellow', 'chill', 'upbeat', 'energetic', 'melancholy', 'dreamy',
  'raw', 'smooth', 'sparse', 'minimal', 'intense', 'gentle', 'soft',
  'dark', 'atmospheric', 'haunting', 'brooding', 'romantic', 'tender',
  'heavy', 'loud', 'quiet', 'slow', 'fast', 'aggressive', 'peaceful',
  // Common words that are also band/artist names — blocked from raw keyword matching
  // so "love", "pop", "can", "wire", "yes" never match Love, Iggy Pop, CAN, Wire, Yes
  'love', 'pop', 'can', 'wire', 'yes',
  // Words that should hit trait fields, not song titles
  'groove', 'instrumental', 'noir', 'narrative',
  // Countries / regions — never match against artist/title text
  'american', 'british', 'french', 'german', 'swedish', 'japanese', 'korean',
  'brazilian', 'nigerian', 'african', 'latin american', 'canadian', 'australian',
  'norwegian', 'icelandic', 'spanish', 'colombian', 'jamaican',
  'canada', 'america', 'france', 'germany', 'sweden', 'japan', 'korea',
  'brazil', 'nigeria', 'australia', 'norway', 'iceland', 'spain', 'colombia',
  'jamaica', 'uk', 'england', 'scotland', 'ireland', 'mexico', 'peru', 'chile',
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
  'ambient': 'genre:ambient', 'dance music': 'genre:dance', 'disco': 'genre:dance',
  'k-pop': 'genre:k-pop', 'kpop': 'genre:k-pop', 'korean pop': 'genre:k-pop',
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
  'danceable': 'char:danceable', 'dance': 'char:danceable', 'makes you move': 'char:danceable',
  'nostalgic': 'char:nostalgic', 'nostalgia': 'char:nostalgic', 'vintage': 'char:nostalgic', 'retro': 'char:nostalgic',

  // Differentiating character traits — added for buried songs
  'instrumental': 'char:instrumental', 'no vocals': 'char:instrumental', 'no singing': 'char:instrumental',
  'rare groove': 'char:rare-groove', 'rare-groove': 'char:rare-groove', 'groove': 'char:rare-groove',
  'film noir': 'char:film-noir', 'noir': 'char:film-noir',
  'narrative': 'char:narrative', 'storytelling': 'char:narrative',
  'bittersweet': 'char:bittersweet',
  'japanese': 'char:japanese', 'japan': 'char:japanese',
  'deadpan': 'char:deadpan',
  'chamber pop': 'genre:chamber-pop', 'chamber-pop': 'genre:chamber-pop',
  // New character traits
  'literate': 'char:literate', 'literary': 'char:literate', 'cerebral': 'char:literate', 'intellectual': 'char:literate', 'wordy': 'char:literate',
  'sweet': 'char:sweet',
  'acoustic': 'char:acoustic', 'unplugged': 'char:acoustic',
  'ethereal': 'char:ethereal', 'airy': 'char:ethereal', 'floaty': 'char:ethereal',
  'hazy': 'char:hazy', 'foggy': 'char:hazy', 'blurry': 'char:hazy',
  'driving': 'char:driving', 'propulsive': 'char:driving', 'motorik': 'char:driving',
  'angular': 'char:angular', 'choppy': 'char:angular', 'jerky': 'char:angular',
  'eccentric': 'char:eccentric', 'odd': 'char:eccentric', 'peculiar': 'char:eccentric',
  'confessional': 'char:confessional', 'diary': 'char:confessional',
  'existential': 'char:existential', 'philosophical': 'char:existential',
  'duet': 'char:duet', 'two voices': 'char:duet',
  'wes anderson': 'char:wes-anderson', 'wes anderson-y': 'char:wes-anderson', 'wes andersony': 'char:wes-anderson',
  'vocal harmony': 'char:vocal-harmony', 'harmonies': 'char:vocal-harmony', 'harmonized': 'char:vocal-harmony',
  'slow burn': 'char:slow-burn', 'slow-burn': 'char:slow-burn', 'builds': 'char:slow-burn',
  'abstract': 'char:abstract',
  'cool': 'char:cool',
  // New genre aliases
  'dream pop': 'genre:dream-pop', 'dreamy pop': 'genre:dream-pop',
  'yacht rock': 'genre:yacht-rock', 'soft rock': 'genre:yacht-rock', 'adult contemporary': 'genre:yacht-rock',
  'anti-folk': 'genre:anti-folk', 'antifolk': 'genre:anti-folk',
  'chamber folk': 'genre:chamber-folk', 'chamber-folk': 'genre:chamber-folk',
  'chamber pop': 'genre:chamber-pop',
  'blues rock': 'genre:blues-rock', 'blues-rock': 'genre:blues-rock',
  'indie rock': 'genre:indie-rock', 'indie-rock': 'genre:indie-rock',
  'indie folk': 'genre:indie-folk', 'indie-folk': 'genre:indie-folk',
  'baroque pop': 'genre:baroque-pop', 'baroque-pop': 'genre:baroque-pop',
  'ye-ye': 'genre:ye-ye', 'ye ye': 'genre:ye-ye', 'yé-yé': 'genre:ye-ye', 'french pop': 'genre:ye-ye',
  'synth pop': 'genre:synth-pop', 'synth-pop': 'genre:synth-pop', 'synthpop': 'genre:synth-pop',
  'new wave': 'genre:new-wave', 'new-wave': 'genre:new-wave',
  'glam': 'genre:glam', 'glam rock': 'genre:glam',
  'lo-fi folk': 'genre:lo-fi-folk', 'lo fi folk': 'genre:lo-fi-folk',

  // Origin / Country — maps to origin: traits in songs.json
  'american': 'origin:us', 'us': 'origin:us', 'usa': 'origin:us',
  'british': 'origin:uk', 'uk': 'origin:uk', 'english': 'origin:uk',
  'french': 'origin:france', 'france': 'origin:france',
  'german': 'origin:germany', 'germany': 'origin:germany', 'kraut': 'origin:germany',
  'swedish': 'origin:sweden', 'sweden': 'origin:sweden', 'scandinavian': 'origin:sweden',
  'japanese': 'origin:japan', 'japan': 'origin:japan',
  'korean': 'origin:korea', 'korea': 'origin:korea', 'k-pop': 'origin:korea', 'kpop': 'origin:korea',
  'brazilian': 'origin:brazil', 'brazil': 'origin:brazil', 'tropicália': 'origin:brazil',
  'nigerian': 'origin:nigeria', 'nigeria': 'origin:nigeria',
  'african': 'genre:afrobeat',  // "African music" → afrobeat is our best match
  'canadian': 'origin:canada', 'canada': 'origin:canada',
  'australian': 'origin:australia', 'australia': 'origin:australia',
  'norwegian': 'origin:norway', 'norway': 'origin:norway',
  'icelandic': 'origin:iceland', 'iceland': 'origin:iceland',
  'spanish': 'origin:spain', 'spain': 'origin:spain',
  'colombian': 'origin:colombia', 'colombian': 'origin:colombia',
  'jamaican': 'origin:jamaica', 'jamaica': 'origin:jamaica',
  'latino': 'genre:latin', 'latina': 'genre:latin', 'latin american': 'genre:latin',
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
      const matches = (term) => term.includes(':')
        ? traitId === term
        : (term.includes(traitLabel) || traitLabel.includes(term));
      if (butWeightOverrides.reduce && matches(butWeightOverrides.reduce)) {
        traitTargets.set(traitId, traitTargets.get(traitId) * 0.3);
      }
      if (butWeightOverrides.boost && matches(butWeightOverrides.boost)) {
        traitTargets.set(traitId, Math.min(traitTargets.get(traitId) * 1.5, 1.5));
      }
    }
  }

  // Identify "required" genre and origin targets — traits the user explicitly asked for.
  // If a song doesn't have ANY of the required genre/origin traits, it gets zeroed out.
  // This prevents "danceable hip-hop" from returning a danceable song with no hip-hop at all.
  const requiredGenreTargets = [...traitTargets.keys()].filter(t =>
    t.startsWith('genre:') || t.startsWith('origin:')
  );

  return songs.map(song => {
    const traits = song.traits || {};
    let score = 0;

    // Genre/origin hard gate: if user asked for specific genres/origins, the song
    // must satisfy each requested category (genre, origin) — but only needs to match
    // ONE trait value within a category, not every one. "Experimental hip-hop" requires
    // both categories present; "Brazilian jazz" requires origin:brazil AND genre:jazz.
    // But a broad ask like "international" or "Japanese" can expand into several
    // same-category values (multiple origins, or origin + several genre guesses) —
    // those are alternatives, not a simultaneous requirement. See matchesRequiredGenres.
    if (requiredGenreTargets.length > 0 && !matchesRequiredGenres(traits, requiredGenreTargets)) {
      return { ...song, score: 0 };
    }

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

// Given a set of keywords, return the genre/origin traits they contain (if any).
// Used to check if a genre was requested but nothing in the collection matches.
function extractRequiredGenres(keywords) {
  const required = [];
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase().trim();
    if (kwLower.startsWith('genre:') || kwLower.startsWith('origin:')) {
      required.push(kwLower);
    } else if (TRAIT_ALIASES[kwLower]) {
      const t = TRAIT_ALIASES[kwLower];
      if (t.startsWith('genre:') || t.startsWith('origin:')) required.push(t);
    }
  }
  return [...new Set(required)];
}

// Human-readable label for a genre/origin trait, for use in "I don't have X" messages.
function genreLabel(traitId) {
  const map = {
    'genre:hip-hop': 'hip-hop', 'genre:jazz': 'jazz', 'genre:electronic': 'electronic',
    'genre:folk': 'folk', 'genre:punk': 'punk', 'genre:soul': 'soul',
    'genre:funk': 'funk', 'genre:experimental': 'experimental', 'genre:ambient': 'ambient',
    'genre:dance': 'dance', 'genre:noise': 'noise', 'genre:r&b': 'R&B',
    'genre:afrobeat': 'afrobeat', 'genre:latin': 'latin', 'genre:country': 'country',
    'genre:psychedelic': 'psychedelic', 'genre:art-rock': 'art rock', 'genre:garage': 'garage',
    'genre:post-punk': 'post-punk', 'genre:krautrock': 'krautrock',
    'origin:us': 'American', 'origin:uk': 'British', 'origin:france': 'French',
    'origin:germany': 'German', 'origin:sweden': 'Swedish', 'origin:japan': 'Japanese',
    'origin:korea': 'Korean', 'origin:brazil': 'Brazilian', 'origin:nigeria': 'Nigerian',
    'origin:canada': 'Canadian', 'origin:australia': 'Australian',
    'origin:norway': 'Norwegian', 'origin:iceland': 'Icelandic',
    'origin:spain': 'Spanish', 'origin:colombia': 'Colombian', 'origin:jamaica': 'Jamaican',
  };
  return map[traitId] || traitId.replace(/^(genre|origin):/, '');
}

// Checks whether a song satisfies a set of required genre/origin traits.
// Traits are grouped by category (genre vs origin) and a song only needs to match
// AT LEAST ONE trait per category present, not every individual value — categories
// are ANDed together, values within a category are ORed. This lets "Brazilian jazz"
// correctly require origin:brazil AND genre:jazz together, while a broad request like
// "international" (which Haiku may expand into several origin: values) or "Japanese"
// (which may expand into origin:japan + multiple genre: guesses) doesn't demand a
// single song match every value within the same category at once.
function matchesRequiredGenres(traits, requiredGenres) {
  const byCategory = {};
  for (const t of requiredGenres) {
    const category = t.split(':')[0];
    (byCategory[category] || (byCategory[category] = [])).push(t);
  }
  return Object.values(byCategory).every(group => group.some(t => {
    if (traits[t] !== undefined && traits[t] >= 0.5) return true;
    // Equivalences — alternate ways a song can satisfy a genre requirement
    if (t === 'genre:dance' && traits['char:danceable'] >= 0.5) return true;
    if (t === 'genre:k-pop' && traits['origin:korea'] >= 0.5) return true;
    return false;
  }));
}

// Human-readable, capped list of genre/origin labels for "I don't have X" messages.
// Mirrors matchesRequiredGenres' grouping: values within a category (genre or origin)
// are alternatives ("or"), joined across categories as a requirement ("and") — so
// "Brazilian jazz" reads as "Brazilian and jazz", while a broad "international" request
// that expanded into many same-category origins reads as one capped "or" list instead
// of a dozen terms strung together.
function formatGenreLabelList(requiredGenres) {
  const byCategory = {};
  for (const t of requiredGenres) {
    const category = t.split(':')[0];
    (byCategory[category] || (byCategory[category] = [])).push(t);
  }
  const groups = Object.values(byCategory);
  const groupPhrases = groups.map(group => {
    const labels = group.map(genreLabel);
    let phrase;
    if (labels.length <= 3) {
      phrase = labels.length <= 1 ? labels[0] : labels.slice(0, -1).join(', ') + ' or ' + labels[labels.length - 1];
    } else {
      const remaining = labels.length - 3;
      phrase = `${labels.slice(0, 3).join(', ')}, or ${remaining} other${remaining > 1 ? 's' : ''} like that`;
    }
    return (groups.length > 1 && labels.length > 1) ? `(${phrase})` : phrase;
  });
  return groupPhrases.join(' and ');
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
const EXTRACT_KEYWORDS_SYSTEM = [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`You are a music search assistant. Convert any request — including moods, situations, metaphors, and feelings — into music trait keywords.

Return a JSON object: { "keywords": [...], "interpretation": "..." }

"keywords": 3–8 trait vocabulary terms or artist/song names (see vocabulary below).
"interpretation": include ONLY when the query uses abstract, situational, or concrete non-music words that required meaningful translation — things like "children singing", "library", "forest fire", "driving at 3am", "apocalypse". The value is a brief natural phrase that completes "here's something ___" (e.g. "playful and joyful", "dark and cinematic", "warm and nostalgic"). Set to null or omit for any straightforward genre, mood, artist, or era request ("sad songs", "some jazz", "80s pop", "something dark").

MAP TO THESE TRAIT VOCABULARY TERMS WHERE POSSIBLE:
Energy: "energy:high", "energy:low", "energy:hypnotic", "energy:chaotic"
Mood: "mood:melancholic", "mood:dark", "mood:joyful", "mood:tense", "mood:tender", "mood:defiant", "mood:dreamlike", "mood:playful", "mood:erotic", "mood:spiritual", "mood:bittersweet", "mood:yearning", "mood:defeated", "mood:cathartic", "mood:hypnotic", "mood:romantic", "mood:celebratory", "mood:resigned"
Texture: "texture:lo-fi", "texture:lush", "texture:sparse", "texture:noisy", "texture:warm", "texture:cold", "texture:psychedelic", "texture:cinematic", "texture:quiet"
Genre: "genre:punk", "genre:post-punk", "genre:garage", "genre:krautrock", "genre:electronic", "genre:hip-hop", "genre:soul", "genre:funk", "genre:folk", "genre:experimental", "genre:noise", "genre:ambient", "genre:dance", "genre:psychedelic", "genre:art-rock", "genre:afrobeat", "genre:r&b", "genre:jazz", "genre:country", "genre:latin", "genre:dream-pop", "genre:indie-rock", "genre:indie-folk", "genre:new-wave", "genre:synth-pop", "genre:yacht-rock", "genre:anti-folk", "genre:chamber-folk", "genre:chamber-pop", "genre:blues-rock", "genre:baroque-pop", "genre:ye-ye", "genre:glam", "genre:lo-fi-folk", "genre:k-pop"
Era: "era:50s", "era:60s", "era:70s", "era:80s", "era:90s", "era:00s", "era:modern"
Character: "char:outsider", "char:political", "char:intimate", "char:beautiful", "char:late-night", "char:danceable", "char:nostalgic", "char:weird", "char:heavy", "char:cinematic", "char:literate", "char:acoustic", "char:ethereal", "char:hazy", "char:driving", "char:angular", "char:eccentric", "char:narrative", "char:confessional", "char:existential", "char:duet", "char:vocal-harmony", "char:slow-burn", "char:sweet", "char:bittersweet", "char:cool", "char:abstract", "char:wes-anderson"
Origin (use when user specifies a country or region): "origin:us", "origin:uk", "origin:france", "origin:germany", "origin:sweden", "origin:japan", "origin:korea", "origin:brazil", "origin:nigeria", "origin:canada", "origin:australia", "origin:norway", "origin:iceland", "origin:spain", "origin:colombia", "origin:jamaica"

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
- "dream pop", "hazy", "gauzy", "floaty" → ["genre:dream-pop", "char:hazy", "char:ethereal"]
- "literate", "literary", "cerebral", "wordy", "intellectual" → ["char:literate"]
- "storytelling", "narrative" → ["char:narrative", "char:literate"]
- "driving", "motorik", "propulsive" → ["char:driving", "energy:high"]
- "yacht rock", "soft rock", "smooth" → ["genre:yacht-rock"]
- "wes anderson", "wes anderson-y" → ["char:wes-anderson", "char:nostalgic"]
- "harmonies", "vocal harmony" → ["char:vocal-harmony"]
- "french", "french pop", "ye-ye" → ["genre:ye-ye", "origin:france"]
- "bittersweet" → ["mood:bittersweet", "char:bittersweet"]
- "k-pop", "kpop", "korean pop" → ["genre:k-pop", "origin:korea"]

RULES:
- Prefer trait vocabulary terms over raw words whenever possible
- For artist names or song titles, return them as plain strings
- Return ONLY the JSON object, no preamble or explanation
- If the input is gibberish, a random string of characters, or clearly not a word in any language, return { "keywords": [] }. Do NOT return empty keywords for real words, genre names, mood words, artist names, or any legitimate request — even if it is very short or vague`
}];

async function extractKeywords(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 250,
    system: EXTRACT_KEYWORDS_SYSTEM,
    messages: [{ role: 'user', content: userMessage }]
  });
  try {
    const text = response.content[0].text.trim();
    // Try object format first
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const parsed = JSON.parse(objMatch[0]);
      const keywords = (parsed.keywords || []).map(k => k.toLowerCase().trim()).filter(k => k.length >= 2);
      return { keywords, interpretation: parsed.interpretation || null };
    }
    // Fallback: Haiku returned a plain array
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      return { keywords: JSON.parse(arrMatch[0]).map(k => k.toLowerCase().trim()).filter(k => k.length >= 2), interpretation: null };
    }
    return { keywords: [], interpretation: null };
  } catch (e) { console.log('Keyword parse error:', e.message); return { keywords: [], interpretation: null }; }
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

const EXTRACT_ARTIST_TRAITS_SYSTEM = [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`You are a music search assistant. Describe the sonic characteristics of a given artist using ONLY trait vocabulary terms from this list. Return ONLY a JSON array of 4–7 traits, no explanation.

Energy: "energy:high", "energy:low", "energy:hypnotic", "energy:chaotic"
Mood: "mood:melancholic", "mood:dark", "mood:joyful", "mood:tense", "mood:tender", "mood:defiant", "mood:dreamlike", "mood:playful", "mood:erotic", "mood:spiritual", "mood:bittersweet", "mood:yearning"
Texture: "texture:lo-fi", "texture:lush", "texture:sparse", "texture:noisy", "texture:warm", "texture:cold", "texture:psychedelic", "texture:cinematic", "texture:quiet"
Genre: "genre:punk", "genre:post-punk", "genre:garage", "genre:krautrock", "genre:electronic", "genre:hip-hop", "genre:soul", "genre:funk", "genre:folk", "genre:experimental", "genre:noise", "genre:ambient", "genre:dance", "genre:psychedelic", "genre:art-rock", "genre:afrobeat", "genre:r&b", "genre:jazz", "genre:country", "genre:latin", "genre:dream-pop", "genre:indie-rock", "genre:indie-folk", "genre:new-wave", "genre:synth-pop", "genre:yacht-rock", "genre:anti-folk", "genre:chamber-folk", "genre:chamber-pop", "genre:blues-rock", "genre:baroque-pop", "genre:ye-ye", "genre:glam"
Era: "era:50s", "era:60s", "era:70s", "era:80s", "era:90s", "era:00s", "era:modern"
Character: "char:outsider", "char:political", "char:intimate", "char:beautiful", "char:late-night", "char:danceable", "char:nostalgic", "char:weird", "char:heavy", "char:cinematic", "char:literate", "char:acoustic", "char:ethereal", "char:hazy", "char:driving", "char:angular", "char:eccentric", "char:narrative", "char:confessional", "char:existential", "char:vocal-harmony", "char:slow-burn", "char:sweet", "char:cool"
Origin: "origin:us", "origin:uk", "origin:france", "origin:germany", "origin:sweden", "origin:japan", "origin:korea", "origin:brazil", "origin:nigeria", "origin:canada", "origin:australia", "origin:norway", "origin:iceland"

Examples:
- "Nico" → ["texture:sparse", "mood:melancholic", "mood:dark", "genre:art-rock", "era:60s", "char:intimate"]
- "Portishead" → ["genre:electronic", "mood:melancholic", "mood:tense", "texture:cold", "char:late-night", "energy:low"]
- "Chet Baker" → ["genre:jazz", "mood:tender", "texture:sparse", "energy:low", "char:intimate", "char:late-night"]
- "Fela Kuti" → ["genre:afrobeat", "energy:high", "char:political", "mood:defiant", "texture:lush"]
- "Elliott Smith" → ["genre:indie-folk", "texture:sparse", "mood:melancholic", "char:intimate", "char:confessional", "char:sweet"]
- "Joanna Newsom" → ["genre:indie-folk", "char:literate", "char:eccentric", "texture:lush", "char:intimate", "era:modern"]

If you don't recognize the artist, return an empty array [].
Return ONLY the JSON array.`
}];

async function extractArtistTraits(artistName) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 200,
    system: EXTRACT_ARTIST_TRAITS_SYSTEM,
    messages: [{ role: 'user', content: `Artist: "${artistName}"` }]
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

About the site: There's a player toggle in the top bar — Spotify on the left, Apple Music on the right. Spotify is the default and only plays 30-second previews unless you're logged in. Apple Music plays full songs if you're signed in. Some songs aren't on either platform, or you specifically wanted to share a live performance or music video — in those cases you share a YouTube link instead. If someone asks about hearing full songs, switching players, or mentions Spotify or Apple Music, let them know about the toggle and explain the difference briefly.

Personality: Warm, direct, a little dry. Deep music knowledge — outsider, lo-fi, experimental, jazz, proto-punk, international. Never pretentious. You share because you genuinely love it, not to impress anyone.

Important: Don't mention this being a portfolio piece, case study, or that you're looking for work. It's just a project you made because you wanted to. Keep responses SHORT — 2-3 sentences max. Steer music-adjacent questions back toward asking what they want to hear. Plain text only, no markdown. NEVER invent or describe features that don't exist — if something doesn't work a certain way, just redirect to what you can do (play songs from your collection). NEVER say things like "that search isn't set up yet" or "that feature isn't available."`;

const EFRAIN_SYSTEM = [{ type: 'text', text: EFRAIN_CHARACTER, cache_control: { type: 'ephemeral' } }];

async function generateConversationalResponse(userMessage, lastSong) {
  const songContext = lastSong ? `The last song you shared was "${lastSong.title}" by ${lastSong.artist}.` : '';
  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 120,
    system: EFRAIN_SYSTEM,
    messages: [{ role: 'user', content: `${userMessage}${songContext ? '\n\n' + songContext : ''}` }]
  });
  return r.content[0].text;
}

// Deliberately NOT in Efrain's first-person voice — this is reference info, not a personal
// anecdote. Explicitly told to admit uncertainty rather than invent details, since a lot of
// this collection is genuinely obscure and Haiku's real knowledge of any given track may be thin.
// Returns structured JSON (hasMore/info) rather than prose so the caller can reliably tell
// "here's real info" apart from "nothing left" instead of regex-sniffing the wording —
// the "nothing left" case gets handled entirely differently (an Efrain-voice deflection,
// not another reference-note card), so this needs to be a hard signal, not a guess.
const SONG_INFO_SYSTEM = [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`Give brief, factual background on a song or artist — genre context, era, notable history, why it's known. Write in a neutral, informative voice, like a short reference note — NOT first person, NOT a personal anecdote or opinion.

Return a JSON object: { "hasMore": true/false, "info": "..." }
- "hasMore": true only if you have genuine, reliable facts to share that aren't already covered (see below). false if you don't have anything left that's both true and not already mentioned.
- "info": the factual text (1-3 sentences) when hasMore is true. Omit or leave empty when hasMore is false.

Rules:
- Be concise.
- Only state things you're confident are true — do NOT invent dates, chart positions, meanings, or backstory you're not sure about.
- No opinions, no "this is a great song" type commentary.
- Plain text only, no markdown.
- Return ONLY the JSON object, no preamble or explanation.`
}];

async function generateSongInfo(song, previousInfo = null) {
  const followUp = previousInfo
    ? `\n\nYou already told them this — every fact in it is off-limits to restate, including reworded: "${previousInfo}"\n\nThey're asking for more. Only set hasMore true if you have facts that are NOT already covered above, even partially or reworded — rephrasing something already said does not count as new.`
    : '';
  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 150,
    system: SONG_INFO_SYSTEM,
    messages: [{ role: 'user', content: `Song: "${song.title}" by ${song.artist}${song.year ? ` (${song.year})` : ''}${followUp}` }]
  });
  try {
    const text = r.content[0].text.trim();
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const parsed = JSON.parse(objMatch[0]);
      return { hasMore: !!parsed.hasMore, info: (parsed.info || '').trim() };
    }
    // Parse failure — fall back to showing the raw text rather than silently dropping it.
    return { hasMore: true, info: text };
  } catch (e) {
    console.log('Song info parse error:', e.message);
    return { hasMore: false, info: '' };
  }
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
    if (playedTitles.has(song.title)) continue;
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
  { label: 'British', trait: 'origin:uk' },
  { label: 'Brazilian', trait: 'origin:brazil' },
  { label: 'Japanese', trait: 'origin:japan' },
  { label: 'Swedish', trait: 'origin:sweden' },
  { label: 'German', trait: 'origin:germany' },
  { label: 'French', trait: 'origin:france' },
  { label: 'Korean', trait: 'origin:korea' },
];

function getDynamicOptions(justPlayedSong, playedTitles = new Set()) {
  const songTraits = justPlayedSong.traits || {};

  const contrasting = COLLECTION_TRAIT_OPTIONS.filter(opt => {
    // Skip if the last song already has this trait strongly
    if (songTraits[opt.trait] >= 0.7) return false;
    // Check if archive has enough unplayed songs with this trait
    const matchCount = songsData.songs.filter(s => {
      if (playedTitles.has(s.title)) return false;
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
  try {
    let favorites = [];
    if (fs.existsSync(favoritesPath)) favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf8'));
    favorites.push({ songTitle, artist, timestamp: new Date().toISOString() });
    fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
  } catch (e) {
    console.log('[FAVORITE]', JSON.stringify({ songTitle, artist, timestamp: new Date().toISOString() }));
  }
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
    system: EFRAIN_SYSTEM,
    messages: [{ role: 'user', content: `Visitor's favorite: "${userInput}"\n${matchContext}\n\n1-2 sentences MAX. React like a person, not a critic.` }]
  });
  return r.content[0].text;
}

// =====================
// REACTION DETECTION
// =====================

// Detects an explicit request for factual info about the CURRENTLY PLAYING song/artist —
// distinct from isMoreRequest ("give me a new song"). Requires an explicit object ("this
// song", "it", "the artist") so it never matches bare "tell me more" (which stays claimed by
// the existing session._pendingRelatedSong handler) or bare "more" (isMoreRequest below).
function isSongInfoRequest(msg) {
  return /\b(tell me (more )?about (this|that) (song|track|one|artist)\b|tell me (more )?about it\b|what'?s (this|that) (song|track)\s+about\b|what'?(s| is) the (story|history|background) (behind|with|of) (this|that)|more (info|information) (on|about) (this|that) (song|track|one|artist)|(background|history) (on|of|behind) (this|that) (song|track|one|artist))\b/i.test(msg);
}

function isMoreRequest(msg) {
  if (/\b(more|yes|another|again|keep going|similar|same vibe|like that|like this|something else|more please|more of that|yes more|love it|love this|keep it|that kind)\b/i.test(msg)) {
    return true;
  }
  // Explicit references to the last song ("the last song you played", "this song",
  // "that track") paired with an unambiguous continuation cue — "something like the
  // last song", "another one like this track". Deliberately excludes bare "more" here
  // so "tell me more about this song" (an info request, not a new-song request) doesn't
  // misfire — "more" alone is already covered by the check above for other phrasings.
  const referencesLastSong = /\b(last|previous)\s+(song|track|one)\b|\b(this|that)\s+(song|track|one)\b/i.test(msg);
  const continuationCue = /\b(like|similar|another|else)\b/i.test(msg);
  return referencesLastSong && continuationCue;
}

// Whether a message names any concrete musical descriptor (genre word or a meaningful
// trait alias) as opposed to vague phrasing with nothing to search on ("something else",
// "keep going"). Used to distinguish "we don't have that genre" (honest no-match) from
// "there was nothing to extract, this was probably about the last song" (fallback).
function hasMusicalDescriptor(message) {
  return [...GENRE_WORDS].some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message)) ||
    Object.keys(TRAIT_ALIASES).some(a => a.length >= 5 && new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message));
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
// =====================
// REACTION CLASSIFIER
// For short ambiguous messages when a last song exists.
// Returns: 'REACTION_POSITIVE' | 'REACTION_NEGATIVE' | 'SEARCH'
// Biased toward SEARCH — only returns a reaction classification when confident.
// =====================
const CLASSIFY_SYSTEM = [{ type: 'text', cache_control: { type: 'ephemeral' }, text:
`You classify short music chat messages. Given a message and the last song played, decide if the message is a reaction to the last song or a new search request.

REACTION_POSITIVE: clear positive feedback about the last song ("love this", "this is incredible", "obsessed", "what a tune", "this one's special")
REACTION_NEGATIVE: clear negative feedback about the last song ("not for me", "not feeling it", "this isn't working", "too slow for me")
SEARCH: anything requesting a different song, genre, mood, artist, or vibe — including vague ones

When in doubt, return SEARCH. Only return a reaction classification when the message is clearly about the last song and not asking for anything new.

Reply with exactly one of: REACTION_POSITIVE, REACTION_NEGATIVE, SEARCH`
}];

async function classifyShortMessage(message, lastSong) {
  const songContext = lastSong ? `The last song played was "${lastSong.title}" by ${lastSong.artist}.` : '';
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 10,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: `${songContext}\nMessage: "${message}"` }]
  });
  const result = response.content[0].text.trim().toUpperCase();
  if (result.includes('REACTION_POSITIVE')) return 'REACTION_POSITIVE';
  if (result.includes('REACTION_NEGATIVE')) return 'REACTION_NEGATIVE';
  return 'SEARCH';
}

// =====================
// HELPER: get streaming URLs for frontend
// Returns spotify and apple_music separately so frontend can pick based on user preference.
// YouTube is always returned as it's additive.
// =====================
function getSongUrl(song) {
  if (!song.streaming) return '';
  return song.streaming.spotify || song.streaming.youtube || song.streaming.apple_music || '';
}

function getStreamingUrls(song) {
  const s = song.streaming || {};
  return {
    spotify:     s.spotify     || '',
    apple_music: s.apple_music || '',
    youtube:     s.youtube     || '',
  };
}

// =====================
// SONG RESPONSE BUILDER
// =====================
function buildSongResponse(song, session, interrupt = null, bridge = null, preface = null) {
  session.playedSongs.add(song.title);
  session.lastSong = song;
  session.lastSongTraits = song.traits || {};
  session.lastSongArtist = song.artist;
  session.songCount++;
  // A real new song is being served — any "continue the info thread" state is now stale.
  session._infoThreadActive = false;
  session._infoExhaustedFor = null;

  let int = interrupt;
  if (!int) {
    const bridgeMatch = findBridge(song, null);
    if (bridgeMatch) {
      const bridgeDest = songsData.songs.find(s =>
        normalize(s.title) === normalize(bridgeMatch.to) &&
        normalize(s.artist) === normalize(bridgeMatch.toArtist) &&
        !session.playedSongs.has(s.title)
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

  // Check if this song is a groove keystone — if so, attach groove metadata.
  // The frontend uses this to play the cluster audio transmission before showing the embed.
  const keystoneKey = `${normalize(song.title)}|||${normalize(song.artist)}`;
  const keystoneConfig = KEYSTONE_LOOKUP.get(keystoneKey);
  const groove = keystoneConfig ? {
    cluster:  keystoneConfig.cluster,
    label:    keystoneConfig.label,
    audio:    keystoneConfig.audio,
  } : null;

  return {
    response: groove ? null : (song.commentary || null), // keystones carry no commentary — the audio transmission speaks for itself
    preface: preface || null,
    bridgingResponse: bridge,
    song: {
      title:        song.title,
      artist:       song.artist,
      spotify_url:  getSongUrl(song), // legacy field — still used as fallback
      apple_music_url: getStreamingUrls(song).apple_music,
      youtube_url:     getStreamingUrls(song).youtube,
      tag_title:    song.tag_title || '',
      tag_url:      song.tag_url   || '',
      cluster:      song.cluster   || null,
    },
    groove,   // null for normal songs, populated for keystone unlocks
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

    if (collectionMatch && session.playedSongs.has(collectionMatch.match.title)) {
      const responseText = await generateFavoriteResponse(input, { match: collectionMatch.match, alreadyPlayed: true });
      return res.json({ response: responseText, song: null });
    }

    const responseText = await generateFavoriteResponse(input, collectionMatch);
    let song = null;
    if (collectionMatch && !session.playedSongs.has(collectionMatch.match.title)) {
      const s = collectionMatch.match;
      session.playedSongs.add(s.title);
      session.lastSong = s;
      session.lastSongTraits = s.traits || {};
      session.lastSongArtist = s.artist;
      session.songCount++;
      song = { title: s.title, artist: s.artist, spotify_url: getSongUrl(s), apple_music_url: getStreamingUrls(s).apple_music, youtube_url: getStreamingUrls(s).youtube, tag_title: s.tag_title || '', tag_url: s.tag_url || '' };
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
    const {
      message, sessionId = 'default', unlockedClusters = [], clusterCounts = {}, pushCluster = null, playedSongTitles = [],
      lastSongTitle = null, lastSongArtist = null, lastSongInfoText = null, lastSongInfoExhausted = false,
    } = req.body;
    if (!message || !message.trim()) return res.json({ response: "Say something and I'll find you a song.", song: null });
    if (message.length > 500) return res.json({ response: "Keep it short — I just need a vibe, not an essay.", song: null });

    const session = getSession(sessionId, playedSongTitles);

    // Rehydrate last-song (and info-thread) context from the client when the in-memory
    // session doesn't have it (e.g. a cold/different serverless instance) but the client
    // already knows what it was just shown — keeps "tell me more about this song" working,
    // and keeps the "I'm tapped out on this one" offramp from resetting every request.
    if (!session.lastSong && lastSongTitle) {
      const hydrated = songsData.songs.find(s =>
        normalize(s.title) === normalize(lastSongTitle) &&
        (!lastSongArtist || normalize(s.artist) === normalize(lastSongArtist))
      );
      if (hydrated) {
        session.lastSong = hydrated;
        session.lastSongTraits = hydrated.traits || {};
        session.lastSongArtist = hydrated.artist;
        if (lastSongInfoExhausted) {
          session._infoExhaustedFor = hydrated.title;
        } else if (lastSongInfoText) {
          session._infoThreadActive = true;
          session._lastSongInfoText = lastSongInfoText;
        }
      }
    }

    // ── DEV COMMAND: /push C1 — force-serve a specific cluster's keystone ──
    if (pushCluster) {
      const keystone = GROOVE_KEYSTONES.find(k => k.cluster.toUpperCase() === pushCluster.toUpperCase());
      if (keystone) {
        const song = songsData.songs.find(s =>
          normalize(s.title) === normalize(keystone.title) &&
          normalize(s.artist) === normalize(keystone.artist)
        );
        if (song) return res.json(buildSongResponse(song, session));
      }
      return res.json({ response: `No keystone found for cluster ${pushCluster}.`, song: null });
    }

    // Helper: is this song a keystone that hasn't been unlocked yet?
    // If so, skip it — the frontend hasn't reached the threshold for that cluster.
    function isLockedKeystone(song) {
      const key = `${normalize(song.title)}|||${normalize(song.artist)}`;
      const kc = KEYSTONE_LOOKUP.get(key);
      if (!kc) return false; // not a keystone
      if (unlockedClusters.includes(kc.cluster)) return false; // already unlocked
      const count = clusterCounts[kc.cluster] || 0;
      return count < 3; // locked until 3 songs from that cluster have been played
    }

    if (session.playedSongs.size >= songsData.songs.length) {
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

    const available = () => songsData.songs.filter(s => !session.playedSongs.has(s.title) && !isLockedKeystone(s));

    const pickTopScoring = (pool) => {
      if (!pool.length) return null;
      const top = Math.max(...pool.map(s => s.score || 0));
      const picks = pool.filter(s => (s.score || 0) === top);
      return picks[Math.floor(Math.random() * picks.length)];
    };

    // Scores the collection against every trait of the last played song and returns a top
    // pick, excluding the same artist. Shared by every "more like this / keep going" entry
    // point — explicit phrase matches below, and the no-match fallback further down.
    const moreLikeLastSong = () => {
      if (!session.lastSongTraits) return null;
      const traitKeywords = Object.keys(session.lastSongTraits);
      const scored = scoreSongs(available(), traitKeywords).filter(s => s.score > 0);
      const diff = scored.filter(s => s.artist !== session.lastSongArtist);
      return pickTopScoring(diff.length ? diff : scored);
    };

    if (msgLower === 'keep this vibe' && session.lastSongTraits) {
      const song = moreLikeLastSong();
      if (song) return res.json(buildSongResponse(song, session));
    }

    if ((msgLower === 'okay' || msgLower === 'tell me more' || msgLower === 'play it') && session._pendingRelatedSong) {
      const related = songsData.songs.find(s => s.title === session._pendingRelatedSong);
      const bridgeText = session._pendingBridge || null;
      session._pendingRelatedSong = null;
      session._pendingBridge = null;
      if (related && !session.playedSongs.has(related.title)) {
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

    // Factual info about the current song — must run before isNegativeReaction/isAffirmation
    // so a dual-intent message ("I love this song, tell me more about it") gets BOTH a
    // reaction and the info, not just the reaction. Also must run before isMoreRequest
    // further below, since that treats bare "more" as "give me a new song" and would
    // otherwise misfire on "tell me more about this song".
    //
    // continuingInfoThread: if the PREVIOUS turn was itself an info reply, an ambiguous
    // follow-up ("tell me more", "go on" — anything that would otherwise trigger
    // isMoreRequest's "give me a new song" path) is read as continuing that thread instead.
    // Guarded by !hasMusicalDescriptor so naming an actual new genre/mood always wins, even
    // mid-thread. session._infoThreadActive is cleared the instant any new song is served
    // (in buildSongResponse), so this can't outlive exactly one follow-up turn.
    const continuingInfoThread = session._infoThreadActive
      && (isMoreRequest(message) || isSongInfoRequest(message))
      && !hasMusicalDescriptor(message);

    if ((isSongInfoRequest(message) || continuingInfoThread) && session.lastSong) {
      const s = session.lastSong;

      // Already told them we're tapped out on THIS song — don't re-run the Haiku call (risk
      // of restating or inventing something new just because it's being asked fresh again).
      if (session._infoExhaustedFor === s.title) {
        return res.json({ response: "Let's move on...", song: null, infoExhausted: true });
      }

      // Reaction is a zero-cost canned reply (no API call) — only one Haiku call happens
      // here regardless of whether praise is also present, rather than two round trips.
      let reaction = null;
      if (isAffirmation(message)) {
        const bridgeReplies = [
          `Yeah, ${s.title} is a good one.`,
          `Right? ${s.artist} doesn't miss.`,
          `Glad that one landed.`,
          `${s.title} holds up every time.`,
        ];
        reaction = bridgeReplies[Math.floor(Math.random() * bridgeReplies.length)];
      }
      const result = await generateSongInfo(s, continuingInfoThread ? session._lastSongInfoText : null);
      if (result.hasMore) {
        session._infoThreadActive = true;
        session._lastSongInfoText = result.info;
        return res.json({ response: reaction, songInfo: result.info, song: null });
      }
      // Nothing left to add — hand back to Efrain's own voice instead of printing another
      // reference-note card. Clears the thread so a follow-up "tell me more" reverts to its
      // normal meaning ("give me a new song") rather than asking the dry well again.
      session._infoThreadActive = false;
      session._infoExhaustedFor = s.title;
      const outOfInfoReplies = [
        { text: `That's about all I've got on ${s.title} — This isn't Wikipedia.`, linkWord: 'Wikipedia', linkUrl: 'https://www.wikipedia.org' },
        { text: `This isn't Google, my dude — open a new tab.`, linkWord: 'Google', linkUrl: 'https://www.google.com' },
        { text: "This is a musical journey through my collection, not Jeopardy, bud." },
        { text: `Pulled what I've got on ${s.title}. For the rest you'd want an actual encyclopedia.` },
        { text: "System's tapped out on facts for this one... but what other kind of song can I find you?" },
        { text: "That's the story, morning glory." },
      ];
      const chosen = outOfInfoReplies[Math.floor(Math.random() * outOfInfoReplies.length)];
      return res.json({
        response: reaction ? `${reaction} ${chosen.text}` : chosen.text,
        responseLink: chosen.linkWord ? { word: chosen.linkWord, url: chosen.linkUrl } : null,
        song: null,
        infoExhausted: true,
      });
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
      return res.json({ response: "There's a player toggle in the top bar — Spotify on the left plays 30-second previews, Apple Music on the right plays full songs if you're signed in. Flip it over and you'll hear the whole thing.", song: null });
    }

    if (/\bapple\s+music\b/i.test(message)) {
      return res.json({ response: "Apple Music is live — hit the toggle in the top bar to switch from Spotify. You'll get full songs if you're signed into Apple Music, versus 30-second previews on Spotify.", song: null });
    }

    if (/\b(switch\s+(to\s+)?(spotify|apple)|use\s+(spotify|apple)|change\s+(to\s+)?(spotify|apple)|want\s+(spotify|apple)|prefer\s+(spotify|apple)|play\s+on\s+(spotify|apple))\b/i.test(message)) {
      const toApple = /apple/i.test(message);
      return res.json({ response: toApple
        ? "Hit the Apple Music side of the toggle in the top bar — you'll get full tracks if you're signed in."
        : "Hit the Spotify side of the toggle in the top bar to switch back. You'll get 30-second previews unless you're logged in.",
        song: null });
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

    // ---- Haiku reaction classifier ----
    // Catches natural feedback ("love this song", "not really my thing", "obsessed")
    // that the regex checks above miss.
    // Conditions: message is short (≤8 words) AND last song exists AND doesn't look like a search.
    const wordCount = message.trim().split(/\s+/).length;
    const looksLikeSearch = (
      hasMusicalDescriptor(message) ||
      // Explicit search signal words
      /\b(something|anything|give me|play me|find me|another|more|different|instead|not\s+\w+|less\s+\w+|more\s+\w+)\b/i.test(message)
    );

    if (wordCount <= 8 && session.lastSong && !looksLikeSearch) {
      const classification = await classifyShortMessage(message, session.lastSong);
      if (classification === 'REACTION_POSITIVE') {
        const s = session.lastSong;
        const replies = [
          `Yeah, ${s.title} is a good one. What are you in the mood for next?`,
          `Right? ${s.artist} doesn't miss. What do you want to hear next?`,
          `Glad that one landed. What else are you feeling?`,
          `${s.title} holds up every time. What are you feeling next?`,
        ];
        return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
      }
      if (classification === 'REACTION_NEGATIVE') {
        const s = session.lastSong;
        const replies = [
          `Fair enough — ${s.artist} isn't for everyone. What are you in the mood for instead?`,
          `No worries. What direction do you want to go?`,
          `Got it. What would hit better right now?`,
        ];
        return res.json({ response: replies[Math.floor(Math.random() * replies.length)], song: null });
      }
      // SEARCH — fall through to keyword extraction
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
      const song = moreLikeLastSong();
      if (song) return res.json(buildSongResponse(song, session));
    }

    // Direct title request
    const playMeMatch = message.match(/^play(?:\s+me)?\s+(.+?)(?:\s+by\s+.+)?$/i);
    if (playMeMatch) {
      const requestedTitle = normalize(playMeMatch[1].trim());
      const exactSong = songsData.songs.find(s =>
        !session.playedSongs.has(s.title) &&
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
      const av = artistSongs.filter(s => !session.playedSongs.has(s.title));
      if (av.length) return res.json(buildSongResponse(av[Math.floor(Math.random() * av.length)], session));
    }

    // Strip common filler prefixes before keyword extraction
    // "something melancholic" → "melancholic", "give me something dark" → "dark"
    const strippedMessage = message
      .replace(/^(give\s+me\s+)?(something|anything|a\s+song|some\s+music|play\s+me\s+something)\s+(that'?s?\s+)?(kind\s+of\s+)?/i, '')
      .replace(/^(i\s+want\s+)(something|a\s+song)\s+/i, '')
      .trim() || message;

    // Keyword extraction (API call)
    const { keywords, interpretation } = await extractKeywords(strippedMessage);
    console.log('Keywords:', keywords, interpretation ? `| heard as: "${interpretation}"` : '');

    const preferVideo = isVideoRequest(message);
    const conversational = isConversational(message);
    const bridge = conversational ? "Okay, let me find something else." : null;

    // Generic continuation request — "another", "more of this", "keep going", etc.
    // If a song was just played, use its traits to find something similar.
    // Only truly random if nothing has been played yet.
    const bareGeneric = /^(another|random|surprise me|something different|something else|anything|more|more like this|more of this|keep going|keep it going|next|next one|yes|yeah|sure|okay|ok|sounds good|love it|i like this|similar|something similar|same vibe|same energy)$/i.test(msgLower.trim());

    if (bareGeneric) {
      const avSongs = available();
      if (!avSongs.length) return res.json({ response: "I've shared my entire collection with you! That's all I have for now.", song: null });

      // If we have a last song, use its traits to find something in the same vein.
      // Genre and origin traits get boosted — they should anchor the result,
      // not get outvoted by a cluster of mood/texture matches.
      if (session.lastSong) {
        const lastTraits = session.lastSong.traits || {};
        const traitKeywords = [];
        for (const [trait, weight] of Object.entries(lastTraits)) {
          if (weight < 0.7) continue;
          // Push genre and origin twice so they count double in scoring
          if (trait.startsWith('genre:') || trait.startsWith('origin:')) {
            traitKeywords.push(trait, trait);
          } else {
            traitKeywords.push(trait);
          }
        }
        if (traitKeywords.length > 0) {
          const scored = scoreSongs(avSongs, traitKeywords, false, null);
          const viable = scored.filter(s => s.score > 0);
          if (viable.length > 0) {
            const top = Math.max(...viable.map(s => s.score));
            const topPicks = viable.filter(s => s.score >= top * 0.85);
            return res.json(buildSongResponse(topPicks[Math.floor(Math.random() * topPicks.length)], session, null, bridge));
          }
        }
      }

      // No last song (or no traits matched) — fall back to random
      return res.json(buildSongResponse(avSongs[Math.floor(Math.random() * avSongs.length)], session, null, bridge));
    }

    // Build preface for queries that needed interpretation (abstract/situational)
    const preface = interpretation
      ? `Not sure I have anything specifically for "${strippedMessage}", but here's something ${interpretation}.`
      : null;

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
      const rawReduce = butMatch[1].trim().toLowerCase();
      const rawBoost  = butMatch[2].trim().toLowerCase();
      butWeightOverrides = {
        reduce: resolveButTerm(rawReduce) || rawReduce,
        boost:  resolveButTerm(rawBoost)  || rawBoost,
      };
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
        !session.playedSongs.has(s.title) &&
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

    // Genre/origin miss detection — if the user asked for a specific genre or country
    // and NOTHING in the collection has it, be honest and offer alternatives.
    // This runs before full scoring so we don't waste time and give the user a clear answer.
    const requestedGenres = extractRequiredGenres(keywords);
    if (requestedGenres.length > 0) {
      const collectionHasAny = songsData.songs.some(s => {
        const traits = s.traits || {};
        return requestedGenres.some(t => traits[t] !== undefined && traits[t] >= 0.5);
      });
      if (!collectionHasAny) {
        const labels = formatGenreLabelList(requestedGenres);
        const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
        const interrupt = genreOptions.length >= 2
          ? { type: 'genre_suggest', message: `I don't really have ${labels} in here. Try one of these instead.`, options: genreOptions }
          : null;
        return res.json({
          response: interrupt ? null : `I don't really have ${labels} in here. What else are you looking for?`,
          song: null, interrupt
        });
      }
      // Collection has the genre — check if the full combo (e.g. "danceable hip-hop") exists.
      // Use .some() with the genre gate logic instead of a full scoreSongs pass.
      const comboExists = songsData.songs.some(s => matchesRequiredGenres(s.traits || {}, requestedGenres));
      if (!comboExists) {
        const labels = formatGenreLabelList(requestedGenres);
        const genreOptions = getDynamicOptions(session.lastSong || songsData.songs[0], session.playedSongs);
        const interrupt = genreOptions.length >= 2
          ? { type: 'genre_suggest', message: `I don't think I have anything that's ${labels}. Try one of these instead.`, options: genreOptions }
          : null;
        return res.json({
          response: interrupt ? null : `Can't think of anything that fits all of that. What would you like to try?`,
          song: null, interrupt
        });
      }
    }

    const allScored = scoreSongs(songsData.songs, keywords, preferVideo, butWeightOverrides);
    const bestScore = Math.max(0, ...allScored.map(s => s.score));
    const hasAnyMatch = bestScore >= MIN_SCORE;

    if (!hasAnyMatch) {
      // Fallback: nothing scored, and the message doesn't name any concrete genre/mood —
      // Haiku had nothing to extract from, which is the signature of vague continuation
      // phrasing ("something else like this", "more of the last one") that isMoreRequest's
      // phrase list didn't happen to catch. Treat it as an implicit "more like the last
      // song" instead of a flat no-match. Gated tightly so a genuine "I don't have that
      // genre" request (which DOES name something concrete) still gets the honest reply.
      if (session.lastSongTraits && wordCount <= 10 && !hasMusicalDescriptor(message)) {
        const fallbackSong = moreLikeLastSong();
        if (fallbackSong) return res.json(buildSongResponse(fallbackSong, session));
      }

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

    const avTitleSet = new Set(available().map(s => s.title));
    const avScored = allScored.filter(s => avTitleSet.has(s.title));
    const avMatches = avScored.filter(s => s.score >= MIN_SCORE);

    if (!avMatches.length) {
      return res.json({ response: "Think I've played everything along those lines — is there another direction you want to go?", song: null });
    }

    // ── Keystone force-return ────────────────────────────────────────────────
    // After 3 plays from a cluster this session, the next song from that cluster
    // that would have been returned instead triggers its keystone.
    // This makes unlock deterministic — not dependent on scoring luck.
    const topMatchForKeystone = avMatches.reduce((best, s) => s.score > best.score ? s : best, avMatches[0]);
    if (topMatchForKeystone && topMatchForKeystone.cluster) {
      const cl          = topMatchForKeystone.cluster;
      const sessionCount = clusterCounts[cl] || 0;
      const isUnlocked  = unlockedClusters.includes(cl);
      const keystone    = GROOVE_KEYSTONES.find(k => k.cluster === cl);
      if (!isUnlocked && sessionCount >= 3 && keystone) {
        const keystoneSong = songsData.songs.find(s =>
          normalize(s.title)  === normalize(keystone.title) &&
          normalize(s.artist) === normalize(keystone.artist)
        );
        if (keystoneSong && !session.playedSongs.has(keystoneSong.title)) {
          return res.json(buildSongResponse(keystoneSong, session, null, bridge));
        }
      }
    }

    // ── 6-song fallback unlock ───────────────────────────────────────────────
    // If the user has received 6+ songs and still hasn't unlocked anything,
    // surface the keystone for whichever cluster they've played the most songs
    // from this session. Rewards actual listening behavior vs. random assignment.
    // Only fires once (after first unlock, unlockedClusters.length > 0 so this is skipped).
    if (session.songCount >= 6 && unlockedClusters.length === 0 && Object.keys(clusterCounts).length > 0) {
      const mostPlayedCluster = Object.entries(clusterCounts).reduce(
        (best, [cl, n]) => n > best[1] ? [cl, n] : best,
        ['', 0]
      )[0];
      const fallbackKeystone = mostPlayedCluster && GROOVE_KEYSTONES.find(k => k.cluster === mostPlayedCluster);
      if (fallbackKeystone) {
        const fallbackSong = songsData.songs.find(s =>
          normalize(s.title)  === normalize(fallbackKeystone.title) &&
          normalize(s.artist) === normalize(fallbackKeystone.artist)
        );
        if (fallbackSong && !session.playedSongs.has(fallbackSong.title)) {
          return res.json(buildSongResponse(fallbackSong, session, null, bridge));
        }
      }
    }
    // ── End keystone logic ───────────────────────────────────────────────────

    const top = Math.max(...avMatches.map(s => s.score));
    const topPicks = avMatches.filter(s => s.score >= top * 0.85); // top 15% range, not just exact top
    return res.json(buildSongResponse(topPicks[Math.floor(Math.random() * topPicks.length)], session, null, bridge, preface));

  } catch (error) {
    console.error('Error:', error);
    const isOverloaded = error?.status === 529 || error?.message?.includes('overloaded');
    if (isOverloaded) {
      res.status(529).json({ error: 'overloaded' });
    } else {
      res.status(500).json({ error: 'Something went wrong', details: error.message });
    }
  }
});

// =====================
// GROOVE GLOW KEYSTONES — public config for frontend
// Returns title/artist/cluster/label/audio so the frontend can track cluster membership
// =====================
app.get('/api/groove-keystones', (req, res) => {
  res.json(GROOVE_KEYSTONES.map(k => ({
    cluster: k.cluster,
    label:   k.label,
    title:   k.title,
    artist:  k.artist,
    audio:   k.audio,
  })));
});

// =====================
// GROOVE GLOW LOG + EMAIL NOTIFICATION
// Called by the frontend on each cluster unlock.
// Logs to stdout and sends an email via Resend with unlock details.
// =====================
app.post('/api/log', async (req, res) => {
  try {
    const { visitorId, cluster, label, input, firstSessionStart, allUnlocks } = req.body;
    const unlockedAt = new Date().toISOString();
    const entry = {
      visitorId:          visitorId || 'unknown',
      cluster,
      label,
      inputThatTriggered: input || '',
      unlockedAt,
      firstSessionStart:  firstSessionStart || null,
      totalUnlocks:       allUnlocks ? allUnlocks.length : 0,
      allUnlocks:         allUnlocks || [],
    };

    // Always log to stdout — visible in Render dashboard
    console.log('[GROOVE UNLOCK]', JSON.stringify(entry));

    // Send email via Resend if configured
    const resendKey   = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL;

    if (resendKey && notifyEmail) {
      const firstStart = firstSessionStart
        ? new Date(firstSessionStart).toLocaleString('en-US', { timeZone: 'America/New_York' })
        : 'unknown';
      const unlockedTime = new Date(unlockedAt).toLocaleString('en-US', { timeZone: 'America/New_York' });
      const allLabels = (allUnlocks || []).join(', ') || label;

      const html = `
        <p><strong>Visitor:</strong> ${entry.visitorId}</p>
        <p><strong>Cluster unlocked:</strong> ${label} (${cluster})</p>
        <p><strong>Triggered by:</strong> "${entry.inputThatTriggered}"</p>
        <p><strong>Unlocked at:</strong> ${unlockedTime} ET</p>
        <p><strong>First session start:</strong> ${firstStart} ET</p>
        <p><strong>Total unlocked so far:</strong> ${entry.totalUnlocks} / 9</p>
        <p><strong>All unlocked:</strong> ${allLabels}</p>
      `;

      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    'efrain.fm <onboarding@resend.dev>',
          to:      [notifyEmail],
          subject: `// ${label} unlocked — efrain.fm`,
          html,
        }),
      }).then(r => {
        if (!r.ok) r.text().then(t => console.error('Resend error:', t));
        else console.log('[RESEND] Email sent for', label);
      }).catch(e => console.error('Resend fetch error:', e));
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Log error:', e);
    res.json({ ok: false });
  }
});

// =====================
// INVOKE CLUSTER — zone selector direct cluster pick
// Picks a random commented song from the given cluster, bypassing trait scoring.
// Called when user taps an undiscovered zone on the groove map rock.
// =====================
app.post('/api/invoke-cluster', async (req, res) => {
  try {
    const { cluster, sessionId = 'default', clusterCounts = {}, unlockedClusters = [] } = req.body;
    if (!cluster) return res.json({ response: "No cluster specified.", song: null });

    const session = getSession(sessionId);

    // ── Keystone threshold check ─────────────────────────────────────────────
    // If this cluster has hit 3 plays and isn't unlocked yet, return the keystone.
    const sessionCount = clusterCounts[cluster] || 0;
    const isUnlocked   = unlockedClusters.includes(cluster);
    const keystone     = GROOVE_KEYSTONES.find(k => k.cluster === cluster);
    if (!isUnlocked && sessionCount >= 3 && keystone) {
      const keystoneSong = songsData.songs.find(s =>
        normalize(s.title)  === normalize(keystone.title) &&
        normalize(s.artist) === normalize(keystone.artist)
      );
      if (keystoneSong && !session.playedSongs.has(keystoneSong.title)) {
        return res.json(buildSongResponse(keystoneSong, session));
      }
    }
    // ── End keystone check ───────────────────────────────────────────────────

    // Prefer songs with commentary; fall back to any in cluster
    const withCommentary = songsData.songs.filter(s =>
      s.cluster === cluster &&
      !session.playedSongs.has(s.title) &&
      s.commentary && s.commentary.trim() !== ''
    );
    const fallback = songsData.songs.filter(s =>
      s.cluster === cluster &&
      !session.playedSongs.has(s.title)
    );

    const pool = withCommentary.length ? withCommentary : fallback;
    if (!pool.length) {
      return res.json({ response: "I've played everything from that zone.", song: null });
    }

    const song = pool[Math.floor(Math.random() * pool.length)];
    return res.json(buildSongResponse(song, session));
  } catch (e) {
    console.error('Invoke cluster error:', e);
    res.status(500).json({ response: "Something went wrong.", song: null });
  }
});

if (require.main === module) {
  app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

module.exports = app;
