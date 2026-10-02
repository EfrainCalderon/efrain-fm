---
name: new-episode
description: Publish a new monthly episode of the efrain.fm show (the on-rails "EP. 02" mode beside Explore). Use this whenever Efrain shares a song list, tracklist or running order for a new month, mentions a new episode, show, set or "EP", drops transmission or intro audio files into the project, or asks to add, reorder, retitle or fix anything in an episode, even if they don't say the word "episode". Covers matching songs against the library, adding new songs with links, clusters and tags, wiring up the audio, writing the episode file, checking it, and publishing.
---

# Publishing a new efrain.fm episode

An episode is a fixed running order of songs and spoken transmissions that listeners step
through with one button. Efrain makes one a month. Publishing it is mostly careful data
entry across three places, plus a few judgement calls about recordings and tags. This
skill exists so each month goes the same way and nothing from the first episode has to be
rediscovered.

## Where everything lives

| What | Where |
|---|---|
| Song library (every song, including show songs) | `data/songs.json` |
| One file per episode, newest file name = current episode | `data/episodes/<year-month>.json` |
| Transmission audio for an episode | `public/audio/episodes/<year-month>/` |
| Helper commands | `.claude/skills/new-episode/scripts/episode-tools.js` |

Show songs are ordinary library songs. The episode file only lists the order by song id,
so a song already in the library is reused, and a new song becomes available in Explore
too. Read the "Show mode" section of `CLAUDE.md` if you need how the mode itself works.

## Working with Efrain

Efrain is a UX designer, not a developer. Explain in plain language, ask one question at
a time, check state yourself instead of asking them to read output, and point them at
`http://localhost:3000/show` for previews. They care a lot about the listening experience
and will have opinions about recordings, order and wording, so surface choices instead of
deciding silently.

## What to collect

Start from whatever Efrain gives you and ask only for what is missing, one thing at a
time. Much of this you can work out yourself.

From Efrain:
- **Running order**: songs as artist and title, in order. Years help pick the recording.
- **Spotify links** for songs not already in the library. You cannot look these up (see
  "Links" below).
- **Audio files** and where each sits: an introduction, and transmissions "after song N".
- **Episode title**, usually "Episode 02: Something".
- **Sign-off text** shown at the end. An intro is normally spoken, not text.
- Nothing for running time: you measure it (step 7).
- Optional: a story (commentary) for any new song, and cluster preferences.

You work out: which songs are already in the library, Apple Music links, the episode
number, ids, tags, and clusters (as proposals for Efrain to confirm).

## Steps

Run the helper from the repository root. `T` below stands for
`node .claude/skills/new-episode/scripts/episode-tools.js`.

### 1. See where things stand

```bash
node .claude/skills/new-episode/scripts/episode-tools.js status
```

This gives the next episode number, the next free song id, and the existing episodes.

### 2. Match the song list against the library

Save the list as text, one song per line as `Artist – Title (year)`, and run `T match
<file>` (or pipe it in with `T match -`). Each line comes back as IN LIBRARY (with id and
whether both links exist), POSSIBLE MATCH, or NEW.

Report the result to Efrain as a short table before adding anything. Flag year mismatches
and possible matches; a "possible match" is often a different recording of the same
song, and which recording plays is Efrain's call.

### 3. Get links for new songs

**Apple Music**: `T apple "<artist>" "<title>"` lists candidates with album, year and
length. Pick the one matching the year and version Efrain named, and show your picks so a
wrong one can be caught. Apple search returns live takes, remasters and re-recordings
freely, and classical pieces are often credited or spelled unexpectedly; if nothing fits,
ask Efrain for the link.

**Spotify**: ask Efrain for share links. Spotify's search API needs the app owner to have
Premium, which Efrain does not, so there is no automatic lookup. Verify what they send
with `T spotify <link> <link> …`, which prints each track's title, artists and length and
the embed URL to store. Compare lengths with the Apple pick: a different length usually
means a different recording or a mono/stereo mismatch, and both services should play the
same thing.

Store links in the embed forms the tools print:
`https://open.spotify.com/embed/track/<id>` and
`https://embed.music.apple.com/us/album/<album id>?i=<track id>`.

### 4. Add new songs to the library

Append to the `songs` array in `data/songs.json`, taking ids upward from the next free
one. Match the shape of recent entries:

```json
{
  "id": "0727",
  "title": "French Disko",
  "artist": "Stereolab",
  "year": 1993,
  "streaming": { "spotify": "…embed url…", "apple_music": "…embed url…", "youtube": "" },
  "commentary": "",
  "tag_title": "",
  "tag_url": "",
  "audio_story": "",
  "cluster": "C7",
  "cluster_secondary": "C4",
  "traits": { "genre:krautrock": 0.8, "energy:high": 0.8, "era:90s": 1, "origin:uk": 1 }
}
```

Edit the file with a small script that parses it and writes it back with
`JSON.stringify(data, null, 2)` and no trailing newline; that reproduces the file's exact
formatting, so the change shows up as only the lines you added.

