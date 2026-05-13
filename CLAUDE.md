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
4. Exposes `/api/chat` (POST, rate-limited to 10 req/min), `/api/groove-keystones`, `/api/favorites`, `/api/groove-log`

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
9 clusters (C1–C9), each with a hidden "keystone" song. Playing enough non-keystone songs from a cluster unlocks its keystone. State persists in `localStorage`. The background canvas (`index.html` inline script) renders 9 animated rings; unlocked clusters cause inner rings to glow with a sweep animation. The canvas communicates with `script.js` via `window.dispatchEvent('grooveRingUnlock')` and `window.getGrooveGlowCount`.

### Frontend (`public/script.js`)
Vanilla JS, no framework. Key concerns:
- `sessionId` generated per page load, sent with every API request
- Player preference (Spotify vs Apple Music) persisted in `localStorage` under `efrain_fm_player`
- `isTyping` flag gates all user input while the assistant is responding
- Interrupt prompts (clickable option buttons) appear in the footer, replacing the text input temporarily
- `addMessageToChatWithTyping` handles the typewriter effect for assistant messages

### Background canvas (`public/index.html` inline `<script>`)
Fully self-contained canvas renderer for the animated rings + star field. Throttled to 24fps, paused when tab is hidden. Reads `--star-color` CSS variable for theming. Ring glow state is read from `window._grooveGlowCount`.

## Utility scripts

- `update-sheet.js` — syncs song data to/from Google Sheets (requires `music-sheet-updater-0dde996d74c6.json` service account credentials)
- `fetch-spotify-urls.js` — fetches Spotify embed URLs for songs
- `populate-apple-music.js` — populates Apple Music embed URLs

## Adding songs

Songs live in `data/songs.json`. Each song needs:
1. A unique `id` (4-digit string)
2. `traits` object with weighted trait IDs from the controlled vocabulary
3. `cluster` assignment (C1–C9), optionally `cluster_secondary`
4. `streaming` URLs (at minimum one of spotify/apple_music/youtube as embed URLs)

If a song is a keystone, it must be added to `GROOVE_KEYSTONES` in `server.js` and the corresponding audio file placed in `public/audio/`.

## Key invariants

- Keystone songs are withheld from recommendations until their cluster is unlocked. They are identified by normalized `title|||artist` lookup against `KEYSTONE_LOOKUP`.
- `GENRE_WORDS` and `ARTIST_STOPWORDS` are guard sets — words that should never match against song titles/artist names in raw text search.
- Claude Haiku is used for keyword extraction, artist trait inference, short-message classification, and conversational responses. The `EFRAIN_CHARACTER` system prompt establishes the persona used for all conversational responses.
- Rate limit: 10 requests/minute per IP on `/api/chat`.
