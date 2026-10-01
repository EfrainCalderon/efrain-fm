# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**efrain.fm** is a personal music discovery web app — a chat interface that recommends songs from a curated personal collection. Users describe what they want to hear (moods, genres, artists, situations) and the app responds with a song and an embedded player. Built with Express + Vanilla JS + Claude API (Haiku for keyword extraction and conversational responses).

## Running the server

```bash
npm start          # runs server.js on port 3000 (or $PORT)
```

There are no build steps, no bundler, no transpilation. Everything in `public/` is served as static files directly. Requires `ANTHROPIC_API_KEY` in `.env`.

## Architecture

### Server (`server.js`)
Single Express server that:
1. Serves static files from `public/`
2. Loads `data/songs.json` once at startup (all song data in memory)
3. Maintains in-memory chat sessions keyed by `sessionId`
4. Exposes `/api/chat` (POST, rate-limited to 10 req/min), `/api/groove-keystones`, `/api/favorites`, `/api/groove-log`, `/api/show`, `/api/feedback`
5. Serves the same page at `/show` and `/episode` (the frontend opens in show mode)

**Request pipeline for `/api/chat`:**
- Detect artist name mentions → look up by artist
- Detect "similar to [artist]" → use Claude Haiku to infer traits
- Extract keywords via Claude Haiku → map to trait IDs via `TRAIT_ALIASES`
- Score all songs using weighted trait sums (`scoreSongs`)
- Filter already-played songs, keystones (unless unlocked)
- Return top-scoring song + commentary + streaming URLs + optional interrupt prompt

### Song data (`data/songs.json`)
Each song has:
- `traits`: object mapping trait IDs (e.g. `"energy:high": 0.9`, `"genre:jazz": 1`) to float weights 0–1
- `streaming`: `{ spotify, apple_music, youtube }` — all embed URLs
- `cluster`: which of 9 "Groove" clusters it belongs to (C1–C9)
- `commentary`: personal note shown alongside the song

### Trait system
The trait vocabulary is the central abstraction. User natural language → `TRAIT_ALIASES` → trait IDs → scored against `song.traits`. Categories: `energy:`, `mood:`, `texture:`, `genre:`, `era:`, `char:`, `origin:`. `GENRE_WORDS` prevents genre words from matching song titles/artist names by text.

### Groove Glow system
9 clusters (C1–C9), each with a hidden "keystone" song. Playing 3 non-keystone songs from a cluster unlocks its keystone; if nothing is unlocked after 4 songs in a session, the most-played cluster's keystone is surfaced. The Grooves button (icon + label) is always shown in Explore once past the first-visit screen. State persists in `localStorage`. The background canvas (`index.html` inline script) renders 9 animated rings; unlocked clusters cause inner rings to glow with a sweep animation. The canvas communicates with `script.js` via `window.dispatchEvent('grooveRingUnlock')` and `window.getGrooveGlowCount`.

### Frontend (`public/script.js`)
Vanilla JS, no framework. Key concerns:
- `sessionId` generated per page load, sent with every API request
- Player preference (Spotify vs Apple Music) persisted in `localStorage` under `efrain_fm_player`
- `isTyping` flag gates all user input while the assistant is responding
- Interrupt prompts (clickable option buttons) appear in the footer, replacing the text input temporarily
- `addMessageToChatWithTyping` handles the typewriter effect for assistant messages

### Background canvas (`public/index.html` inline `<script>`)
Fully self-contained canvas renderer for the animated rings + star field. Throttled to 24fps, paused when tab is hidden. Reads `--star-color` CSS variable for theming. Ring glow state is read from `window._grooveGlowCount`. When `body` has `.mode-show` it draws stars only (no disc, no rings).

### Show mode (monthly episode)
A second, on-rails mode beside Explore: a fixed order of songs and voice transmissions stepped through with one footer button. No free text. Full design record and status in `RADIO_SHOW_PLAN.md`.

