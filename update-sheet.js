const { google } = require('googleapis');
const fs = require('fs');

const SHEET_ID = '1jE4iRSQeIXNtqAYcH2TZXBaOHBLPM-ckcxNWeXrAAwM';
const SHEET_TAB = 'music-database-template';
const CREDS_FILE = './music-sheet-updater-0dde996d74c6.json';

async function main() {
  // Load credentials
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Read current sheet data
  console.log('Reading sheet...');
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:K`,
  });

  const rows = response.data.values;
  console.log(`Found ${rows.length - 1} songs`);

  // Read the CSV results
  console.log('Reading spotify-results.csv...');
  const csv = fs.readFileSync('./spotify-results.csv', 'utf8');
  const csvLines = csv.split('\n').slice(1); // skip header

  const updates = [];

  for (let i = 0; i < csvLines.length; i++) {
    const line = csvLines[i].trim();
    if (!line) continue;

    // Parse CSV line
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') inQuotes = !inQuotes;
      else if (line[c] === ',' && !inQuotes) { cols.push(current); current = ''; }
      else current += line[c];
    }
    cols.push(current);

    const mediaLink = cols[2] || '';
    const claudeNote = cols[3] || '';
    const rowNum = i + 2; // +2 because sheet is 1-indexed and has header

    // Only update if there's something to write
    if (mediaLink || claudeNote) {
      updates.push({
        range: `${SHEET_TAB}!C${rowNum}:K${rowNum}`,
        values: [[mediaLink, '', '', '', '', '', '', '', claudeNote]],
      });
    }
  }

  console.log(`Preparing to update ${updates.length} rows...`);

  // Batch update in chunks of 100
  const chunkSize = 100;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk,
      },
    });
    console.log(`Updated rows ${i + 1} to ${Math.min(i + chunkSize, updates.length)}`);
  }

  console.log('\nDone! Your Google Sheet has been updated.');
}

main().catch(console.error);