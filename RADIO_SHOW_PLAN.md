# Radio show mode — build plan

A second mode for efrain.fm: a monthly, on-rails radio show. No free text. The listener
steps through a fixed order of songs and voice transmissions at their own pace.

Status key: `[ ]` to do · `[x]` done · **(open)** needs a decision

---

## What we settled

**Modes**
- Two modes on one page: **Explore** (today's chat) and **Show**. A toggle in the header switches between them.
- Toggling never resets either mode. Both stay alive on the page; one is hidden.
- `/show` opens the page with the show in front. The address updates when the toggle is used, so a reload stays in the same mode.
- Window, header, footer and star field are shared. Show mode hides the rings and the Grooves button.

**Show layout** (mocked in `public/mock-show.html`)
- Masthead under the header: edition ("October 2026"), show title, then an info line: `5 of 14 songs • 55 minutes • [service pill]`.
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

`data/shows/2026-10.json`

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
    { "type": "transmission", "title": "Transmission 1", "audio": "/audio/shows/2026-10/t1.m4a" }
  ]
}
```

- The newest file in `data/shows/` is the current show. Older files stay for a future archive.
- Title, artist and embed links are read from `songs.json` by `song_id`.
- The server checks every show at startup and refuses to start if a `song_id` or audio file is missing.

---

## Build steps

### 1. October content
- [ ] Efrain sends the show details (see "What I need from you").
- [ ] Match each song against `songs.json`; reuse the existing entry where there is one.
- [ ] Add new songs from id `0718` up: title, artist, year, cluster, secondary cluster, traits, embed links, story.
- [ ] Draft traits for new songs from the existing vocabulary; Efrain reviews.
- [ ] Convert share links to embed links (Spotify and Apple Music).
- [ ] Add transmission audio to `public/audio/shows/2026-10/`.
- [ ] Write `data/shows/2026-10.json`.

### 2. Server (`server.js`)
- [ ] Load and validate `data/shows/*.json` at startup.
- [ ] `GET /api/show` — current show with each song's title, artist and links filled in.
- [ ] `GET /show` — serves the same page as `/`.
- [ ] Confirm `vercel.json` ships `data/shows/` (it already includes `data/**`).

### 3. Show layout (`index.html`, `style.css`)
- [ ] Add the show markup beside the chat container: masthead, playlist, current item.
- [ ] Move the mock's styles into `style.css`.
- [ ] Add the Explore/Show toggle to the header.
- [ ] Phone layout: stacked playlist with capped height.

### 4. Show behaviour (`script.js`)
- [ ] Fetch the show and render the masthead, playlist and current item.
- [ ] Footer button: advance, reveal the next row, label by what's next.
- [ ] Row tap loads that item; keep the current row scrolled into view.
- [ ] Intro text before the first song; outro text and Explore button at the end.
- [ ] Save and restore progress (`show id`, furthest item reached, current item).
- [ ] New show id clears old progress.

### 5. Switching modes
- [ ] Mode class on the page; hide chat and text box in Show, hide show in Explore.
- [ ] Update the address on toggle; respect it on load and on back/forward.
- [ ] On leaving Show: switch off the current embed, pause a playing transmission.
- [ ] On leaving Explore: switch off its embeds, pause its voice audio.
- [ ] Background canvas: skip the rings in Show mode, keep the stars.
- [ ] Hide the Grooves button in Show mode.
- [ ] "New" marker on the toggle for an unstarted show.

### 6. Arrival
- [ ] After the Spotify-or-Apple question on a first visit to `/`, ask show or explore.
- [ ] First visit to `/show`: skip the welcome transmission, ask Spotify or Apple, start the show.

### 7. Service pill
- [ ] Pill shows the current service with its colour.
- [ ] Tap opens the footer question; the answer saves and reloads the current song.
- [ ] If a song has no link for the chosen service, fall back to the other one.

### 8. Transmissions
- [ ] Render with the existing voice component, without starting playback.
- [ ] Stamp the title after it finishes, as the welcome transmission does.

### 9. Checks
- [ ] Desktop and phone widths, both services.
- [ ] Toggle back and forth mid-song and mid-transmission: places kept, nothing left playing.
- [ ] Reload mid-show restores the place.
- [ ] First visit to `/`, first visit to `/show`, returning visit to each.
- [ ] Keyboard only: toggle, rows, pill, button. Visible focus. 44px touch targets on phones.
- [ ] Explore mode behaves exactly as before.

### 10. Ship
- [ ] Delete `public/mock-show.html`.
- [ ] Update `CLAUDE.md` with show mode and the monthly update steps.
- [ ] Commit, push, confirm the deploy.

---

## Open decisions

Each has a default I will build unless told otherwise.

1. **Show plays and Grooves.** Default: playing a song in the show does not count toward ring unlocks, and does not stop Explore from recommending it later.
2. **Keystone songs in a show.** Keystones are withheld in Explore until unlocked. Default: a show may include one; it plays normally there and stays locked in Explore.
3. **Show-first visitors opening Explore.** They never heard the welcome transmission. Default: it is printed at the top of Explore, unplayed, and the text box is ready.
4. **Intro and outro in the playlist.** Default: each appears as a row once reached, so people can go back to them.
5. **Phones: where the embed sits.** Default: anchored at the bottom, just above the button, so it is near the thumb.
6. **Edition wording.** "Transmission // October 2026" clashes with the voice transmissions. Default: "October 2026".
7. **Cluster C10.** 15 songs in the library are tagged C10, but the code only knows C1–C9 (no label, no keystone). Need to know what C10 is before assigning new songs to it.

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

## Each month after this

1. Add any new songs to `data/songs.json`.
2. Add transmission audio to `public/audio/shows/<year-month>/`.
3. Add `data/shows/<year-month>.json`.
4. Push. The newest show file becomes the current show.
