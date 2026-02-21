# efrain.fm — Product Roadmap

## Current State
- 432 songs, ~29 hours of music
- Chat-based discovery with Claude-powered keyword extraction
- Spotify embeds (30s preview / full play if logged in)
- Live at efrain.fm on Render
- Session-based played songs tracking

---

## Phase 3 — The Hidden Layer

The core concept: a second layer to the experience that most users won't know exists. Inspired by the discovery mechanics of *Immortality*. Cannot be reached by typing keywords like "unlock", "hidden", or "voice message" — only found organically.

### Voice Memo Unlocks
- 20 songs (to start) have a hidden voice note attached
- Voice notes trigger a full-screen takeover experience using Three.js audio visualization — reacts to the audio in real time via Web Audio API
- Song fades in slowly after the voice note ends, with a larger/different player treatment
- Once unlocked, a tracker appears showing X/20 unlocked
- After 5–6 searches without finding one, a one-time interrupt plays — letting the user know this layer exists. Does not repeat.

### Save Codes
- Old-school video game style save code generated per user
- Tracks progress toward unlocking all 20 voice notes
- No account needed

### Completion Reward
- Something unlocks when all 20 voice notes are found — a video or larger experience
- TBD on format

### Email Notifications
- A way for users to leave their email to be notified when new music or modules are added

### Revisit Unlocks
- A section or mode where users can replay voice notes they've already unlocked

### Audio/Video Hosting
- Host voice notes and any video content on Cloudflare R2 (free tier covers this easily)
- Reference files by URL in songs.json

---

## Phase 4 — Admin & Infrastructure

### Admin Panel
- Password-protected route at `/admin` — only accessible by Efrain
- Form to add/edit songs directly in the product — no manual JSON editing
- Fields: title, artist, Spotify URL, genre, mood, year, tags, commentary, audio story, tag title, tag URL
- Writes directly to database

### Database Migration
- Move songs.json to Supabase (free tier, Postgres)
- Enables admin panel writes without Render ephemeral filesystem issues
- Supabase UI available as backup for direct data editing/debugging

---

## Phase 5 — Discovery Quality

### Last.fm Tag Integration
- Pull crowd-sourced tags from Last.fm API for all 432 songs
- Free API, no rate limit issues at this volume
- Improves matching fidelity significantly — especially for niche/outsider/genre-specific queries

### Embedding-Based Matching (Longer Term)
- Move beyond keyword counting toward vector similarity
- Each song represented as a semantic fingerprint
- "Outsider" would land nowhere near Shuggie Otis, correctly near Hasil Adkins
- Would require a vector database (pgvector on Supabase, or Pinecone)

---

## Notes
- Keep Claude API calls lean — keyword extraction + occasional no-match response only
- Commentary prints as-is, no AI editing or paraphrasing
- Transition/confirmation phrases: brief, not schmaltzy
- Mobile support required for Three.js layer — keep scenes lightweight, consider device detection for fallback
