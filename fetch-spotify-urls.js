const https = require('https');
const fs = require('fs');

const CLIENT_ID = '92530c9dcf164e4e9d7ff0fd0bf0c77a';
const CLIENT_SECRET = '6f1872ef0016466a9ee5abe0e85039e9';

async function getAccessToken() {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body = 'grant_type=client_credentials';
    const options = {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.access_token) resolve(parsed.access_token);
        else reject(new Error('No access token: ' + data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function searchSpotify(token, artist, title) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(`track:${title} artist:${artist}`);
    const options = {
      hostname: 'api.spotify.com',
      path: `/v1/search?q=${query}&type=track&limit=1`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const track = parsed.tracks?.items?.[0];
          if (track) {
            resolve(`https://open.spotify.com/embed/track/${track.id}`);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function main() {
  const data = JSON.parse(fs.readFileSync('songs_merged.json', 'utf8'));
  const songs = data.songs;

  // Only process songs missing a spotify URL and not already having youtube
  const toFetch = songs.filter(s => !s.streaming.spotify && !s.streaming.youtube);
  console.log(`Total songs: ${songs.length}`);
  console.log(`Need Spotify URL: ${toFetch.length}`);

  console.log('Getting Spotify token...');
  const token = await getAccessToken();
  console.log('Got token!\n');

  let found = 0;
  let notFound = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const song = toFetch[i];
    const url = await searchSpotify(token, song.artist, song.title);
    if (url) {
      song.streaming.spotify = url;
      found++;
      console.log(`[${i+1}/${toFetch.length}] FOUND: ${song.artist} - ${song.title}`);
    } else {
      notFound++;
      console.log(`[${i+1}/${toFetch.length}] NOT FOUND: ${song.artist} - ${song.title}`);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone! Found: ${found}, Not found: ${notFound}`);

  // Save updated file
  fs.writeFileSync('songs_merged.json', JSON.stringify(data, null, 2));
  console.log('Updated songs_merged.json saved.');

  // Also log anything still missing for manual lookup
  const stillMissing = songs.filter(s => !s.streaming.spotify && !s.streaming.youtube);
  if (stillMissing.length > 0) {
    console.log(`\nStill missing URLs (${stillMissing.length}) — may need manual lookup:`);
    stillMissing.forEach(s => console.log(`  ${s.id} ${s.artist} - ${s.title}`));
    fs.writeFileSync('missing-urls.txt', stillMissing.map(s => `${s.id}\t${s.artist}\t${s.title}`).join('\n'));
    console.log('Saved to missing-urls.txt');
  }
}

main().catch(console.error);