- **Data:** one file per episode in `data/episodes/<year-month>.json` listing ordered `steps` (`song` by library `song_id`, or `transmission` with an `audio` path), plus `edition`, `title`, `duration_minutes`, `intro`, `outro`. The newest file by id is the current episode. Songs must exist in `data/songs.json`; an episode with an unknown id is skipped at startup with an `EPISODE SKIPPED` log line.
- **Audio:** transmission files live in `public/audio/episodes/<year-month>/`.
- **Frontend:** the `initShow` IIFE at the end of `script.js`, markup in `#show-view`, styles under "SHOW MODE" in `style.css`. `body.mode-show` swaps the chat thread and text input for the show view; neither mode is torn down, so switching keeps both modes' progress.
- **Entry:** `/show` or `/episode` in the address bar, or the `/show` command in the text box. The header toggle is hidden unless `SHOW_TOGGLE_PUBLIC` is true or the browser has already entered show mode (`efrain_fm_show_unlocked`).
- **One embed at a time.** Spotify/Apple embeds can't be paused from outside, so leaving a mode takes its iframes off the page; our own `<audio>` is paused and resumed. Transmissions never autoplay in show mode.
- **State:** progress in `localStorage` under `efrain_fm_show_progress`, keyed by episode id (a new id starts fresh). Show plays do not touch Groove counts or Explore's played list.

- **Flow:** the first item is a spoken Introduction. The Spotify-or-Apple question is asked only when the listener is about to reach the first song embed, never on arrival.
- **Listener notes:** under the sign-off, a small form posts to `/api/feedback`, which emails the note to `NOTIFY_EMAIL` through Resend (`RESEND_API_KEY`), the same setup `/api/log` uses. Rate-limited (3 per 10 minutes per IP), length-capped, honeypot field, sent as plain text. Nothing a listener types is stored or rendered back. Without those two env vars the endpoint returns 503 and the form says the note couldn't be sent.

**Publishing a new episode:** add any new songs to `data/songs.json`, put transmission audio in `public/audio/episodes/<year-month>/`, add `data/episodes/<year-month>.json`, push.

## Utility scripts

- `update-sheet.js` — syncs song data to/from Google Sheets (requires `music-sheet-updater-0dde996d74c6.json` service account credentials)
- `populate-apple-music.js` — populates Apple Music embed URLs

## Adding songs

Songs live in `data/songs.json`. Each song needs:
1. A unique `id` (4-digit string)
2. `traits` object with weighted trait IDs from the controlled vocabulary
3. `cluster` assignment (C1–C9), optionally `cluster_secondary`
4. `streaming` URLs (at minimum one of spotify/apple_music/youtube as embed URLs)

If a song is a keystone, it must be added to `GROOVE_KEYSTONES` in `server.js` and the corresponding audio file placed in `public/audio/`.

Spotify links are added by hand: take the track ID from Spotify's "Copy song link" (the part after `/track/`) and save it as `https://open.spotify.com/embed/track/<track id>`. There is no script for this (see below).

## Secrets

This repo is public. Never hardcode API keys, client secrets, or tokens in any file — read them from the gitignored `.env` via `dotenv`, as `server.js` does. Service account key files (e.g. `music-sheet-updater-0dde996d74c6.json`) must stay gitignored.

**Record — Spotify secret cleanup (2026-10-01):** `fetch-spotify-urls.js`, a one-off helper for bulk-fetching Spotify embed URLs, had a Spotify client ID and client secret hardcoded and committed (Feb and Apr 2026), so they were publicly exposed. Nothing else in the project used them, and every song already had a Spotify or YouTube link, so the script and its leftover `missing-urls.txt` were removed (commit `eb42976`) rather than fixed. Efrain then deleted the Spotify developer app, which invalidated the credentials; the old values are still visible in git history but no longer work. A scan of the other tracked files and the git history found no other exposed secrets. If bulk Spotify lookups are ever needed again, create a new Spotify app and read its credentials from `.env`.

## Key invariants

- Keystone songs are withheld from recommendations until their cluster is unlocked. They are identified by normalized `title|||artist` lookup against `KEYSTONE_LOOKUP`.
- `GENRE_WORDS` and `ARTIST_STOPWORDS` are guard sets — words that should never match against song titles/artist names in raw text search.
- Claude Haiku is used for keyword extraction, artist trait inference, short-message classification, and conversational responses. The `EFRAIN_CHARACTER` system prompt establishes the persona used for all conversational responses.
- Rate limit: 10 requests/minute per IP on `/api/chat`.
