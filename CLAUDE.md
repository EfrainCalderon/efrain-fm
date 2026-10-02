# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**efrain.fm** is a personal music site with two modes on one page:

- **Explore** — a chat interface. Visitors describe what they want to hear (moods, genres, artists, situations) and get a song from Efrain's curated collection with an embedded player.
- **Show** — a monthly on-rails episode: a fixed order of songs and spoken "transmissions", stepped through with one button. No free text.

Built with Express + vanilla JS + the Claude API (Haiku, for keyword extraction and conversational replies). No framework, no build step.

## Running and deploying

```bash
npm start          # runs server.js on port 3000 (or $PORT)
```

- Everything in `public/` is served as static files by the Express app. Use the `efrain-fm` entry in `.claude/launch.json` to preview.
- **The server reads `data/songs.json` and `data/episodes/*.json` once at startup.** Restart it after editing data or `server.js`; frontend files only need a page reload.
- **Hosting:** Vercel. `vercel.json` routes every request, including static files, through `server.js` as a Vercel Function. Functions have a documented 4.5 MB response cap, so keep any single served file (audio especially) under that.
- **Every turn auto-publishes.** A Stop hook in `.claude/settings.json` commits all changes and pushes to `main` at the end of each Claude turn, and `main` deploys to the live site. Never describe a change as local-only without checking `git status`. Do unfinished or risky work on a branch (the hook then commits there and nothing new reaches `main`), and merge when it is ready.
- After a change that matters, confirm it on the live site (`curl https://efrain.fm/...`) instead of assuming the deploy worked.

### Environment variables

| Variable | Used for | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | Haiku calls in `/api/chat`; commit messages (`scripts/commit-msg.js`) | `.env` locally, Vercel in production |
| `RESEND_API_KEY`, `NOTIFY_EMAIL` | Emailing listener notes from `/api/feedback` | Vercel only (not in the local `.env`) |

Without the two Resend variables, `/api/show` reports `notes: false` and the note form stays hidden, which is the normal state locally.

## Architecture

### Server (`server.js`)

A single Express app that loads all song and episode data into memory at startup and keeps chat sessions in memory keyed by `sessionId`. Because Vercel instances are stateless, the client mirrors session state and sends it with each request.

| Route | Purpose |
|---|---|
| `POST /api/chat` | Explore: one message in, one song (or reply) out. Rate-limited to 10/min per IP |
| `POST /api/invoke-cluster` | Play a song from a chosen Groove (from the Grooves window) |
| `POST /api/favorite` | A visitor names a favourite song; saves it, replies, and plays it if it is in the collection |
| `GET /api/groove-keystones` | Keystone list for the frontend |
| `POST /api/log` | Logs Groove unlocks to stdout (no email) |
| `GET /api/show` | The current episode with song details filled in, plus `notes` |
| `POST /api/feedback` | Listener note → email via Resend. 3 per 10 min per IP |
| `GET /show`, `GET /episode` | Serve the same page as `/`; the frontend opens in Show mode |

**Request pipeline for `/api/chat`:**
- Detect artist name mentions → look up by artist
- Detect "similar to [artist]" → use Haiku to infer traits
- Extract keywords via Haiku → map to trait IDs via `TRAIT_ALIASES`
- Score all songs by weighted trait sums (`scoreSongs`)
- Filter already-played songs and locked keystones
- Return the top-scoring song + commentary + streaming URLs + optional interrupt prompt

### Song data (`data/songs.json`)

`{ "songs": [...] }`, written with 2-space indentation and no trailing newline. Each song has:
- `id`: unique 4-digit string
- `traits`: trait IDs mapped to weights 0–1 (e.g. `"energy:high": 0.9`, `"genre:jazz": 1`)
- `streaming`: `{ spotify, apple_music, youtube }`, all embed URLs
- `cluster` and optional `cluster_secondary`: which Groove it belongs to
- `commentary`: Efrain's note, shown with the song in Explore (may be empty)
- `tag_title`, `tag_url`, `audio_story`: optional extras

### Trait system

The trait vocabulary is the central abstraction: natural language → `TRAIT_ALIASES` → trait IDs → scored against `song.traits`. Categories: `energy:`, `mood:`, `texture:`, `genre:`, `era:`, `char:`, `origin:`.

