#!/usr/bin/env node
// Helper commands for publishing a new efrain.fm show episode.
// Run from anywhere; paths resolve from the repository root. No dependencies.
//
//   node .claude/skills/new-episode/scripts/episode-tools.js status
//   node .claude/skills/new-episode/scripts/episode-tools.js match <songs.txt | ->
//   node .claude/skills/new-episode/scripts/episode-tools.js apple "<artist>" "<title>"
//   node .claude/skills/new-episode/scripts/episode-tools.js spotify <track url or id> [...]
//   node .claude/skills/new-episode/scripts/episode-tools.js vocab
//   node .claude/skills/new-episode/scripts/episode-tools.js check <episode id, e.g. 2026-11>
//
// Only `apple` and `spotify` use the network. Nothing here writes to the project.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const EPISODES_DIR = path.join(ROOT, 'data', 'episodes');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Files are served through a Vercel Function, which documents a 4.5 MB response cap.
const AUDIO_HARD_LIMIT = 4.5 * 1024 * 1024;
const AUDIO_SOFT_LIMIT = 4.0 * 1024 * 1024;

const loadSongs = () => JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8')).songs;
const loadEpisodes = () => fs.readdirSync(EPISODES_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(EPISODES_DIR, f), 'utf8')) }))
  .sort((a, b) => a.file.localeCompare(b.file));

const norm = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const normArtist = s => norm(s).replace(/^the /, '');
const mmss = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
const hasSpotify = s => Boolean(s.streaming && s.streaming.spotify && s.streaming.spotify.includes('open.spotify.com'));
const hasApple = s => Boolean(s.streaming && s.streaming.apple_music);
const nextSongId = songs => String(Math.max(...songs.map(s => parseInt(s.id, 10))) + 1).padStart(4, '0');

// ── status ──────────────────────────────────────────────────────────────
function status() {
  const songs = loadSongs();
  const episodes = loadEpisodes();
  console.log(`Library: ${songs.length} songs. Next free song id: ${nextSongId(songs)}`);
  if (!episodes.length) {
    console.log('No episodes yet. The first one is number 1.');
    return;
  }
  for (const { file, data } of episodes) {
    const songCount = (data.steps || []).filter(s => s.type === 'song').length;
    console.log(`  ${file}  number ${data.number}  "${data.title}"  ${songCount} songs`);
  }
  const current = episodes[episodes.length - 1].data;
  const nextNumber = Math.max(...episodes.map(e => e.data.number || 0)) + 1;
  console.log(`Current episode (newest file): ${current.id}. Next episode number: ${nextNumber} → title prefix "Episode ${String(nextNumber).padStart(2, '0')}: "`);
}

// ── match ───────────────────────────────────────────────────────────────
// Input: one song per line as "Artist – Title" (en dash, em dash, or " - ").
// Leading numbering ("3." / "3)") and a trailing "(1967)" are ignored.
function parseSongLine(line) {
  let text = line.trim();
  if (!text || text.startsWith('#')) return null;
  text = text.replace(/^\d+\s*[.)]\s*/, '');
  let year = null;
  const yearMatch = text.match(/\((\d{4})\)\s*$/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    text = text.slice(0, yearMatch.index).trim();
  }
  const parts = text.split(/\s+[–—-]\s+/);
  if (parts.length < 2) return { raw: line.trim(), artist: '', title: text, year };
  return { raw: line.trim(), artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), year };
}

