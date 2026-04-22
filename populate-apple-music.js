// populate-apple-music.js
// Run from project root: node populate-apple-music.js
// iTunes Search API hard limit: ~20 requests/minute.
// This script runs at one request every 3 seconds = 20/min.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const SONGS_PATH = path.join(__dirname, 'data', 'songs.json');
const DELAY_MS   = 3000; // 3s = 20 req/min, right at the documented limit
const COUNTRY    = 'us';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, data: null }); });
  });
}

function buildEmbedUrl(trackViewUrl) {
  try {
    const url      = new URL(trackViewUrl);
    const parts    = url.pathname.split('/').filter(Boolean);
    const albumIdx = parts.indexOf('album');
    if (albumIdx === -1) return null;
    const albumId  = parts[albumIdx + 2];
    const trackId  = url.searchParams.get('i');
    if (!albumId || !trackId) return null;
    return `https://embed.music.apple.com/${COUNTRY}/album/${albumId}?i=${trackId}`;
  } catch (e) { return null; }
}

function norm(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(result, title, artist) {
  const rTitle  = norm(result.trackName  || '');
  const rArtist = norm(result.artistName || '');
  const qTitle  = norm(title);
  const qArtist = norm(artist);
  let score = 0;
  if (rTitle === qTitle) score += 10;
  else if (rTitle.includes(qTitle) || qTitle.includes(rTitle)) score += 5;
  if (rArtist === qArtist) score += 8;
  else if (rArtist.includes(qArtist) || qArtist.includes(rArtist)) score += 4;
  else if (qArtist.split(' ')[0] && rArtist.includes(qArtist.split(' ')[0])) score += 2;
  return score;
}

function pickBest(results, title, artist) {
  const scored = results
    .map(r => ({ r, score: matchScore(r, title, artist) }))
    .filter(({ score }) => score >= 8)
    .sort((a, b) => b.score - a.score);
  if (scored.length && scored[0].r.trackViewUrl) {
    return buildEmbedUrl(scored[0].r.trackViewUrl);
  }
  return null;
}

async function searchItunes(title, artist) {
  const query = encodeURIComponent(`${artist} ${title}`);
  const url   = `https://itunes.apple.com/search?term=${query}&entity=song&country=${COUNTRY}&limit=10`;
  const { status, data } = await httpsGet(url);

  if (status === 403 || status === 429) {
    process.stdout.write(' [rate limited — waiting 60s]');
    await sleep(60000);
    const retry = await httpsGet(url);
    if (!retry.data?.results?.length) return null;
    return pickBest(retry.data.results, title, artist);
  }

  if (!data?.results?.length) return null;
  return pickBest(data.results, title, artist);
}

async function main() {
  const data  = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));
  const songs = data.songs;

  // Process songs with no URL OR empty string (catches previous rate-limited runs)
  const toProcess = songs.filter(s => {
    const am = s.streaming?.apple_music || '';
    return !am.includes('embed.music.apple.com');
  });

  const alreadyDone = songs.length - toProcess.length;
  const estMins = Math.ceil(toProcess.length * DELAY_MS / 1000 / 60);

  console.log(`Total songs:       ${songs.length}`);
  console.log(`Already have URL:  ${alreadyDone}`);
  console.log(`To process:        ${toProcess.length}`);
  console.log(`Est. time:         ~${estMins} minutes\n`);

  let found = 0, notFound = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const song = toProcess[i];
    process.stdout.write(`[${i + 1}/${toProcess.length}] ${song.artist} — ${song.title} ...`);

    const embedUrl = await searchItunes(song.title, song.artist);
    const target   = songs.find(s => s.id === song.id);
    if (target) {
      if (!target.streaming) target.streaming = {};
      target.streaming.apple_music = embedUrl || '';
    }

    if (embedUrl) { console.log(' ✓'); found++; }
    else { console.log(' —'); notFound++; }

    // Save every 25 songs so progress is never lost
    if ((i + 1) % 25 === 0) {
      fs.writeFileSync(SONGS_PATH, JSON.stringify(data, null, 2));
      console.log(`\n  [saved — ${alreadyDone + found} total URLs so far]\n`);
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(SONGS_PATH, JSON.stringify(data, null, 2));
  console.log(`\nDone.`);
  console.log(`  Found:     ${found}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Total with Apple Music URL: ${alreadyDone + found} / ${songs.length}`);
}

main().catch(console.error);