- `GENRE_WORDS` and `ARTIST_STOPWORDS` are guard sets: words that must never match song titles or artist names in raw text search.
- **Adding a new trait takes three edits**, or Explore can never reach it: tag the songs, add aliases to `TRAIT_ALIASES` (append at the end, since partial matching takes the first alias that fits), and list the trait in the two Haiku keyword prompts in `server.js`. Add a line to the prompt's "SITUATIONAL MAPPINGS" if Haiku should return only that trait.
- Scores are sums, so a request that maps to several traits can be won by a song matching the extras. Keep that in mind when a request returns a surprising song.
- `HARD_NO_MATCH` and `generateNoMatchResponse` hold canned refusals for genres the collection lacks. Remove an entry when songs of that kind are added.

### Grooves (Groove Glow)

Songs belong to clusters: C1 Outsider, C2 Night, C3 Raw, C4 Cosmic, C5 Soul, C6 Loss, C7 Art, C8 Memory, C9 Static. C1–C9 each have a hidden "keystone" song with a spoken audio file; C10 is a K-pop group with no keystone or label.

- Playing 3 non-keystone songs from a cluster unlocks its keystone. If nothing is unlocked after 4 songs in a session, the most-played cluster's keystone is surfaced.
- Keystones are identified by normalized `title|||artist` against `KEYSTONE_LOOKUP` and withheld until unlocked.
- State lives in `localStorage`. The Grooves button (icon + label) is always shown in Explore once past the first-visit screen.
- The background canvas draws 9 rings; unlocked clusters make inner rings glow. It talks to `script.js` through the `grooveRingUnlock` event and `window._grooveGlowCount`.

### Frontend (`public/script.js`, `index.html`, `style.css`)

