// =====================================================================
// enrich-tags.js  (v2 — with artist fallback)
// Fetches Last.fm tags for every song in songs.json and appends them
// to existing tags. Saves result as songs-enriched.json.
//
// Strategy:
//   1. Try track.getTopTags (exact song tags)
//   2. If no tags found, try artist.getTopTags (artist-level genre tags)
//   3. Cache artist tags so we only call Last.fm once per artist
//
// Usage:
//   node enrich-tags.js <YOUR_LASTFM_API_KEY>
// =====================================================================

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.argv[2];
const INPUT_FILE = path.join(__dirname, 'data', 'songs.json');
const OUTPUT_FILE = path.join(__dirname, 'data', 'songs-enriched.json');
const TOP_N_TAGS = 10;
const DELAY_MS = 250;

const BLOCKLIST = new Set([
  'seen live', 'under 2000 listeners', 'favorites', 'favourite', 'favorite',
  'albums i own', 'beautiful', 'amazing', 'awesome', 'great', 'good',
  'love', 'loved', 'cool', 'nice', 'best', 'classic',
  'all', 'clean', 'default', 'listen', 'music', 'song', 'songs', 'track',
  'recommended', 'spotify', 'lastfm', 'last.fm', 'youtube',
  '00s', '10s', '20s', '3star', '4star', '5star',
  'love at first listen', 'for a cigarette', 'best of 2012',
]);

if (!API_KEY) {
  console.error('Error: Missing Last.fm API key.\nUsage: node enrich-tags.js YOUR_API_KEY');
  process.exit(1);
}
if (!fs.existsSync(INPUT_FILE)) {
  console.error(`Error: Could not find ${INPUT_FILE}\nMake sure you run this from your my-music-project folder.`);
  process.exit(1);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    }).on('error', () => resolve({}));
  });
}

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ø/g, 'o').replace(/Ø/g, 'O');
}

function artistVariants(artist) {
  const variants = [artist];
  const stripped = stripAccents(artist);
  if (stripped !== artist) variants.push(stripped);
  const ampMatch = artist.match(/^(.+?)\s+[&]+\s+/);
  if (ampMatch) { variants.push(ampMatch[1].trim()); variants.push(stripAccents(ampMatch[1].trim())); }
  if (artist.startsWith('The ')) variants.push(artist.slice(4));
  return [...new Set(variants)];
}

function cleanTags(rawTags) {
  return rawTags
    .slice(0, TOP_N_TAGS)
    .map(t => t.name.toLowerCase().trim())
    .filter(t => t.length >= 2 && t.length <= 40 && !BLOCKLIST.has(t));
}

async function getTrackTags(artist, title) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=track.getTopTags&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&api_key=${API_KEY}&format=json&autocorrect=1`;
  const data = await httpsGet(url);
  if (data.error || !data.toptags?.tag?.length) return [];
  return cleanTags(data.toptags.tag);
}

async function getArtistTags(artist) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTags&artist=${encodeURIComponent(artist)}&api_key=${API_KEY}&format=json&autocorrect=1`;
  const data = await httpsGet(url);
  if (data.error || !data.toptags?.tag?.length) return [];
  return cleanTags(data.toptags.tag);
}

function mergeTags(existing, incoming) {
  const existingArr = Array.isArray(existing)
    ? existing.map(t => t.toString().toLowerCase().trim())
    : (existing || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const existingSet = new Set(existingArr);
  return [...existingArr, ...incoming.filter(t => !existingSet.has(t))];
}

async function main() {
  console.log('=== efrain.fm Last.fm Tag Enrichment (v2) ===\n');
  const raw = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const songs = raw.songs;
  console.log(`Loaded ${songs.length} songs`);
  console.log('Strategy: track tags → artist fallback → cache per artist\n');
  console.log('Running... (~3 min)\n');

  const artistTagCache = new Map();
  let fromTrack = 0, fromArtist = 0, notFound = 0;
  const enrichedSongs = [];

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    if (i % 10 === 0) {
      const pct = Math.round(((i+1)/songs.length)*100);
      process.stdout.write(`\r[${pct}%] ${i+1}/${songs.length} — track:${fromTrack} artist:${fromArtist} miss:${notFound}`);
    }

    const variants = artistVariants(song.artist);
    let newTags = [];

    // Pass 1: track tags
    for (const v of variants) {
      newTags = await getTrackTags(v, song.title);
      await delay(DELAY_MS);
      if (newTags.length) break;
    }

    if (newTags.length) {
      fromTrack++;
    } else {
      // Pass 2: artist tags (cached)
      const cacheKey = song.artist.toLowerCase();
      if (artistTagCache.has(cacheKey)) {
        newTags = artistTagCache.get(cacheKey);
      } else {
        for (const v of variants) {
          newTags = await getArtistTags(v);
          await delay(DELAY_MS);
          if (newTags.length) { artistTagCache.set(cacheKey, newTags); break; }
        }
        if (!newTags.length) artistTagCache.set(cacheKey, []);
      }
      if (newTags.length) { fromArtist++; } else { notFound++; }
    }

    enrichedSongs.push(newTags.length ? { ...song, tags: mergeTags(song.tags, newTags) } : { ...song });
  }

  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ songs: enrichedSongs }, null, 2), 'utf8');

  console.log('✓ Done!\n');
  console.log('─── Summary ─────────────────────────────────');
  console.log(`  Track-level tags:              ${fromTrack}`);
  console.log(`  Artist-level tags (fallback):  ${fromArtist}`);
  console.log(`  Not found on Last.fm:          ${notFound}`);
  console.log(`  Total enriched:                ${fromTrack + fromArtist} / ${songs.length}`);
  console.log('─────────────────────────────────────────────');
  console.log('\nSaved to: data/songs-enriched.json');
  console.log('\nWhen ready to apply:');
  console.log('  mv data/songs.json data/songs-backup.json');
  console.log('  mv data/songs-enriched.json data/songs.json');
  console.log('  node server.js');

  // Sample enrichments
  console.log('\n─── Sample enrichments ──────────────────────');
  const examples = enrichedSongs
    .filter(s => {
      const orig = songs.find(o => o.title === s.title && o.artist === s.artist);
      const origCount = Array.isArray(orig.tags) ? orig.tags.length : (orig.tags||'').split(',').filter(Boolean).length;
      return s.tags && s.tags.length > origCount;
    })
    .slice(0, 8);

  examples.forEach(s => {
    const orig = songs.find(o => o.title === s.title && o.artist === s.artist);
    const origTags = Array.isArray(orig.tags) ? orig.tags.map(t=>t.toLowerCase()) : (orig.tags||'').split(',').map(t=>t.trim().toLowerCase()).filter(Boolean);
    const added = s.tags.filter(t => !origTags.includes(t));
    console.log(`\n  ${s.title} – ${s.artist}`);
    console.log(`    Added: [${added.join(', ')}]`);
  });
}

main().catch(e => { console.error('\nFatal error:', e.message); process.exit(1); });
