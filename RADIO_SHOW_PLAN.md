# Radio show mode — build plan

A second mode for efrain.fm: a monthly, on-rails radio show. No free text. The listener
steps through a fixed order of songs and voice transmissions at their own pace.

Status key: `[ ]` to do · `[x]` done · **(open)** needs a decision

**Where the work lives:** branch `radio-show`. The project auto-commits and pushes at the end of every turn, and anything on `main` deploys to the live site, so unfinished show work stays on this branch until it is ready to merge.

## Status (2026-10-01)

Show mode is built and working locally on the `radio-show` branch, with placeholder content.

**How to get in while it is hidden**
- Address: `/show` or `/episode`
- Typed in the Explore text box: `/show` or `/episode`
- `/show-reset` in the text box forgets show progress and hides the toggle again (for testing the first-time flow)

**What is deliberately held back**
- The Explore/Show toggle is built but hidden from the public. It appears only in a browser that has already entered the show by address or command. To show it to everyone, set `SHOW_TOGGLE_PUBLIC = true` in the show section of `public/script.js`.
- The normal arrival flow is untouched: no show-or-explore question, no "new" marker.

**Placeholders to replace in `data/episodes/2026-10.json`**
- `intro`, `outro` (text to come from Efrain)
- Title is set: "Episode 01: It could be Franky", 54 minutes of music
- The four transmissions: after songs 4, 7, 10 and 14 (set by Efrain), all pointing at the welcome audio (`/audio/AIntro.m4a`) as a stand-in. Efrain is mixing the real ones over a music bed. Real files go in `public/audio/episodes/2026-10/`.

**Before going live:** replace the placeholders, review on the branch, then merge `radio-show` into `main`.

---

## What we settled