- `sessionId` is generated per page load and sent with every API request.
- The Spotify/Apple choice persists in `localStorage` as `efrain_fm_player` (default Apple, whose previews are longer). Visitors change it by typing "switch to Spotify" / "switch to Apple Music" in Explore, or with the service pill in an episode. There is no player toggle in the header.
- **Spotify playback copy is conditional and hedged.** Spotify's embed plays full songs only when it can tell the listener is logged in, and Safari and phones are limited to 30-second previews; we can't detect a login. `spotifyPlaybackNote()` (client) and `describeSpotifyPlayback()` (server, by User-Agent) word this per browser and must stay in step. Don't write copy that says Spotify can never play full songs, or that promises it will.
- `isTyping` gates all input while the assistant is responding.
- Choices appear as buttons in the footer (`#interrupt-bar`), temporarily replacing the text input. The footer's height never changes.
- `addMessageToChatWithTyping` does the typewriter effect. `createVoiceEmbed` builds the voice-message player; see "Voice message player" below before changing it.
- **First-visit flow:** "Start exploring" → welcome audio (`public/audio/AIntro.m4a`) → Spotify / Apple Music / Something else → "explore or episode?" (`showModeChoice`).
- The header holds the logo, the Grooves button, and the **mode switch**: one button naming its destination, `EP. 01` (from the episode's `number`) in Explore and `Explore` in the episode.
- **Background canvas** (inline script in `index.html`): rings + star field, 24fps, paused when the tab is hidden. With `body.mode-show` it drops the disc and rings and adds inner stars that fade in from the centre.

### Show mode

The `initShow` IIFE at the end of `script.js`, markup in `#show-view`, styles under "SHOW MODE" in `style.css`. `RADIO_SHOW_PLAN.md` is the design record: why each decision was made.

- **Data:** `data/episodes/<year-month>.json` with `id`, `number`, `edition`, `title`, `duration_minutes`, `intro`, `outro`, and ordered `steps` (`song` by library `song_id`, or `transmission` with a `title` and `audio` path). The newest file name is the current episode. An episode with an unknown `song_id` is skipped at startup with an `EPISODE SKIPPED` log line, leaving the previous one current.
- **Audio:** `public/audio/episodes/<year-month>/`, AAC at 128 kbit/s to stay under the 4.5 MB cap.
- **Switching modes:** `body.mode-show` swaps the chat thread and text input for the show view. Neither mode is torn down, so each keeps its place. The address updates (`/show` ↔ `/`), and back/forward follow it.
- **One embed at a time.** Spotify and Apple embeds can't be paused from outside, so leaving a mode takes its iframes off the page (they restart on return). Our own `<audio>` is paused and resumed.
- **Transmissions** are voice messages with a control bar (see "Voice message player"). They autoplay when the listener arrives by a tap (footer button, playlist row, or entering the episode by a button), and never on a direct page load, since browsers block audio that starts without a tap. Moving to another item or to Explore pauses one and keeps its position; returning resumes it only if leaving is what paused it. A listener who paused it themselves finds it still paused.
- **Episode facts:** the masthead shows the total song count and total minutes ("15 songs • 64 min") from the start; it never counts up. `duration_minutes` is the whole episode, songs plus transmissions, measured with `episode-tools.js duration`.
- **Service pill:** neutral grey, icon then name; tapping it asks Spotify or Apple Music in the footer. There are two copies kept in step by `renderControls`: `#show-service-pill` in the masthead's info line on desktop, and `#show-service-pill-header`, centred in the header, on phones.
- **Phones:** the info line is hidden; its facts move into the playlist bar ("Playlist 15 songs • 64 min") and the pill moves to the header, which makes the masthead shorter. The playlist stacks above the current item and takes about a third of the screen. A bar above it (`#show-list-toggle`) folds it away or brings it back, and it folds itself when the final message is reached so there is room to read it and write a note. Desktop never folds; the CSS only honours `.list-collapsed` at phone widths.
- **Flow:** a spoken Introduction opens the episode. The Spotify-or-Apple question is asked only when a listener without a saved choice is about to reach the first song.
- **State:** progress is saved in `localStorage` as `efrain_fm_show_progress`, keyed by episode id and stored by position. Show plays never touch Groove counts or Explore's played list.
- **Final message (the end state):** the footer and its button are hidden there (`body.show-at-end`); the header's Explore button is the way on. The footer returns while the Spotify-or-Apple question is open, because that question lives in it. On a first visit the note form and then the support link fade in one after the other once the text has typed (`.show-reveal`); on a return visit they are simply there. In Show mode the star field hangs from the card's bottom edge, not the footer, so hiding the footer doesn't move it.
- **Listener notes:** a form under the final message (the episode's `outro`) posts to `/api/feedback`. Guards: rate limit, length caps, strict email pattern, honeypot field, plain-text email. Nothing typed is stored or rendered back.
- **Support link:** under the final message (after the note form, and still shown on the note-sent confirmation) is a plain link to Efrain's Buy Me a Coffee page (`SUPPORT_URL` in `initShow`), opened in a new tab. It is deliberately not their widget and appears nowhere else on the site.
- **Launch switch:** `SHOW_PUBLIC` in `initShow` (true since 2026-10-01). Set it to false to offer the episode only in browsers that have already entered Show mode.
- Text-box commands for testing: `/show` (enter), `/show-reset` (forget progress), plus `/reset`, `/push c1`–`c9`, `/groove-reset`, `/player`.

### Voice message player (`createVoiceEmbed`)

One component, two variants. Explore and Show share it, so a change here affects both.

| | Without `controls` | With `{ controls: true }` |
|---|---|---|
| Used by | Welcome message, Groove (keystone) messages | Episode Introduction and transmissions |
| Controls | One play button, shown before and after playback | Play/pause, draggable scrubber, current and total time |
| Waveform | Live bars from a Web Audio analyser, mirrored from the centre | The whole recording's shape, left to right, played part brighter |
| Audio path | `<audio>` routed through an `AudioContext` | Plain `<audio>` only |
| Methods on the element | `startPlayback()`, `stop()` | also `resume()`, `pause()` |

Rules for the control-bar variant. Each one fixed a real bug found on an iPhone, so keep them:

- **Never route its audio through Web Audio.** iOS silences an `AudioContext` when the screen locks or Safari is backgrounded. `initAudio()` is a no-op when `controls` is on, and the waveform comes from `loadPeaks()`, which decodes the file once with an `OfflineAudioContext` (that never touches the device's audio session).
- **We position the scrubber ourselves.** iPhone sliders only respond to dragging the thumb and ignore taps on the track, so `pointerdown` / `pointermove` / `pointerup` handlers set the position: press anywhere to jump, drag to scrub. The `<input type="range">` stays for semantics and arrow-key support.
- **The thumb is never driven by `audio.currentTime` during a drag or while a seek is landing** (`scrubRatio`, `pendingSeek`). On iOS `currentTime` reports the old position until the seek completes, and following it makes the thumb snap back under the finger.
- **The audio seeks on release**, not continuously; the time readout and waveform update during the drag.
- `touch-action: none` on the scrubber stops a drag from scrolling the page. The visible track is 4px; the touch area is 44px tall, and the thumb grows to 22px on touch screens.
- `MediaMetadata` (set in `initShow`) names the transmission on the lock screen.
- After `ended`, the title returns with its length stamped on (`[57s]`); pressing play restarts from the top and the label reads "replaying transmission".

The no-`controls` variant still uses the live analyser, so the welcome and Groove messages stop if an iPhone locks mid-message. Moving them to the control-bar variant would fix that.

### Design system

The type and spacing scales are documented in a comment at the top of the "SHOW MODE" section of `style.css` and apply site-wide. In short: text is 18 / 16 / 14 / 11-mono with emphasis from weight and colour; spacing is 4 / 8 / 12 / 16 / 24 with a 16px side gutter; colours come from the CSS variables in `:root`. Put new text and spacing on those scales.

- **Touch:** interactive elements get a 44px tap area, usually by an `::after` that extends past a smaller visible control (header buttons, service pill, player button). The iOS tap highlight is turned off site-wide (`-webkit-tap-highlight-color` on `html`), so every control needs its own pressed state.
- **Contrast:** `--text-secondary` only reaches about 3:1 on a highlighted row or filled control. Use `--show-muted-strong` there to stay at WCAG AA (4.5:1).
- **Header and footer are shared by both modes.** The header fits the logo plus two icon-and-label buttons on a 375px phone; the Grooves label drops below 360px.

## Verifying changes

- Use the preview for structure, state, and layout: read values with script, resize to phone width, check the console.
- **The preview pane is often hidden while Claude works, and a hidden page does not run animations or transitions.** Fades and entrance animations can look frozen or dim in screenshots; that is not a bug. Screenshots can also lag a state change by a moment.
- **Audio can't be heard.** Confirm playback by `audio.paused` and `currentTime` advancing, and say so.
- **iOS behaviour needs a real iPhone:** touch dragging, tap highlights, lock-screen playback, autoplay rules, and Safari's privacy prompts. Simulated pointer events and a phone-sized viewport are not proof. Ask Efrain to check, and say exactly what to try.
- After a deploy, request the live file or route and check for the change. The first response or two after a push can still be the old version.

## Publishing an episode

Use the **`new-episode` skill** (`.claude/skills/new-episode/`). It covers matching a song list against the library, getting links, tagging, audio, the episode file, checking, and publishing, and bundles `scripts/episode-tools.js` (`status`, `match`, `apple`, `spotify`, `vocab`, `check`, `duration`).

## Adding songs

Append to `data/songs.json` with the next free `id`, a `cluster`, weighted `traits` from the existing vocabulary, and embed URLs:

- Spotify: `https://open.spotify.com/embed/track/<track id>`, from the link Efrain supplies. There is no automatic Spotify lookup: its search API requires the app owner to have Premium.
- Apple Music: `https://embed.music.apple.com/us/album/<album id>?i=<track id>`. `episode-tools.js apple` searches Apple's public API; check the result is the right recording.

A keystone song must also be added to `GROOVE_KEYSTONES` in `server.js`, with its audio in `public/audio/`.

## Other scripts

- `scripts/commit-msg.js` — writes the auto-commit message with Haiku.
- `populate-apple-music.js` — fills in missing Apple Music embed URLs across the library.
- `update-sheet.js` — pushes data to a Google Sheet (needs the gitignored service account file). `songs.json` is the source of truth; nothing reads from the sheet.

## Secrets

This repo is public. Never hardcode API keys, client secrets, or tokens in any file; read them from the gitignored `.env` via `dotenv`, as `server.js` does. Service account key files must stay gitignored. Personal addresses belong in environment variables, not in code.

A Spotify client secret was once committed in a since-deleted helper script (`fetch-spotify-urls.js`). The Spotify app has been deleted, so the values in git history no longer work.

## Key invariants

- Explore and Show share one page, header, and footer. A change to shared styles or to `createVoiceEmbed` affects both.
- Keystone songs stay withheld in Explore until their cluster is unlocked; an episode may still include one.
- Haiku is used for keyword extraction, artist trait inference, short-message classification, and conversational replies. `EFRAIN_CHARACTER` sets the persona for all conversational replies.
- Nothing a visitor types is ever rendered back as HTML.
- The welcome recording (`public/audio/AIntro.m4a`) and the `EFRAIN_CHARACTER` prompt both describe how the site works: the two modes, how to switch players, and what Spotify and Apple Music can play. When that behaviour or its on-screen wording changes, update the prompt, and tell Efrain the recording may now be out of date, since only they can re-record it.
- Episode transmissions autoplay on a tap. This is only safe because Show mode keeps one item on screen at a time; if that ever changes, audio could overlap.
