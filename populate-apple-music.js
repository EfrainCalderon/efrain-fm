// populate-apple-music.js
// Hits the iTunes Search API for each song and populates apple_music embed URLs.
// Run from your project root: node populate-apple-music.js
// Safe to run multiple times — skips songs that already have an apple_music URL.
//
// How Apple Music embed URLs work:
// Search returns a trackViewUrl like:
//   https://music.apple.com/us/album/song-name/album-id?i=track-id
// The embed URL is:
//   https://embed.music.apple.com/us/album/album-id?i=track-id

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const SONGS_PATH  = path.join(__dirname, 'data', 'songs.json');
const DELAY_MS    = 120; // ~8 req/sec, well under iTunes rate limit
const COUNTRY     = 'us';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function buildEmbedUrl(trackViewUrl) {
  // Convert: https://music.apple.com/us/album/name/ALBUMID?i=TRACKID
  // To:      https://embed.music.apple.com/us/album/ALBUMID?i=TRACKID
  try {
    const url    = new URL(trackViewUrl);
    const parts  = url.pathname.split('/').filter(Boolean);
    // parts: ['us', 'album', 'album-name', 'album-id']
    const albumIdx = parts.indexOf('album');
    if (albumIdx === -1) return null;
    const albumId  = parts[albumIdx + 2]; // skip 'album-name'
    const trackId  = url.searchParams.get('i');
    if (!albumId || !trackId) return null;
    return `https://embed.music.apple.com/${COUNTRY}/album/${albumId}?i=${trackId}`;
  } catch (e) {
    return null;
  }
}

async function searchItunes(title, artist) {
  const query = encodeURIComponent(`${artist} ${title}`);
  const url   = `https://itunes.apple.com/search?term=${query}&entity=song&country=${COUNTRY}&limit=5`;

  try {
    const data = await httpsGet(url);
    if (!data.results || !data.results.length) return null;

    // Find the best match — exact title + artist match preferred
    const normTitle  = title.toLowerCase().trim();
    const normArtist = artist.toLowerCase().trim();

    const exact = data.results.find(r =>
      r.trackName?.toLowerCase().trim() === normTitle &&
      r.artistName?.toLowerCase().trim() === normArtist
    );

    const close = data.results.find(r =>
      r.trackName?.toLowerCase().includes(normTitle.slice(0, 8)) &&
      r.artistName?.toLowerCase().includes(normArtist.split(' ')[0].toLowerCase())
    );

    const result = exact || close || null;
    if (!result || !result.trackViewUrl) return null;
    return buildEmbedUrl(result.trackViewUrl);
  } catch (e) {
    return null;
  }
}

async function main() {
  const data  = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  const songs = data.songs;

  const toProcess = songs.filter(s => {
    const am = s.streaming?.apple_music;
    return !am || am.trim() === '';
  });

  console.log(`Total songs: ${songs.length}`);
  console.log(`Songs needing Apple Music URL: ${toProcess.length}`);
  console.log(`Estimated time: ~${Math.ceil(toProcess.length * DELAY_MS / 1000 / 60)} minutes\n`);

  let found = 0, notFound = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const song = toProcess[i];
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${song.artist} — ${song.title} ... `);

    const embedUrl = await searchItunes(song.title, song.artist);

    // Find and update in the main songs array
    const target = songs.find(s => s.id === song.id);
    if (target) {
      if (!target.streaming) target.streaming = {};
      target.streaming.apple_music = embedUrl || '';
    }

    if (embedUrl) {
      console.log(`✓`);
      found++;
    } else {
      console.log(`—`);
      notFound++;
    }

    // Save progress every 50 songs so you don't lose work if it's interrupted
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(SONGS_PATH, JSON.stringify(data, null, 2));
      console.log(`  [saved progress at ${i + 1} songs]\n`);
    }

    await sleep(DELAY_MS);
  }

  // Final save
  fs.writeFileSync(SONGS_PATH, JSON.stringify(data, null, 2));

  console.log(`\nDone.`);
  console.log(`  Found: ${found}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  songs.json updated.`);
}

main().catch(console.error);