function match(source) {
  const input = source === '-' || !source ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(source), 'utf8');
  const songs = loadSongs();
  const wanted = input.split('\n').map(parseSongLine).filter(Boolean);
  let position = 0;
  let found = 0;

  for (const w of wanted) {
    position += 1;
    const t = norm(w.title);
    const a = normArtist(w.artist);
    const exact = songs.filter(s => norm(s.title) === t && normArtist(s.artist) === a);
    const loose = exact.length ? [] : songs.filter(s => {
      const st = norm(s.title);
      const sa = normArtist(s.artist);
      const titleClose = st === t || st.includes(t) || t.includes(st);
      const artistClose = !a || sa === a || sa.includes(a) || a.includes(sa);
      return titleClose && artistClose && st.length > 2;
    });
    const sameArtist = songs.filter(s => a && normArtist(s.artist) === a && !exact.includes(s) && !loose.includes(s));

    console.log(`\n${position}. ${w.artist} – ${w.title}${w.year ? ` (${w.year})` : ''}`);
    if (exact.length) {
      found += 1;
      for (const s of exact) {
        const yearNote = w.year && Number(s.year) !== w.year ? `  ⚠ library year is ${s.year}` : '';
        console.log(`   IN LIBRARY  ${s.id}  cluster ${s.cluster}/${s.cluster_secondary || '-'}  spotify:${hasSpotify(s) ? 'yes' : 'NO'}  apple:${hasApple(s) ? 'yes' : 'NO'}  story:${s.commentary ? 'yes' : 'no'}${yearNote}`);
      }
    } else if (loose.length) {
      console.log('   POSSIBLE MATCH (confirm it is the same recording before reusing):');
      for (const s of loose) console.log(`     ${s.id}  ${s.title} — ${s.artist} (${s.year})`);
    } else {
      console.log('   NEW — needs adding to data/songs.json');
    }
    if (sameArtist.length) {
      console.log(`   same artist, for tagging reference: ${sameArtist.slice(0, 5).map(s => `${s.id} ${s.title} [${s.cluster}]`).join('; ')}`);
    }
  }
  console.log(`\n${found} of ${wanted.length} already in the library. Next free song id: ${nextSongId(songs)}`);
}

// ── apple ───────────────────────────────────────────────────────────────
// Apple's public iTunes Search API. It can return the wrong recording (live takes,
// remasters, mono/stereo, re-recordings), so list candidates and let a person choose.
async function apple(artist, title) {
  if (!artist || !title) throw new Error('Usage: apple "<artist>" "<title>"');
  const term = encodeURIComponent(`${artist} ${title}`);
  const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&country=us&limit=8`);
  if (!res.ok) throw new Error(`iTunes search failed: HTTP ${res.status} (limit is about 20 requests a minute)`);
  const { results } = await res.json();
  if (!results.length) {
    console.log('No results. Try different wording, or ask Efrain for the Apple Music link. Apple sometimes misspells or re-credits artists.');
    return;
  }
  for (const r of results) {
    console.log(`${r.trackName} — ${r.artistName}`);
    console.log(`   ${r.collectionName} (${(r.releaseDate || '').slice(0, 4)})  ${mmss(r.trackTimeMillis)}`);
    console.log(`   https://embed.music.apple.com/us/album/${r.collectionId}?i=${r.trackId}`);
  }
}