**Clusters** are Efrain's nine "Grooves": C1 Outsider, C2 Night, C3 Raw, C4 Cosmic,
C5 Soul, C6 Loss, C7 Art, C8 Memory, C9 Static. C10 is a K-pop group with no keystone.
Pick a primary and usually a secondary. `T match` shows how Efrain clustered other songs
by the same artist, which is the best guide.

**Traits** are what Explore matches requests against, weighted 0 to 1. Run `T vocab` and
tag from the existing vocabulary: typically energy, one or two genres, two or three moods,
a texture or two, a few character tags, an era, and an origin. Conventions worth keeping:
- Recent releases use `era:modern`; older ones use the decade (`era:60s`).
- `origin:` is where the artist is from. A sound or theme from elsewhere is a `char:` tag
  (`char:hawaiian` on a band from Georgia).
- Classical recordings get a light era weight (about 0.4), so "2000s music" doesn't lead
  with Debussy.
- A genuinely new tag also needs an alias in `TRAIT_ALIASES` and a mention in the two
  keyword prompts in `server.js`, or Explore can never reach it.

You cannot hear the songs. Say so, mark the ones you are least sure of, and present
clusters and tags as a table in plain words for Efrain to correct. Leave `commentary`
empty unless Efrain supplies a story.

### 5. Put the audio in place

Files go in `public/audio/episodes/<year-month>/`, named `transmission-intro.m4a`,
`transmission-1.m4a`, `transmission-2.m4a`, and so on. If Efrain has already dropped
them in, check them with `afinfo <file>` for length and format.

Export settings to recommend: **AAC at 128 kbit/s**. The site serves files through a
Vercel Function, which documents a 4.5 MB cap on what it can return, and 128 keeps a
three-minute message near 2.9 MB. `T check` fails any file over the cap.

### 6. Write the episode file

`data/episodes/<year-month>.json`:

```json
{
  "id": "2026-11",
  "number": 2,
  "edition": "November 2026",
  "title": "Episode 02: Title here",
  "duration_minutes": 56,
  "intro": "",
  "outro": "Sign-off text. Blank lines make paragraphs.",
  "steps": [
    { "type": "transmission", "title": "Introduction", "audio": "/audio/episodes/2026-11/transmission-intro.m4a" },
    { "type": "song", "song_id": "0727" },
    { "type": "song", "song_id": "0253", "short_title": "Optional shorter playlist title" },
    { "type": "transmission", "title": "Transmission 1", "audio": "/audio/episodes/2026-11/transmission-1.m4a" }
  ]
}
```

- `id` must equal the file name. The newest file name is the episode listeners get, so a
  new month's file replaces the old one as current the moment it is published.
- `number` drives the header button ("EP. 02") and should be the next whole number.
- A spoken introduction is a first step of type `transmission` titled "Introduction",
  with `intro` left empty. `intro` text is only for an episode with no spoken opening.
- Transmissions are titled "Transmission 1", "Transmission 2"… in order.
- `short_title` is for titles whose important part gets cut off in the narrow playlist
  column, mostly classical.

### 7. Measure the running time

```bash
node .claude/skills/new-episode/scripts/episode-tools.js duration 2026-11
```

This adds up every song and every transmission and prints the number for
`duration_minutes`. The figure listeners see is the whole episode, music plus Efrain's
messages, so don't use a music-only total. Put the printed number in the episode file.

### 7b. Check it

```bash
node .claude/skills/new-episode/scripts/episode-tools.js check 2026-11
```

It prints the running order as listeners will see it and reports errors (unknown song
ids, missing or oversized audio, id and number clashes) and warnings (a song missing one
service's link, placeholder text, no sign-off). Fix every error: an episode with an
unknown song id is skipped by the server at startup, which would silently leave last
month's episode showing. Read the printed order back against Efrain's list.

### 8. Try it locally

The server reads songs and episodes once at startup, so restart the preview server after
editing data. Then open `http://localhost:3000/show` and step through: introduction
first, each transmission in its slot, the right label on the footer button, the sign-off
and note form at the end. Saved progress is keyed by episode id, so a new id starts at
the beginning without clearing anything. Tell Efrain it's ready to preview before
publishing if they have not seen the order yet.

### 9. Publish and confirm

This project commits and pushes automatically at the end of every turn, and anything on
`main` deploys to the live site. So once the files are right, the episode goes live when
your turn ends, and the header button changes to the new number for every visitor. If
Efrain wants to review first, do the work on a branch and merge when they say so.

After the deploy (about a minute), confirm the live site instead of assuming:

```bash
curl -s https://efrain.fm/api/show | grep -oE '"(id|number|title)":[^,]*' | head -3
curl -s -o /dev/null -w "%{http_code} %{size_download} bytes\n" https://efrain.fm/audio/episodes/2026-11/transmission-1.m4a
```

Check that the id and title are the new ones and that each audio file returns 200 at its
full size. Then tell Efrain what is live and what you could not verify (you can't hear
the audio or see the page as a listener does).

## Changing an existing episode

Reordering, moving a transmission, swapping a song, or fixing a title are edits to the
episode file followed by steps 7 to 9. Re-run `duration` if a song or audio file changed. Listeners' saved place is stored by position, so
after a reorder someone mid-episode may land an item away from where they were; mention
that if the episode has been live for a while.