**Modes**
- Two modes on one page: **Explore** (today's chat) and **Show**. A toggle in the header switches between them.
- Toggling never resets either mode. Both stay alive on the page; one is hidden.
- `/show` opens the page with the show in front. The address updates when the toggle is used, so a reload stays in the same mode.
- Window, header, footer and star field are shared. Show mode hides the rings and the Grooves button.

**Show layout**
- Masthead under the header: edition ("October 2026"), show title, then an info line: `5 of 15 songs • 55 minutes • [service pill]`.
- Playlist: only items already reached, two lines per row (title, artist), cut off with an ellipsis. Transmissions are unnumbered rows with a mic icon. The current row is highlighted. Tapping any row loads it.
- Current item: one embed at a time. No "now playing" label.
- Footer: one button. Label names what comes next: "Next song", "Transmission from Efrain", and at the end the way into Explore.
- Desktop: playlist left (200px), current item right. Phones (768px and under): playlist stacked on top with a capped, scrollable height.
- Service pill: pink for Apple Music, green for Spotify. Tapping it asks the Spotify-or-Apple question in the footer (same component as today), then reloads the current song.

**Behaviour**
- Nothing is timed and nothing is locked. The listener always has the button.
- Transmissions use the existing voice message component and never autoplay.
- Leaving a mode switches off the embeds in it (the song restarts when you return). Our own audio pauses and resumes in place.
- Progress is saved in the browser per show. A new month starts fresh.
- The song count is songs only. Total duration is one number supplied per show.

**Arrival**
- First visit to `/`: "Start exploring" → welcome transmission → Spotify or Apple → new question: this month's show, or explore.
- First visit to `/show`: skips the welcome transmission. Spotify or Apple → show intro text → first song.
- Returning visitors land where the address says. A "new" marker sits on the Show toggle until they start the current show.
- End of show: closing text, then a button into Explore.

---

## How the data works

Show songs live in the main library (`data/songs.json`) like any other song, so they are
taggable, clustered, can carry a story, and turn up in Explore. The show file only lists
the order.

`data/episodes/2026-10.json`

```json
{
  "id": "2026-10",
  "edition": "October 2026",
  "title": "…",
  "duration_minutes": 55,
  "intro": "Text printed before the first song.",
  "outro": "Text printed after the last song.",
  "steps": [
    { "type": "song", "song_id": "0001" },
    { "type": "song", "song_id": "0718", "short_title": "Optional shorter title for the playlist row" },
    { "type": "transmission", "title": "Transmission 1", "audio": "/audio/episodes/2026-10/break-1.m4a" }
  ]
}
```

- The newest file in `data/episodes/` is the current show. Older files stay for a future archive.
- Title, artist and embed links are read from `songs.json` by `song_id`.
- The server checks every episode at startup. One with an unknown `song_id` is skipped with a loud log line (so Explore keeps working); a missing audio file is logged as a warning.
- Intro and outro appear as playlist rows ("Intro", "Sign-off") so listeners can go back to them.
- Show plays never count toward Groove unlocks or Explore's played-song list.

---

## Build steps

### 1. October content
- [x] Efrain sends the show details (see "What I need from you").
- [x] Match each song against `songs.json`; reuse the existing entry where there is one.
- [x] Add new songs from id `0718` up: title, artist, year, cluster, secondary cluster, traits, embed links, story.
- [x] Draft traits for new songs from the existing vocabulary; Efrain reviews.
- [x] Convert share links to embed links (Spotify and Apple Music).
- [ ] Add transmission audio to `public/audio/episodes/2026-10/` (folder exists; placeholders in use).
- [x] Write `data/episodes/2026-10.json`.

### 2. Server (`server.js`)
- [x] Load and validate `data/episodes/*.json` at startup.
- [x] `GET /api/show` — current show with each song's title, artist and links filled in.
- [x] `GET /show` — serves the same page as `/`.
- [x] Confirm `vercel.json` ships `data/episodes/` (it already includes `data/**`).

### 3. Show layout (`index.html`, `style.css`)
- [x] Add the show markup beside the chat container: masthead, playlist, current item.
- [x] Move the mock's styles into `style.css`.
- [x] Add the Explore/Show toggle to the header (hidden behind `SHOW_TOGGLE_PUBLIC` until launch).
- [x] Phone layout: stacked playlist with capped height.

### 4. Show behaviour (`script.js`)
- [x] Fetch the show and render the masthead, playlist and current item.
- [x] Footer button: advance, reveal the next row, label by what's next.
- [x] Row tap loads that item; keep the current row scrolled into view.
- [x] Intro text before the first song; outro text and Explore button at the end.
- [x] Save and restore progress (`show id`, furthest item reached, current item).
- [x] New show id clears old progress.

### 5. Switching modes
- [x] Mode class on the page; hide chat and text box in Show, hide show in Explore.
- [x] Update the address on toggle; respect it on load and on back/forward.
- [x] On leaving Show: switch off the current embed, pause a playing transmission.
- [x] On leaving Explore: switch off its embeds, pause its voice audio.
- [x] Background canvas: skip the rings in Show mode, keep the stars.
- [x] Hide the Grooves button in Show mode.
- [ ] "New" marker on the toggle for an unstarted show. *(held back until launch)*

### 6. Arrival
- [ ] After the Spotify-or-Apple question on a first visit to `/`, ask show or explore. *(held back until launch)*
- [x] First visit to `/show`: skip the welcome transmission, ask Spotify or Apple, start the show.

### 7. Service pill
- [x] Pill shows the current service with its colour.
- [x] Tap opens the footer question; the answer saves and reloads the current song.
- [x] If a song has no link for the chosen service, fall back to the other one.

### 8. Transmissions
- [x] Render with the existing voice component, without starting playback.
- [x] Stamp the title after it finishes, as the welcome transmission does.

### 9. Checks
- [x] Desktop and phone widths, both services.
- [x] Toggle back and forth mid-song and mid-transmission: places kept, nothing left playing.
- [x] Reload mid-show restores the place.
- [ ] First visit to `/`, first visit to `/show`, returning visit to each.
- [ ] Keyboard only: toggle, rows, pill, button. Visible focus. 44px touch targets on phones.
- [ ] Explore mode behaves exactly as before.

### 10. Ship
- [x] Delete `public/mock-show.html`.
- [x] Update `CLAUDE.md` with show mode and the monthly update steps.
- [ ] Commit, push, confirm the deploy.

---

## Open decisions

Each has a default I will build unless told otherwise.

1. ~~Show plays and Grooves.~~ Built as the default: playing a song in the show does not count toward ring unlocks, and does not stop Explore from recommending it later.
2. **Keystone songs in a show.** Keystones are withheld in Explore until unlocked. Default: a show may include one; it plays normally there and stays locked in Explore.
3. ~~Show-first visitors opening Explore.~~ Built: they get Explore's normal first-visit screen, with "Start exploring" and the welcome transmission.
4. ~~Intro and outro in the playlist.~~ Built as the default: each appears as a row once reached, so people can go back to them.
5. ~~Phones: where the embed sits.~~ Built as the default: anchored at the bottom, just above the button, so it is near the thumb.
6. ~~Edition wording.~~ Built as "October 2026".
7. ~~Cluster C10.~~ Resolved: C10 is the K-pop group; no October songs belong there.

---

## What I need from you

For the show:
- Title
- Intro text and outro text
- Total duration in minutes
- Transmission audio files, and after which song each one plays

For each song, in order:
- Title, artist, year
- Spotify link and Apple Music link (ordinary share links are fine)
- Cluster (or leave blank and I'll suggest one)
- Story, if it has one
- A shorter title for the playlist row, if the full one is long

---

## October show: song status

Order as supplied on 2026-10-01. All fifteen songs are in `data/songs.json` with both links (nine added 2026-10-01 as `0718`–`0726`, stories blank).

| # | Song | Status | Apple Music | Spotify |
|---|---|---|---|---|
| 1 | Men I Trust – Numb | In library `0229` | have | have |
| 2 | The Sons of Paradise – South Sea Island Magic (1936) | Added `0718` | `https://embed.music.apple.com/us/album/300352493?i=300352497` | `https://open.spotify.com/embed/track/6YsczPgpBVoz0bW4B2dpQK` |
| 3 | The Beach Boys – Wind Chimes (1967, Smiley Smile, mono mix) | Added `0719` | `https://embed.music.apple.com/us/album/1442864862?i=1442864878` | `https://open.spotify.com/embed/track/7t8W2MJodiseTtZR8lbp3H` |
| 4 | Triathalon – Hawaiian Boi (2014) | Added `0720` | `https://embed.music.apple.com/us/album/1666418964?i=1666418974` | `https://open.spotify.com/embed/track/47TGrct82IJs6kpQ7AsKCT` |
| 5 | Jeneba Kanneh-Mason – Theme from Samson and Delilah (arr. Nina Simone) (2026) | Added `0721` | `https://embed.music.apple.com/us/album/6799136365?i=6799136459` | `https://open.spotify.com/embed/track/6pphfcdaEUbRc4EuMCurNW` |
| 6 | Claire Huangci – Dreaming, Op. 15 No. 3 (Amy Beach) | Added `0722` | `https://embed.music.apple.com/us/album/1851371069?i=1851371351` | `https://open.spotify.com/embed/track/2RSaw76fPHOXNW48lFRjze` |
| 7 | Royal Philharmonic Orchestra – Arabesque No. 1 (Debussy) (2001) | Added `0723` | `https://embed.music.apple.com/us/album/arabesque-no-1-in-e-major-andantion-con-moto-berlin/1681525188?i=1681525203` (from Efrain) | `https://open.spotify.com/embed/track/6lrWXHnMIGqJ1q2j4i7cxI` |
| 8 | Philip Glass Ensemble – Einstein on the Beach: Knee Play 1 (3:52 recording) | Added `0724` | `https://embed.music.apple.com/us/album/347496489?i=347496505` | `https://open.spotify.com/embed/track/0HLNxZ4IwMMxJvGtz1xvWT` |
| 9 | Oneohtrix Point Never – Lifeworld (2025) | Added `0725` | `https://embed.music.apple.com/us/album/1840747238?i=1840747243` | `https://open.spotify.com/embed/track/5F7lkoriDmKyFQEjv3yzBg` |
| 10 | Jóhann Jóhannsson – The Radiant City | In library `0691` | have | have |
| 11 | Nico – These Days | In library `0253` | have | have |
| 12 | Moondog – Lullaby (2 W 46th Street) (1953) | Added `0726` | `https://embed.music.apple.com/us/album/1502671596?i=1502671614` | `https://open.spotify.com/embed/track/79g1aHmNJAADFeRhAfPAIv` |
| 13 | Vashti Bunyan – Diamond Day | In library `0406` | have | have |
| 14 | Big Star – The Ballad of El Goodo | In library `0673` | have | have |
| 15 | Dr. Dog – Say Something | In library `0122` | have | have |

Notes
- Spotify links are supplied by hand each month. Spotify's developer rules (changed Feb–Mar 2026) require the app owner to have Premium, which Efrain no longer has, so automatic Spotify lookup is not available. Apple Music links can still be looked up automatically.
- Year differences between the list and the library: The Radiant City (library 2005, list 2016), Say Something (library 2010, list 2005). Library left unchanged.
- New tags added with the October songs: `genre:classical`, `genre:opera`, `char:hawaiian`; `texture:piano` now has an alias. The canned "not much classical in here" replies were removed from `server.js`.
- Dreaming is listed as 2025 (both services date the release 2025). Knee Play 1 is the 3:52 recording, dated 1979.
- Still to supply: show title, intro and outro text, total minutes, transmission audio and positions.

---

## Each month after this

1. Add any new songs to `data/songs.json`.
2. Add transmission audio to `public/audio/episodes/<year-month>/`.
3. Add `data/episodes/<year-month>.json`.
4. Push. The newest show file becomes the current show.