// ── spotify ─────────────────────────────────────────────────────────────
// Spotify's search API is not available to this project (it requires the app owner to
// have Premium), so Efrain supplies the links. This confirms what each link points to
// by reading Spotify's public embed page, and prints the embed URL to store.
async function spotify(inputs) {
  if (!inputs.length) throw new Error('Usage: spotify <track url or id> [...]');
  for (const input of inputs) {
    const idMatch = input.match(/track\/([A-Za-z0-9]{22})/) || input.match(/^([A-Za-z0-9]{22})$/);
    if (!idMatch) {
      console.log(`${input}\n   ✗ not a Spotify track link or id`);
      continue;
    }
    const id = idMatch[1];
    const embedUrl = `https://open.spotify.com/embed/track/${id}`;
    try {
      const html = await (await fetch(embedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const data = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      const entity = data && JSON.parse(data[1]).props?.pageProps?.state?.data?.entity;
      if (!entity) throw new Error('could not read track details');
      const artists = (entity.artists || []).map(a => a.name).join(', ');
      const released = entity.releaseDate?.isoString?.slice(0, 4) || '?';
      console.log(`${entity.name} — ${artists}`);
      console.log(`   ${mmss(entity.duration || 0)}  released ${released}  playable:${entity.isPlayable}`);
      console.log(`   ${embedUrl}`);
    } catch (e) {
      console.log(`${embedUrl}\n   ✗ ${e.message}. Check the link by hand.`);
    }
  }
}

// ── vocab ───────────────────────────────────────────────────────────────
function vocab() {
  const songs = loadSongs();
  const counts = {};
  for (const s of songs) for (const k of Object.keys(s.traits || {})) counts[k] = (counts[k] || 0) + 1;
  const byCategory = {};
  for (const [trait, n] of Object.entries(counts)) {
    const [category, name] = trait.split(':');
    (byCategory[category] = byCategory[category] || []).push([name, n]);
  }
  console.log('Trait vocabulary in use (count of songs). Prefer existing tags; a new tag also');
  console.log('needs an alias in TRAIT_ALIASES and a mention in the keyword prompts in server.js.\n');
  for (const category of Object.keys(byCategory).sort()) {
    const list = byCategory[category].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}(${n})`).join(', ');
    console.log(`${category}: ${list}\n`);
  }
  const clusters = {};
  for (const s of songs) clusters[s.cluster] = (clusters[s.cluster] || 0) + 1;
  console.log('clusters: ' + Object.keys(clusters).sort((a, b) => a.slice(1) - b.slice(1)).map(c => `${c}(${clusters[c]})`).join(', '));
}

// ── check ───────────────────────────────────────────────────────────────
function check(target) {
  if (!target) throw new Error('Usage: check <episode id, e.g. 2026-11>');
  const file = target.endsWith('.json') ? path.resolve(target) : path.join(EPISODES_DIR, `${target}.json`);
  const errors = [];
  const warnings = [];
  const err = m => errors.push(m);
  const warn = m => warnings.push(m);

  if (!fs.existsSync(file)) throw new Error(`No episode file at ${path.relative(ROOT, file)}`);
  let ep;
  try {
    ep = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`);
  }

  const songs = loadSongs();
  const byId = new Map(songs.map(s => [s.id, s]));
  const expectedId = path.basename(file, '.json');
  const others = loadEpisodes().filter(e => e.file !== path.basename(file));

  if (!/^\d{4}-\d{2}$/.test(expectedId)) warn(`File name "${expectedId}" is not year-month (e.g. 2026-11). The newest file by name is the current episode.`);
  if (ep.id !== expectedId) err(`"id" is "${ep.id}" but the file is named ${expectedId}.json. They must match.`);
  if (!Number.isInteger(ep.number)) err('"number" must be a whole number. The header button shows it as "EP. 02".');
  else {
    const clash = others.find(e => e.data.number === ep.number);
    if (clash) err(`"number" ${ep.number} is already used by ${clash.file}.`);
    const highest = Math.max(0, ...others.map(e => e.data.number || 0));
    if (!clash && ep.number !== highest + 1) warn(`"number" is ${ep.number}; the next number after existing episodes would be ${highest + 1}.`);
    const padded = String(ep.number).padStart(2, '0');
    if (ep.title && !ep.title.includes(padded)) warn(`Title "${ep.title}" does not mention ${padded}.`);
  }
  for (const field of ['edition', 'title']) if (!ep[field]) err(`"${field}" is missing.`);
  if (!ep.duration_minutes) warn('"duration_minutes" is missing; the info line will omit it.');
  if (!ep.outro) warn('"outro" (sign-off text) is empty. The note form is shown under the sign-off.');
  if (/\[.*placeholder.*\]/i.test(`${ep.title} ${ep.intro} ${ep.outro}`)) warn('Placeholder text is still present in title, intro or outro.');

  const steps = Array.isArray(ep.steps) ? ep.steps : [];
  if (!steps.length) err('"steps" is empty.');
  if (!ep.intro && !(steps[0] && steps[0].type === 'transmission')) warn('There is no intro text and the first step is not a transmission, so the episode opens straight on a song.');

  const newer = others.filter(e => e.file.localeCompare(path.basename(file)) > 0);
  if (newer.length) warn(`${newer.map(e => e.file).join(', ')} sorts after this file, so this will NOT be the current episode.`);

  console.log(`${ep.title || '(no title)'}  ·  ${ep.edition || '(no edition)'}  ·  number ${ep.number}  ·  ${ep.duration_minutes || '?'} min\n`);

  const seen = new Set();
  let songNumber = 0;
  steps.forEach((step, i) => {
    if (step.type === 'song') {
      songNumber += 1;
      const song = byId.get(step.song_id);
      if (!song) {
        err(`Step ${i + 1}: song_id "${step.song_id}" is not in data/songs.json. The server would skip the whole episode.`);
        console.log(`${String(songNumber).padStart(2)}. ✗ unknown song_id ${step.song_id}`);
        return;
      }
      if (seen.has(step.song_id)) warn(`Song ${step.song_id} (${song.title}) appears more than once.`);
      seen.add(step.song_id);
      if (!hasSpotify(song)) warn(`${song.id} ${song.title}: no Spotify link. Spotify listeners will get the Apple Music embed.`);
      if (!hasApple(song)) warn(`${song.id} ${song.title}: no Apple Music link. Apple listeners will get the Spotify embed.`);
      if (!hasSpotify(song) && !hasApple(song)) err(`${song.id} ${song.title}: no Spotify or Apple Music link at all.`);
      if (!song.traits || !Object.keys(song.traits).length) warn(`${song.id} ${song.title}: no traits, so Explore can never recommend it.`);
      if (!/^C\d+$/.test(song.cluster || '')) warn(`${song.id} ${song.title}: no cluster.`);
      console.log(`${String(songNumber).padStart(2)}. ${song.title} — ${song.artist}  [${song.id}]${step.short_title ? `  (row shows: ${step.short_title})` : ''}`);
    } else if (step.type === 'transmission') {
      const label = step.title || 'Transmission';
      if (!step.audio) {
        err(`Step ${i + 1} (${label}): no "audio" path.`);
        console.log(`    — ${label}: ✗ no audio —`);
        return;
      }
      const audioPath = path.join(PUBLIC_DIR, step.audio);
      let note = '';
      if (!fs.existsSync(audioPath)) {
        err(`${label}: audio file not found at public${step.audio}`);
        note = '✗ file missing';
      } else {
        const size = fs.statSync(audioPath).size;
        note = `${(size / 1024 / 1024).toFixed(1)} MB`;
        if (size >= AUDIO_HARD_LIMIT) err(`${label}: ${note} is over the 4.5 MB cap for files served by the site. Re-export at a lower bitrate or shorten it.`);
        else if (size >= AUDIO_SOFT_LIMIT) warn(`${label}: ${note} is close to the 4.5 MB cap.`);
        if (!/\.(m4a|mp3)$/i.test(step.audio)) warn(`${label}: ${path.extname(step.audio)} is unusual; existing audio is .m4a (AAC).`);
      }
      if (step.placeholder) warn(`${label} is still marked as a placeholder.`);
      console.log(`    — ${label}: ${step.audio}  ${note} —`);
    } else {
      err(`Step ${i + 1}: unknown type "${step.type}" (use "song" or "transmission").`);
    }
  });

  console.log(`\n${songNumber} songs, ${steps.filter(s => s.type === 'transmission').length} transmissions.`);
  if (warnings.length) console.log('\nWarnings:\n' + warnings.map(w => `  ! ${w}`).join('\n'));
  if (errors.length) {
    console.log('\nErrors (fix before publishing):\n' + errors.map(e => `  ✗ ${e}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\nNo errors.');
  }
}

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'status') status();
    else if (command === 'match') match(args[0]);
    else if (command === 'apple') await apple(args[0], args[1]);
    else if (command === 'spotify') await spotify(args);
    else if (command === 'vocab') vocab();
    else if (command === 'check') check(args[0]);
    else {
      console.log('Commands: status | match <file or -> | apple "<artist>" "<title>" | spotify <url>... | vocab | check <episode id>');
      process.exitCode = command ? 1 : 0;
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  }
})();
