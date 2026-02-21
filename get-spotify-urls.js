const https = require('https');

const CLIENT_ID = '92530c9dcf164e4e9d7ff0fd0bf0c77a';
const CLIENT_SECRET = '6f1872ef0016466a9ee5abe0e85039e9';
const SHEET_ID = '1jE4iRSQeIXNtqAYcH2TZXBaOHBLPM-ckcxNWeXrAAwM';
const SHEET_GID = '2040021376';

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

async function fetchSheet() {
  return new Promise((resolve, reject) => {
    function followRedirects(currentUrl) {
      const urlObj = new URL(currentUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { 'User-Agent': 'Node.js' }
      };
      const req = https.request(options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          followRedirects(res.headers.location);
        } else {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }
      });
      req.on('error', reject);
      req.end();
    }
    followRedirects(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`);
  });
}

function parseCSV(csv) {
  const lines = csv.split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') inQuotes = !inQuotes;
      else if (line[c] === ',' && !inQuotes) { cols.push(current); current = ''; }
      else current += line[c];
    }
    cols.push(current);
    rows.push({ rowNum: i + 1, artist: cols[0], title: cols[1], mediaLink: cols[2] || '' });
  }
  return rows;
}

async function main() {
  console.log('Fetching sheet...');
  const csv = await fetchSheet();
  const rows = parseCSV(csv);
  console.log(`Found ${rows.length} songs`);

  console.log('Getting Spotify token...');
  const token = await getAccessToken();
  console.log('Got token!');

  const results = [];
  let found = 0;
  let skipped = 0;
  let notFound = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.mediaLink && row.mediaLink.trim() !== '') {
      console.log(`[${i+1}/${rows.length}] SKIP: ${row.artist} - ${row.title}`);
      results.push({ ...row, newLink: row.mediaLink, note: '' });
      skipped++;
      continue;
    }
    const url = await searchSpotify(token, row.artist, row.title);
    if (url) {
      console.log(`[${i+1}/${rows.length}] FOUND: ${row.artist} - ${row.title}`);
      results.push({ ...row, newLink: url, note: '' });
      found++;
    } else {
      console.log(`[${i+1}/${rows.length}] NOT FOUND: ${row.artist} - ${row.title}`);
      results.push({ ...row, newLink: '', note: 'Not found on Spotify' });
      notFound++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone! Found: ${found}, Skipped: ${skipped}, Not found: ${notFound}`);

  const fs = require('fs');
  let output = 'artist_name,title,media_link,claude_notes\n';
  for (const r of results) {
    const artist = `"${(r.artist||'').replace(/"/g,'""')}"`;
    const title = `"${(r.title||'').replace(/"/g,'""')}"`;
    const link = `"${(r.newLink||'').replace(/"/g,'""')}"`;
    const note = `"${(r.note||'').replace(/"/g,'""')}"`;
    output += `${artist},${title},${link},${note}\n`;
  }
  fs.writeFileSync('spotify-results.csv', output);
  console.log('\nSaved to spotify-results.csv!');
  console.log('Import this into your Google Sheet to update columns C and K.');
}

main().catch(console.error);