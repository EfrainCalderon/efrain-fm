const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-button');

const sessionId = Math.random().toString(36).substring(2);

let sessionStats = {
  songsPlayed: 0,
  messagesExchanged: 0,
  startTime: new Date()
};

let isTyping = false;
let pendingFavoriteInput = false;
// Mirrors server-side session.lastSong client-side, so a stateless/cold serverless
// instance can rehydrate "tell me more about this song" style follow-ups.
let lastPlayedSong = null;
// Mirrors server-side session._lastSongInfoText / _infoExhaustedFor — otherwise a cold
// instance never learns the info well for this song ran dry and keeps regenerating "more."
let lastSongInfoState = { text: null, exhausted: false };
// Mirrors server-side session.songCount / askedMoreOf / lastInterruptSong — these pace
// the "this reminds me of..." / "want to go somewhere different?" / "what else are you
// in the mood for?" interrupts. Without this, a cold instance restarts the count at 0
// and those prompts (including the 4-song Groove Glow fallback unlock) may never fire.
let songsThisSession = 0;
let askedMoreOfThisSession = false;
let lastInterruptSongCount = 0;
// Mirrors server-side session._pendingRelatedSong / _pendingBridge — the "want to hear
// it?" suggestion the server is waiting on an "Okay"/"No thank you" reply for.
let pendingRelatedSong = { title: null, bridge: null };

// =====================
// PLAYER PREFERENCE
// Set via inline chat picker on first visit (or if unset on return).
// Persists in localStorage. Default is 'apple' (longer previews).
// =====================
const PLAYER_KEY = 'efrain_fm_player';
function getPlayerPref() { return localStorage.getItem(PLAYER_KEY) || 'apple'; }
function setPlayerPref(val) { localStorage.setItem(PLAYER_KEY, val); }

// =====================
// SPOTIFY PLAYBACK NOTE
// What a Spotify listener can expect from the embeds, said only to the people it affects.
// Spotify's embed plays full songs only when it can tell the listener is logged in to
// Spotify, which depends on the browser: Safari and phones are limited to 30-second
// previews. We can't detect a Spotify login, so the wording stays conditional and never
// promises full songs.
// =====================
function spotifyPlaybackNote() {
  const ua = navigator.userAgent;
  const isPhone = /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/i.test(ua);
  if (isPhone) return 'On phones and tablets, Spotify only plays 30-second previews here. Tap a song to hear the rest in Spotify.';
  if (isSafari) return 'Safari limits Spotify to 30-second previews here. You may get full songs in Chrome if you’re logged in to Spotify there.';
  return 'Being logged in to Spotify in this browser can unlock full songs. If one stops at 30 seconds, click it to hear the rest on Spotify.';
}

// =====================
// PLAYER PICKER
// showPlayerPicker  — first-time setup, three options, called after intro audio ends
// showPlayerSwitchPrompt — mid-session, two options, called when user mentions a platform
// =====================
async function showPlayerPicker(promptText, { offerEpisode = false } = {}) {
  isTyping = true;
  fadeOutInput();

  const typingIndicator = showTypingIndicator();
  await new Promise(r => setTimeout(r, 700));
  removeTypingIndicator(typingIndicator);
  await addMessageToChatWithTyping(
    promptText || "You can request any kind of music and I'll share songs from my collection. Which do you use to listen to music?",
    'assistant'
  );

  const footer = document.querySelector('footer') || document.getElementById('chat-footer');
  const interruptEl = document.createElement('div');
  interruptEl.id = 'interrupt-bar';

  const btnRow = document.createElement('div');
  btnRow.id = 'interrupt-buttons';

  const options = [
    { label: 'Spotify',        val: 'spotify' },
    { label: 'Apple Music',    val: 'apple'   },
    { label: 'Something else', val: 'apple'   }, // save apple — longer previews
  ];

  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'interrupt-btn';
    btn.textContent = opt.label;
    btn.style.animationDelay = `${i * 70}ms`;
    btn.addEventListener('click', async () => {
      // Dismiss buttons
      interruptEl.classList.remove('visible');
      await new Promise(r => setTimeout(r, 350));
      interruptEl.remove();

      setPlayerPref(opt.val);

      // Follow-up confirmation message
      isTyping = true;
      const t = showTypingIndicator();
      await new Promise(r => setTimeout(r, 500));
      removeTypingIndicator(t);

      // First visit only: once the service is settled, offer the two ways to listen
      const offer = offerEpisode && window.showMode && window.showMode.isOffered();

      let reply;
      if (opt.label === 'Spotify') {
        reply = `Cool, I'll use Spotify. ${spotifyPlaybackNote()}`;
      } else if (opt.label === 'Apple Music') {
        reply = "Awesome — I'll show Apple Music versions. You can listen to the full song if you sign in."
          + (offer ? '' : ' What would you like to hear?');
      } else {
        reply = "Got it — I'll use Apple Music to share songs because its previews are longer than Spotify.";
      }

      await addMessageToChatWithTyping(reply, 'assistant');
      if (offer) {
        showModeChoice();
        return;
      }
      isTyping = false;
      setTimeout(fadeInInput, 600);
    });
    btnRow.appendChild(btn);
  });

  interruptEl.appendChild(btnRow);
  footer.appendChild(interruptEl);
  requestAnimationFrame(() => requestAnimationFrame(() => interruptEl.classList.add('visible')));
  // Note: input stays hidden — fadeInInput fires inside the button click handler
}

// First visit, after the service question: explain the two ways to listen in one message,
// then offer them as two buttons in the footer (same slot as every other choice).
async function showModeChoice() {
  isTyping = true;
  fadeOutInput();
  const typingIndicator = showTypingIndicator();
  await new Promise(r => setTimeout(r, 700));
  removeTypingIndicator(typingIndicator);

  const { label, enter } = window.showMode;
  await addMessageToChatWithTyping(
    'There are two ways to listen. Explore: tell me a mood, a genre, or an artist, and I’ll find you a song. Or, listen to monthly episodes where I share about an hour of music with some banter scattered in between.',
    'assistant'
  );

  const footer = document.querySelector('footer') || document.getElementById('chat-footer');
  const interruptEl = document.createElement('div');
  interruptEl.id = 'interrupt-bar';
  const btnRow = document.createElement('div');
  btnRow.id = 'interrupt-buttons';

  const options = [
    { label: 'Explore',           episode: false },
    { label: `Hear ${label()}`,   episode: true  },
  ];

  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'interrupt-btn';
    btn.textContent = opt.label;
    btn.style.animationDelay = `${i * 70}ms`;
    btn.addEventListener('click', async () => {
      interruptEl.classList.remove('visible');
      await new Promise(r => setTimeout(r, 350));
      interruptEl.remove();

      if (opt.episode) {
        // Leave Explore ready for whenever they come back, then open the episode
        isTyping = false;
        fadeInInput();
        enter();
        return;
      }

      const t = showTypingIndicator();
      await new Promise(r => setTimeout(r, 500));
      removeTypingIndicator(t);
      await addMessageToChatWithTyping('What would you like to hear?', 'assistant');
      isTyping = false;
      setTimeout(fadeInInput, 600);
    });
    btnRow.appendChild(btn);
  });

  interruptEl.appendChild(btnRow);
  footer.appendChild(interruptEl);
  requestAnimationFrame(() => requestAnimationFrame(() => interruptEl.classList.add('visible')));
}

async function showPlayerSwitchPrompt() {
  if (isTyping) return;
  isTyping = true;
  fadeOutInput();

  const typingIndicator = showTypingIndicator();
  await new Promise(r => setTimeout(r, 600));
  removeTypingIndicator(typingIndicator);
  await addMessageToChatWithTyping("Which would you like to switch to?", 'assistant');

  const footer = document.querySelector('footer') || document.getElementById('chat-footer');
  const interruptEl = document.createElement('div');
  interruptEl.id = 'interrupt-bar';

  const btnRow = document.createElement('div');
  btnRow.id = 'interrupt-buttons';

  const options = [
    { label: 'Spotify',     val: 'spotify' },
    { label: 'Apple Music', val: 'apple'   },
  ];

  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'interrupt-btn';
    btn.textContent = opt.label;
    btn.style.animationDelay = `${i * 70}ms`;
    btn.addEventListener('click', async () => {
      interruptEl.classList.remove('visible');
      await new Promise(r => setTimeout(r, 350));
      interruptEl.remove();

      setPlayerPref(opt.val);

      isTyping = true;
      const t = showTypingIndicator();
      await new Promise(r => setTimeout(r, 500));
      removeTypingIndicator(t);

      const reply = opt.val === 'spotify'
        ? `Switched to Spotify for any songs you request next. ${spotifyPlaybackNote()}`
        : "Switched to Apple Music for any songs you request next. Sign in and you can hear full songs.";

      await addMessageToChatWithTyping(reply, 'assistant');
      isTyping = false;
      setTimeout(fadeInInput, 600);
    });
    btnRow.appendChild(btn);
  });

  interruptEl.appendChild(btnRow);
  footer.appendChild(interruptEl);
  requestAnimationFrame(() => requestAnimationFrame(() => interruptEl.classList.add('visible')));
}

// =====================
// GROOVE GLOW STATE
// Tracks per-visitor cluster unlock state in localStorage.
// clusterCounts: how many non-keystone songs from each cluster have been played this session.
// unlockedClusters: clusters whose keystone has been unlocked (persists across sessions).
// glowRingCount: how many rings are currently glowing (= unlockedClusters.length).
// =====================
const GROOVE_STORAGE_KEY   = 'efrain_fm_groove';
const VISITOR_ID_KEY       = 'efrain_fm_visitor_id';
const SESSION_START_KEY    = 'efrain_fm_first_session';
const PLAYED_TITLES_KEY    = 'efrain_fm_played';

function loadPlayedTitles() {
  try { return JSON.parse(localStorage.getItem(PLAYED_TITLES_KEY)) || []; } catch { return []; }
}
function savePlayedTitle(title) {
  const played = loadPlayedTitles();
  if (!played.includes(title)) {
    played.push(title);
    localStorage.setItem(PLAYED_TITLES_KEY, JSON.stringify(played));
  }
}

// Persistent state (survives page close)
function loadGrooveState() {
  try { return JSON.parse(localStorage.getItem(GROOVE_STORAGE_KEY)) || {}; } catch { return {}; }
}
function saveGrooveState(state) {
  localStorage.setItem(GROOVE_STORAGE_KEY, JSON.stringify(state));
}

let grooveState = loadGrooveState();
// grooveState shape:
// {
//   unlockedClusters: ['C1', 'C3', ...],   // persists
//   glowRingCount: 2,                        // persists (= unlockedClusters.length)
// }
if (!grooveState.unlockedClusters) grooveState.unlockedClusters = [];
if (!grooveState.glowRingCount)    grooveState.glowRingCount    = 0;

// Persistent cluster play counts (survives page reload — intentional for unlock continuity)
// Shape: { C1: 2, C3: 1, ... }
const CLUSTER_COUNTS_KEY = 'efrain_fm_cluster_counts';
function loadClusterCounts() {
  try { return JSON.parse(localStorage.getItem(CLUSTER_COUNTS_KEY)) || {}; } catch { return {}; }
}
function saveClusterCounts() {
  localStorage.setItem(CLUSTER_COUNTS_KEY, JSON.stringify(clusterPlayCounts));
}
let clusterPlayCounts = loadClusterCounts();

// Visitor ID — generated once, persists forever
function getVisitorId() {
  let id = localStorage.getItem(VISITOR_ID_KEY);
  if (!id) {
    id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    localStorage.setItem(VISITOR_ID_KEY, id);
  }
  return id;
}

// First session timestamp
function getFirstSessionStart() {
  let t = localStorage.getItem(SESSION_START_KEY);
  if (!t) { t = new Date().toISOString(); localStorage.setItem(SESSION_START_KEY, t); }
  return t;
}

// Groove keystone map — fetched from server on load
// Maps cluster → { label, title, artist, audio }
let grooveKeystones = [];
let keystoneByCluster = {};

async function loadGrooveKeystones() {
  try {
    const res = await fetch('/api/groove-keystones');
    grooveKeystones = await res.json();
    keystoneByCluster = Object.fromEntries(grooveKeystones.map(k => [k.cluster, k]));
    // Expose glow count to the canvas immediately on load (rings light up on revisit)
    updateRingGlowState(grooveState.glowRingCount, false);
  } catch (e) {
    console.warn('Could not load groove keystones', e);
  }
}
loadGrooveKeystones();

// Called by the canvas script to know how many rings should glow
window.getGrooveGlowCount = () => grooveState.glowRingCount;

// Auto-expand textarea
userInput.addEventListener('input', function() {
  this.style.height = '48px';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// =====================
// TYPING ANIMATION
// Locks scroll during typing — message bottom tracks to container bottom.
// Restores scrolling when done.
// =====================
async function typeText(element, text, speed = 20) {
  return new Promise((resolve) => {
    let index = 0;
    element.textContent = '';
    const container = document.getElementById('chat-container');

    const interval = setInterval(() => {
      if (index < text.length) {
        element.textContent += text[index];
        index++;
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        if (elementRect.bottom > containerRect.bottom) {
          container.scrollTop += (elementRect.bottom - containerRect.bottom) + 8;
        }
      } else {
        clearInterval(interval);
        container.scrollTop = container.scrollHeight;
        resolve();
      }
    }, speed);
  });
}

// Secret commands
function handleSecretCommand(command) {
  const parts = command.trim().split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  switch(cmd) {
    case '/reset':
      chatMessages.innerHTML = '';
      sessionStats = { songsPlayed: 0, messagesExchanged: 0, startTime: new Date() };
      return true;

    case '/debug':
      const uptime = Math.floor((new Date() - sessionStats.startTime) / 1000 / 60);
      console.log(`Songs: ${sessionStats.songsPlayed}, Messages: ${sessionStats.messagesExchanged}, Uptime: ${uptime}min`);
      return true;

    case '/player': {
      const pref = args.toLowerCase().trim();
      if (pref === 'apple') {
        setPlayerPref('apple');
        console.log('Player set to Apple Music.');
      } else if (pref === 'spotify') {
        setPlayerPref('spotify');
        console.log('Player set to Spotify.');
      } else {
        console.log(`Current player: ${getPlayerPref()}. Usage: /player apple | /player spotify`);
      }
      return true;
    }

    case '/help':
      console.log('Commands: /reset, /debug, /push [c1-c9], /groove-reset, /player [apple|spotify], /show, /show-reset, /help');
      return true;

    case '/show':
    case '/episode':
      // Enter show mode (the monthly on-rails episode)
      if (window.enterShowMode) window.enterShowMode();
      return true;

    case '/show-reset':
      // Forget show progress and hide the episode button again — useful for testing the first-time flow
      if (window.resetShowMode) window.resetShowMode();
      console.log('Show progress reset.');
      return true;

    case '/push': {
      // Force-trigger a cluster's groove transmission for local testing
      // Usage: /push c1 through /push c9
      const cluster = args.toUpperCase().trim();
      if (!cluster.match(/^C[1-9]$/)) {
        console.log('Usage: /push c1 through /push c9');
        return true;
      }
      // Fire directly against the API with pushCluster set
      (async () => {
        const typingIndicator = showTypingIndicator();
        isTyping = true;
        fadeOutInput();
        try {
          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message:          `push ${cluster}`,
              sessionId,
              unlockedClusters: [],  // treat as unlocked=none so groove fires
              clusterCounts:    {},
              pushCluster:      cluster,
            }),
          });
          const data = await response.json();
          removeTypingIndicator(typingIndicator);
          if (data.song) {
            window._lastGrooveInput = `/push ${cluster}`;
            // Force groove even if already unlocked — dev mode
            const keystone = keystoneByCluster[cluster];
            if (keystone) {
              await playGrooveTransmission(keystone, data.song, data.response);
            } else {
              await displaySong(data.song, data.response);
            }
          } else if (data.response) {
            await addMessageToChatWithTyping(data.response, 'assistant');
          }
        } catch (e) {
          console.error('/push error', e);
          removeTypingIndicator(typingIndicator);
        }
        isTyping = false;
        setTimeout(fadeInInput, 600);
      })();
      return true;
    }

    case '/groove-reset':
      // Reset all groove glow state — useful for testing the full first-unlock flow
      grooveState = { unlockedClusters: [], glowRingCount: 0 };
      saveGrooveState(grooveState);
      clusterPlayCounts = {};
      saveClusterCounts();
      updateRingGlowState(0, false);
      console.log('Groove state reset.');
      return true;

    default:
      return false;
  }
}

// =====================
// INPUT FADE HELPERS
// The footer height never changes — input and buttons swap in the same space
// =====================
function fadeOutInput() {
  const inputWrapper = document.getElementById('input-wrapper');
  // Kill placeholder instantly so it doesn't linger during fade
  userInput.classList.add('hide-placeholder');
  inputWrapper.style.opacity = '0';
  inputWrapper.style.pointerEvents = 'none';
}

function fadeInInput() {
  const inputWrapper = document.getElementById('input-wrapper');
  userInput.style.height = '48px';
  inputWrapper.style.opacity = '1';
  inputWrapper.style.pointerEvents = 'auto';
  setTimeout(() => {
    userInput.classList.remove('hide-placeholder');
  }, 200);
}

// =====================
// SEND MESSAGE
// =====================
async function sendMessage() {
  if (isTyping) return;

  const message = userInput.value.trim();
  if (!message) return;

  if (message.startsWith('/')) {
    const handled = handleSecretCommand(message);
    if (handled) {
      userInput.value = '';
      userInput.style.height = '48px';
      return;
    }
  }

  addMessageToChat(message, 'user');
  userInput.value = '';
  userInput.style.height = '48px';
  sessionStats.messagesExchanged++;

  // Detect player-switch intent before hitting the server
  const msgLowerTrim = message.toLowerCase().trim();
  const isPlayerSwitch =
    /change player|switch player|switch to|listen on|use spotify|use apple|on spotify|on apple music|spotify please|apple music please/.test(msgLowerTrim) ||
    (msgLowerTrim === 'spotify' || msgLowerTrim === 'apple music');
  if (isPlayerSwitch) {
    showPlayerSwitchPrompt();
    return;
  }
  window._lastGrooveInput = message; // captured for groove unlock logging

  fadeOutInput();

  await new Promise(r => setTimeout(r, 250));
  const typingIndicator = showTypingIndicator();
  isTyping = true;

  try {
    const endpoint = pendingFavoriteInput ? '/api/favorite' : '/api/chat';
    // Read-then-clear: the server consumes and nulls its own copy of the pending
    // suggestion the instant a reply comes in, so the client mirrors that exactly —
    // whatever we send now is "used up" regardless of how the server responds.
    const outgoingPendingRelated = pendingRelatedSong;
    pendingRelatedSong = { title: null, bridge: null };
    const body = pendingFavoriteInput
      ? { input: message, sessionId }
      : {
          message,
          sessionId,
          unlockedClusters:  grooveState.unlockedClusters,
          clusterCounts:     clusterPlayCounts,
          playedSongTitles:  loadPlayedTitles(),
          pushCluster:       null,
          lastSongTitle:          lastPlayedSong ? lastPlayedSong.title  : null,
          lastSongArtist:         lastPlayedSong ? lastPlayedSong.artist : null,
          lastSongInfoText:       lastSongInfoState.text,
          lastSongInfoExhausted:  lastSongInfoState.exhausted,
          songCount:              songsThisSession,
          askedMoreOf:            askedMoreOfThisSession,
          lastInterruptSong:      lastInterruptSongCount,
          pendingRelatedSongTitle:  outgoingPendingRelated.title,
          pendingRelatedSongBridge: outgoingPendingRelated.bridge,
        };

    const wasFavoriteInput = pendingFavoriteInput;
    pendingFavoriteInput = false;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status === 529) {
      throw { status: 529, message: 'overloaded' };
    }
    if (!response.ok) {
      throw { status: response.status, message: 'server error' };
    }
    const data = await response.json();
    sessionStats.messagesExchanged++;

    if (data.infoExhausted) {
      lastSongInfoState = { text: null, exhausted: true };
    } else if (data.songInfo) {
      lastSongInfoState = { text: data.songInfo, exhausted: false };
    }

    if (data.interrupt) {
      if (['related', 'vibe_check', 'more_of'].includes(data.interrupt.type)) {
        lastInterruptSongCount = songsThisSession;
      }
      if (data.interrupt.type === 'related') {
        pendingRelatedSong = {
          title:  data.interrupt.relatedSongTitle || null,
          bridge: data.interrupt.relatedBridge     || null,
        };
      }
      if (data.interrupt.type === 'more_of') {
        askedMoreOfThisSession = true;
      }
    }

    if (data.song) {
      removeTypingIndicator(typingIndicator);
      if (data.bridgingResponse) {
        await addMessageToChatWithTyping(data.bridgingResponse, 'assistant');
      }

      // Track cluster play count for groove glow logic
      // The server tells us the song's cluster via data.song.cluster (we'll need to look it up)
      // We track based on whether the server returned groove metadata or not.
      // If groove is present: it's a keystone — handled specially below.
      // If not: look up which cluster this song belongs to and increment.

      const grooveHandled = await handleGrooveSong(data);
      if (!grooveHandled) {
        if (data.song && data.song.cluster) {
          // Increment and persist — server reads this on the next request to decide threshold
          clusterPlayCounts[data.song.cluster] = (clusterPlayCounts[data.song.cluster] || 0) + 1;
          saveClusterCounts();
        }
        if (data.preface) {
          await addMessageToChatWithTyping(data.preface, 'assistant');
        }
        await displaySong(data.song, data.response);
        savePlayedTitle(data.song.title);
        sessionStats.songsPlayed++;
      }
    } else if (data.songInfo) {
      removeTypingIndicator(typingIndicator);
      // Reaction (if any) reads as Efrain talking, typed out as usual — the factual info
      // that follows is deliberately a different register, so it renders as its own
      // non-bubble block rather than another chat message.
      if (data.response) {
        await addMessageToChatWithTyping(data.response, 'assistant');
      }
      addSongInfoToChat(data.songInfo);
    } else if (data.response) {
      removeTypingIndicator(typingIndicator);
      await addMessageToChatWithTyping(data.response, 'assistant', data.responseLink || null);
    } else if (data.interrupt) {
      // No response text — interrupt will render the message itself, keep indicator until then
      removeTypingIndicator(typingIndicator);
    } else {
      removeTypingIndicator(typingIndicator);
    }

    // Handle interrupt if present
    if (data.interrupt) {
      const delay = data.song ? 2000 : 0;
      setTimeout(() => { showInterrupt(data.interrupt); }, delay);
    } else {
      // Reset placeholder if we just finished a favorite submission
      if (wasFavoriteInput) {
        userInput.placeholder = "Let's find a groove...";
      }
      setTimeout(fadeInInput, 600);
    }

    isTyping = false;

  } catch (error) {
    console.error('Error:', error);
    removeTypingIndicator(typingIndicator);
    const isOverloaded = error?.status === 529 || (error?.message && error.message.includes('overloaded'));
    if (isOverloaded) {
      showToast("Anthropic's servers are a little overwhelmed right now — not your fault. Try again in a moment.", 'https://status.anthropic.com');
    } else {
      addMessageToChat('Something went wrong. Please try again.', 'assistant');
    }
    fadeInInput();
    isTyping = false;
  }
}

// =====================
// MESSAGE RENDERING
// =====================
function addMessageToChat(message, sender) {
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('message', sender);
  messageDiv.textContent = message;
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// linkInfo: optional { word, url } — after typing finishes, swaps the first plain-text
// occurrence of `word` into a real link. Kept out of the typed string itself so the
// animation never shows raw markup mid-type; it becomes clickable only once fully typed.
async function addMessageToChatWithTyping(message, sender, linkInfo = null) {
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('message', sender);
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
  await typeText(messageDiv, message);
  if (linkInfo && linkInfo.word && linkInfo.url) {
    const escapedWord = linkInfo.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escapedWord}\\b`);
    messageDiv.innerHTML = escapeHtml(messageDiv.textContent).replace(
      re,
      `<a href="${linkInfo.url}" target="_blank" rel="noopener noreferrer" class="inline-link">${escapeHtml(linkInfo.word)}</a>`
    );
  }
}

// Factual song info — deliberately NOT typed out like a chat message (that effect implies
// someone is live-typing to you). Fades in as a printed reference note instead.
function addSongInfoToChat(text) {
  const infoDiv = document.createElement('div');
  infoDiv.classList.add('song-info');
  infoDiv.textContent = text;
  chatMessages.appendChild(infoDiv);
  scrollToBottom();
  requestAnimationFrame(() => infoDiv.classList.add('visible'));
}

function showTypingIndicator() {
  const typingDiv = document.createElement('div');
  typingDiv.classList.add('message', 'typing');
  typingDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  chatMessages.appendChild(typingDiv);
  scrollToBottom();

  const dots = typingDiv.querySelectorAll('span');
  const PERIOD = 1600;
  const OFFSET = 400;
  const MIN_OP = 0.2;
  const MAX_OP = 1.0;
  let rafId;
  function animateDots(now) {
    dots.forEach((dot, i) => {
      const phase = (now - i * OFFSET) / PERIOD;
      const sine = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      dot.style.opacity = MIN_OP + sine * (MAX_OP - MIN_OP);
    });
    rafId = requestAnimationFrame(animateDots);
  }
  rafId = requestAnimationFrame(animateDots);
  typingDiv._rafId = rafId;

  return typingDiv;
}

function removeTypingIndicator(indicator) {
  if (indicator && indicator._rafId) {
    cancelAnimationFrame(indicator._rafId);
  }
  if (indicator && indicator.parentNode) {
    indicator.parentNode.removeChild(indicator);
  }
}

function toYouTubeEmbedUrl(url) {
  if (url.includes('watch?v=')) return url.replace('watch?v=', 'embed/').split('&')[0];
  if (url.includes('youtu.be/')) return url.replace('youtu.be/', 'youtube.com/embed/');
  return url;
}

async function displaySong(song, storyText) {
  if (!lastPlayedSong || lastPlayedSong.title !== song.title) {
    lastSongInfoState = { text: null, exhausted: false };
  }
  lastPlayedSong = song;
  songsThisSession++;
  const songContainer = document.createElement('div');
  songContainer.classList.add('message', 'song');

  const player       = getPlayerPref();
  const appleUrl     = song.apple_music_url || '';
  const spotifyUrl   = song.spotify_url     || '';
  const youtubeUrl   = song.youtube_url     || spotifyUrl; // legacy: spotify_url may hold a youtube link

  // Determine which music embed to show — Apple wins if preferred and available, else Spotify
  const isYouTubeOnly = spotifyUrl && (spotifyUrl.includes('youtube.com') || spotifyUrl.includes('youtu.be'));
  const useApple      = player === 'apple' && appleUrl;
  const musicUrl      = useApple ? appleUrl : (isYouTubeOnly ? '' : spotifyUrl);

  // YouTube embed — always shown if present (additive)
  const ytUrl = isYouTubeOnly
    ? spotifyUrl
    : (youtubeUrl && (youtubeUrl.includes('youtube.com') || youtubeUrl.includes('youtu.be')) ? youtubeUrl : '');

  // Music embed (Spotify or Apple Music)
  if (musicUrl) {
    const embedWrapper = document.createElement('div');
    embedWrapper.classList.add('song-embed-wrapper');

    const iframe = document.createElement('iframe');
    iframe.classList.add('song-embed');
    iframe.frameBorder = '0';
    iframe.addEventListener('load', () => {
      iframe.classList.add('loaded');
      embedWrapper.classList.add('loaded');
    });

    if (useApple) {
      // Apple Music embed URL format: https://embed.music.apple.com/...
      // songs.json should store the embed URL directly
      iframe.src = appleUrl.includes('?') ? `${appleUrl}&theme=dark` : `${appleUrl}?theme=dark`;
      iframe.allow = 'autoplay *; encrypted-media *; fullscreen *';
      iframe.style.borderRadius = '10px';
    } else {
      iframe.src = spotifyUrl;
      iframe.allow = 'encrypted-media';
    }

    embedWrapper.appendChild(iframe);
    songContainer.appendChild(embedWrapper);
  }

  // YouTube embed — always additive
  if (ytUrl && !isYouTubeOnly) {
    const ytWrapper = document.createElement('div');
    ytWrapper.classList.add('song-embed-wrapper', 'youtube');

    const ytIframe = document.createElement('iframe');
    ytIframe.classList.add('song-embed');
    ytIframe.frameBorder = '0';
    ytIframe.addEventListener('load', () => {
      ytIframe.classList.add('loaded');
      ytWrapper.classList.add('loaded');
    });

    ytIframe.src = toYouTubeEmbedUrl(ytUrl);
    ytIframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    ytIframe.allowFullscreen = true;

    ytWrapper.appendChild(ytIframe);
    songContainer.appendChild(ytWrapper);
  } else if (isYouTubeOnly) {
    // Legacy: spotify_url is actually a YouTube link — show it as YouTube embed
    const ytWrapper = document.createElement('div');
    ytWrapper.classList.add('song-embed-wrapper', 'youtube');

    const ytIframe = document.createElement('iframe');
    ytIframe.classList.add('song-embed');
    ytIframe.frameBorder = '0';
    ytIframe.addEventListener('load', () => {
      ytIframe.classList.add('loaded');
      ytWrapper.classList.add('loaded');
    });

    ytIframe.src = toYouTubeEmbedUrl(spotifyUrl);
    ytIframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    ytIframe.allowFullscreen = true;

    ytWrapper.appendChild(ytIframe);
    songContainer.appendChild(ytWrapper);
  }

  if (song.tag_title && song.tag_title.trim() !== '') {
    const liveTag = document.createElement('div');
    liveTag.classList.add('live-tag');

    if (song.tag_url && song.tag_url.trim() !== '') {
      const link = document.createElement('a');
      link.href = song.tag_url;
      link.target = '_blank';
      link.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
        '<polyline points="15 3 21 3 21 9"></polyline>' +
        '<line x1="10" y1="14" x2="21" y2="3"></line>' +
        '</svg>' + song.tag_title;
      liveTag.appendChild(link);
    } else {
      liveTag.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<circle cx="12" cy="12" r="10"></circle>' +
        '<polyline points="12 6 12 12 16 14"></polyline>' +
        '</svg>' + song.tag_title;
    }

    songContainer.appendChild(liveTag);
  }

  const storyDiv = document.createElement('div');
  storyDiv.classList.add('song-story');
  storyDiv.style.marginTop = '8px';
  songContainer.appendChild(storyDiv);

  chatMessages.appendChild(songContainer);
  scrollToBottom();

  if (storyText && storyText.trim() !== '') {
    await typeText(storyDiv, storyText);
  } else {
    storyDiv.remove();
  }
}

// =====================
// RING GLOW STATE
// Tells the canvas how many rings to render as glowing voids.
// animate=true: triggers a brief pulse transition when a new ring lights up.
// animate=false: silently restores persisted state on page load.
// =====================
function updateRingGlowState(count, animate = false) {
  if (animate) {
    // Don't set _grooveGlowCount here — let the grooveRingUnlock event listener do it.
    // This ensures ringUnlockTimes gets recorded BEFORE glowCount increments,
    // so the first frame sees progress=0 rather than progress=1.
    window.dispatchEvent(new CustomEvent('grooveRingUnlock', { detail: { count } }));
  } else {
    // Silent restore on page load — no animation, set immediately
    window._grooveGlowCount = count;
  }
}

// =====================
// GROOVE TRANSMISSION
// When a cluster keystone is unlocked:
//  1. Play the cluster audio transmission (same component as intro)
//  2. After audio ends → print the song embed
//  3. After embed prints → light the next ring
//  4. Log the unlock to server
// =====================
async function playGrooveTransmission(keystoneConfig, song, commentary) {
  // --- Transmission embed ---
  const now   = new Date();
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const dd    = String(now.getDate()).padStart(2, '0');
  const yy    = String(now.getFullYear()).slice(-2);
  const hours = now.getHours();
  const mins  = String(now.getMinutes()).padStart(2, '0');
  const ampm  = hours >= 12 ? 'PM' : 'AM';
  const h12   = String(hours % 12 || 12).padStart(2, '0');

  // Build initial title (duration fills in after audio ends)
  const clusterLabel = keystoneConfig.label.toUpperCase();
  const storageKey   = `efrain_fm_groove_${keystoneConfig.cluster}`;

  const embed = createVoiceEmbed(keystoneConfig.audio, '');
  embed.dataset.grooveCluster = keystoneConfig.cluster;

  const wrapper = document.createElement('div');
  wrapper.className = 'voice-embed-wrapper';
  wrapper.appendChild(embed);
  chatMessages.appendChild(wrapper);
  scrollToBottom();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => embed.classList.add('loaded'));
  });

  // Start playback within this call stack (user gesture already happened via send)
  embed.startPlayback();

  // Wait for audio to end, then show the song
  await new Promise(resolve => {
    const voiceAudio = embed.querySelector('audio');
    if (!voiceAudio) { resolve(); return; }

    voiceAudio.addEventListener('ended', () => {
      // Set the title string (same pattern as intro)
      const secs     = Math.round(voiceAudio.duration || 0);
      const titleEl  = embed.querySelector('.voice-embed__title');
      const fullTitle = `GROOVE UNLOCKED // ${clusterLabel}<br><span class="voice-embed__date">${mm}-${dd}-${yy}</span><span class="voice-embed__time"> ${h12}:${mins} ${ampm} [${secs}s]</span>`;
      if (titleEl && !titleEl.dataset.durationSet) {
        titleEl.innerHTML = fullTitle;
        titleEl.dataset.durationSet = '1';
        localStorage.setItem(storageKey, fullTitle);
      }
      resolve();
    }, { once: true });

    // Guard: if audio fails, still resolve
    voiceAudio.addEventListener('error', resolve, { once: true });
  });

  // Short pause before song drops
  await new Promise(r => setTimeout(r, 600));

  // Print the song embed
  await displaySong(song, commentary);
  savePlayedTitle(song.title);
  sessionStats.songsPlayed++;

  // Short pause, then light the ring
  await new Promise(r => setTimeout(r, 800));

  // Update groove state
  if (!grooveState.unlockedClusters.includes(keystoneConfig.cluster)) {
    grooveState.unlockedClusters.push(keystoneConfig.cluster);
    // Count the keystone song as a play — it's in the collection and was served
    if (typeof window.recordClusterPlay === 'function') {
      window.recordClusterPlay(keystoneConfig.cluster);
    }
  }
  grooveState.glowRingCount = grooveState.unlockedClusters.length;
  saveGrooveState(grooveState);
  updateRingGlowState(grooveState.glowRingCount, true); // animate the ring lighting up

  // Log to server
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorId:        getVisitorId(),
        cluster:          keystoneConfig.cluster,
        label:            keystoneConfig.label,
        input:            window._lastGrooveInput || '',
        firstSessionStart: getFirstSessionStart(),
        allUnlocks:       grooveState.unlockedClusters,
      }),
    });
  } catch (e) { /* non-critical */ }
}

// Called when a song with groove metadata is returned from the server
// Returns true if it handled the groove (caller should NOT call displaySong again)
async function handleGrooveSong(data) {
  const g = data.groove;
  if (!g) return false;

  const keystone = keystoneByCluster[g.cluster];
  if (!keystone) return false;

  // Already unlocked (e.g. /push dev command used again) — just show the song normally
  if (grooveState.unlockedClusters.includes(g.cluster)) return false;

  await playGrooveTransmission(keystone, data.song, data.response);
  return true;
}

// Returns a previously-completed groove embed in its static state (for return visits)
function buildCompletedGrooveEmbed(cluster, label, savedTitle) {
  const keystone = keystoneByCluster[cluster];
  if (!keystone) return null;

  const embed = createVoiceEmbed(keystone.audio, '');
  const wrapper = document.createElement('div');
  wrapper.className = 'voice-embed-wrapper';
  wrapper.appendChild(embed);

  embed.classList.add('loaded');
  const staticLayer = embed.querySelector('.voice-embed__static');
  if (staticLayer) staticLayer.classList.add('visible');
  const titleEl = embed.querySelector('.voice-embed__title');
  if (titleEl) {
    titleEl.innerHTML = savedTitle;
    titleEl.dataset.durationSet = '1';
  }
  return wrapper;
}

// =====================
// SCROLL
// =====================
function scrollToBottom() {
  const container = document.getElementById('chat-container');
  setTimeout(() => {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, 50);
}

// =====================
// INTERRUPT / BUTTON UI
//
// The footer height never changes.
// Input fades out exactly like after a send.
// Buttons fade in over the now-empty space.
// No → buttons fade out, input fades back in.
// Yes → dismisses and sends the chosen option.
// =====================

async function showInterrupt(interrupt) {
  const footer = document.getElementById('input-footer');
  const inputWrapper = document.getElementById('input-wrapper');

  // Input is already faded out from the last send — but ensure it stays hidden
  inputWrapper.style.opacity = '0';
  inputWrapper.style.pointerEvents = 'none';

  // freeText mode: restore input in favorite-answer mode, no buttons
  if (interrupt.freeText) {
    pendingFavoriteInput = true;
    isTyping = false;
    userInput.placeholder = 'Type a song or artist...';
    await addMessageToChatWithTyping(interrupt.message, 'assistant');
    setTimeout(fadeInInput, 300);
    return;
  }

  // Type the question into chat
  await addMessageToChatWithTyping(interrupt.message, 'assistant');

  // Build the button bar — it lives in the footer at the same height as the input
  const interruptEl = document.createElement('div');
  interruptEl.id = 'interrupt-bar';

  const btnRow = document.createElement('div');
  btnRow.id = 'interrupt-buttons';

  if (interrupt.options) {
    interrupt.options.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.className = 'interrupt-btn';
      btn.textContent = label;
      btn.style.animationDelay = `${i * 70}ms`;
      btn.addEventListener('click', () => {
        const chosen = label;
        dismissInterrupt(() => {
          // After dismiss animation, fire the chosen option as a message
          userInput.value = chosen;
          sendMessage();
        });
      });
      btnRow.appendChild(btn);
    });
  }

  interruptEl.appendChild(btnRow);
  // Append to footer — CSS positions it as absolute overlay over input-wrapper
  footer.appendChild(interruptEl);

  // Double rAF: element needs to be in DOM before transition class fires
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      interruptEl.classList.add('visible');
    });
  });
}

// onDismiss callback: optional fn to run after animation completes
function dismissInterrupt(onDismiss) {
  const inputWrapper = document.getElementById('input-wrapper');
  const interruptEl = document.getElementById('interrupt-bar');

  if (interruptEl) {
    interruptEl.classList.remove('visible');
    setTimeout(() => {
      interruptEl.remove();
      if (onDismiss) onDismiss();
    }, 350);
  } else {
    if (onDismiss) onDismiss();
  }

  userInput.placeholder = "Let's find a groove...";
  pendingFavoriteInput = false;

  // If no callback (e.g. user hit No), fade input back in
  if (!onDismiss) {
    setTimeout(fadeInInput, 350);
  }
  // If there IS a callback (Yes path), sendMessage() will handle its own flow
  // and fadeOutInput is already in effect — no double-fade needed
}

// =====================
// TOAST NOTIFICATION
// =====================
function showToast(message, linkUrl) {
  const existing = document.getElementById('status-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'status-toast';

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message + ' ';

  if (linkUrl) {
    const link = document.createElement('a');
    link.href = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Check status →';
    link.className = 'toast-link';
    text.appendChild(link);
  }

  const dismiss = document.createElement('button');
  dismiss.className = 'toast-dismiss';
  dismiss.innerHTML = '&times;';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.addEventListener('click', () => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  });

  toast.appendChild(text);
  toast.appendChild(dismiss);
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('visible'));
  });
}

sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// =====================
// VOICE EMBED
//
// Usage:
//   const el = createVoiceEmbed('/audio/intro.m4a', 'Welcome');
//   chatMessages.appendChild(el);
//
// - First play shows "new transmission"
// - Subsequent plays show "replaying transmission"
// - Waveform is mirrored from center (symmetric)
// - Signal line oscillates at fixed rate, independent of audio data
// =====================
// Pass { controls: true } for a control bar under the waveform: play/pause, a draggable
// scrubber and timecodes. Episode transmissions use it; the welcome and Groove messages
// in Explore do not, and behave exactly as before.
function createVoiceEmbed(audioUrl, title = 'Welcome', { controls = false } = {}) {

  // ── DOM ──────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'voice-embed';

  // Waveform layer
  const waveLayer = document.createElement('div');
  waveLayer.className = 'voice-embed__waveform';

  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'voice-embed__canvas';
  waveLayer.appendChild(waveCanvas);

  // Transmission indicator
  const tx = document.createElement('span');
  tx.className = 'voice-embed__tx';

  const txLabel = document.createElement('span');
  txLabel.className = 'voice-embed__tx-label';
  txLabel.textContent = 'new transmission';

  const txSquare = document.createElement('span');
  txSquare.className = 'voice-embed__tx-square';

  const signalCanvas = document.createElement('canvas');
  signalCanvas.className = 'voice-embed__signal';

  tx.appendChild(txLabel);
  tx.appendChild(txSquare);
  tx.appendChild(signalCanvas);
  waveLayer.appendChild(tx);

  // Static layer
  const staticLayer = document.createElement('div');
  staticLayer.className = 'voice-embed__static';

  const titleEl = document.createElement('span');
  titleEl.className = 'voice-embed__title';
  titleEl.innerHTML = title.replace('\n', '<br>');

  const playBtn = document.createElement('button');
  playBtn.className = 'voice-embed__play-btn';
  playBtn.setAttribute('aria-label', 'Replay ' + title);
  playBtn.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 2.5L13 8L4 13.5V2.5Z" stroke-width="1.5" stroke-linejoin="round"/>' +
    '</svg>';

  staticLayer.appendChild(titleEl);
  staticLayer.appendChild(playBtn);

  // Audio
  const audio = document.createElement('audio');
  audio.src = audioUrl;
  audio.preload = 'auto';

  wrap.appendChild(waveLayer);
  wrap.appendChild(staticLayer);
  wrap.appendChild(audio);

  // Control bar (optional): play/pause, current time, scrubber, total time
  let toggleBtn, seek, currentEl, totalEl;
  if (controls) {
    wrap.classList.add('voice-embed--controls');
    const bar = document.createElement('div');
    bar.className = 'voice-embed__controls';

    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'voice-embed__toggle';

    currentEl = document.createElement('span');
    currentEl.className = 'voice-embed__clock';
    currentEl.textContent = '0:00';

    // A native range input: draggable by mouse and touch, and keyboard-operable for free
    seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'voice-embed__seek';
    seek.min = '0';
    seek.max = '1000';
    seek.step = '1';
    seek.value = '0';
    seek.setAttribute('aria-label', 'Position in message');

    totalEl = document.createElement('span');
    totalEl.className = 'voice-embed__clock';
    totalEl.textContent = '0:00';

    bar.append(toggleBtn, currentEl, seek, totalEl);
    wrap.appendChild(bar);
  }

  // ── State ─────────────────────────────────────────────────────────
  let audioCtx, analyser, source, dataArray, bufLen;
  let audioReady   = false;
  let waveAnimId   = null;
  let signalAnimId = null;
  let hasPlayed    = false;

  // ── Web Audio ─────────────────────────────────────────────────────
  // With a control bar we never route playback through Web Audio. iOS suspends an
  // AudioContext when the screen locks or Safari is backgrounded, which silences any
  // <audio> connected to it; a plain <audio> keeps playing. The waveform is drawn from
  // the decoded file instead (see loadPeaks), so it needs no live analyser.
  function initAudio() {
    if (audioReady || controls) return;
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    bufLen    = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufLen);
    source    = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    audioReady = true;
  }

  // ── Canvas sizing ─────────────────────────────────────────────────
  const WAVE_TOP_GAP = 34;   // px kept clear above the waveform when a control bar is present

  function resizeWaveCanvas() {
    const dpr  = window.devicePixelRatio || 1;
    const pad  = 16;
    const rect = (controls ? waveLayer : wrap).getBoundingClientRect();
    // With a control bar the waveform sits below the "new transmission" label, not behind it
    const height = controls ? Math.max(0, rect.height - WAVE_TOP_GAP) : rect.height;
    const w    = (rect.width - pad * 2) * dpr;
    const h    = height * dpr;
    waveCanvas.width  = w;
    waveCanvas.height = h;
    waveCanvas.style.width  = (rect.width - pad * 2) + 'px';
    waveCanvas.style.height = height + 'px';
  }

  function initSignalCanvas() {
    const dpr = window.devicePixelRatio || 1;
    signalCanvas.width  = 32 * dpr;
    signalCanvas.height = 10 * dpr;
  }

  // ── Color helpers ─────────────────────────────────────────────────
  function getWaveColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      unplayed: cs.getPropertyValue('--wave-color').trim()        || 'rgba(245,242,238,0.45)',
      played:   cs.getPropertyValue('--wave-played-color').trim() || 'rgba(245,242,238,0.88)',
    };
  }

  function getSignalColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      track: cs.getPropertyValue('--wave-color').trim()        || 'rgba(245,242,238,0.45)',
      line:  cs.getPropertyValue('--wave-played-color').trim() || 'rgba(245,242,238,0.88)',
    };
  }

  // ── Draw waveform (mirrored from center) ──────────────────────────
  function drawWave() {
    waveAnimId = requestAnimationFrame(drawWave);
    paintWave(true);
  }

  // ── Whole-message waveform (control-bar mode) ─────────────────────
  // Loudness of the entire recording, left to right, with the played part brighter.
  let peaks = null;         // Float32Array of 0..1 levels once the file is decoded
  let scrubRatio = null;    // 0..1 while a finger or mouse is dragging the scrubber

  function paintPeaks() {
    const dpr = window.devicePixelRatio || 1;
    const W   = waveCanvas.width;
    const H   = waveCanvas.height;
    if (!W || !H) return;
    const ctx      = waveCanvas.getContext('2d');
    const colors   = getWaveColors();
    const progress = scrubRatio !== null ? scrubRatio : (audio.duration ? audio.currentTime / audio.duration : 0);

    ctx.clearRect(0, 0, W, H);

    const barW    = 2 * dpr;
    const gap     = 3 * dpr;
    const count   = Math.max(1, Math.floor((W + gap) / (barW + gap)));
    const maxBarH = H * 0.9;
    const minBarH = 3 * dpr;
    const centerY = H / 2;

    for (let i = 0; i < count; i++) {
      const level = peaks ? peaks[Math.min(peaks.length - 1, Math.floor((i / count) * peaks.length))] : 0;
      const barH  = minBarH + level * (maxBarH - minBarH);
      ctx.fillStyle = (i + 0.5) / count <= progress ? colors.played : colors.unplayed;
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), centerY - barH / 2, barW, barH, barW / 2);
      ctx.fill();
    }
  }

  // Decode the file once with an OfflineAudioContext (which never touches the device's
  // audio session) and reduce it to a few hundred loudness values.
  async function loadPeaks() {
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Offline) return;
      const buffer  = await (await fetch(audioUrl)).arrayBuffer();
      const ctx     = new Offline(1, 2, 44100);
      const decoded = await new Promise((resolve, reject) => {
        const maybePromise = ctx.decodeAudioData(buffer, resolve, reject);   // old Safari is callback-only
        if (maybePromise && maybePromise.catch) maybePromise.catch(reject);
      });
      const samples = decoded.getChannelData(0);
      const buckets = 240;
      const size    = Math.max(1, Math.floor(samples.length / buckets));
      const levels  = new Float32Array(buckets);
      let loudest = 0;
      for (let b = 0; b < buckets; b++) {
        let peak = 0;
        for (let j = b * size, end = Math.min(samples.length, j + size); j < end; j += 8) {
          const v = Math.abs(samples[j]);
          if (v > peak) peak = v;
        }
        levels[b] = peak;
        if (peak > loudest) loudest = peak;
      }
      if (loudest > 0) for (let b = 0; b < buckets; b++) levels[b] = Math.pow(levels[b] / loudest, 0.8);
      peaks = levels;
      resizeWaveCanvas();
      paintPeaks();
    } catch { /* decoding failed — the flat placeholder bars stay */ }
  }

  // live=false paints flat bars (used while paused), still coloured by progress
  function paintWave(live) {
    if (controls) { paintPeaks(); return; }
    if (!audioReady) return;
    if (live) analyser.getByteFrequencyData(dataArray);
    else dataArray.fill(0);

    const dpr      = window.devicePixelRatio || 1;
    const W        = waveCanvas.width;
    const H        = waveCanvas.height;
    const ctx      = waveCanvas.getContext('2d');
    const colors   = getWaveColors();
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;

    ctx.clearRect(0, 0, W, H);

    const halfCount = 30;
    const barW      = 2 * dpr;
    const totalBarW = halfCount * 2 * barW;
    const gap       = (W - totalBarW) / (halfCount * 2 - 1);
    const maxBarH   = H * 0.72;
    const minBarH   = 3 * dpr;
    const centerY   = H / 2;
    const centerX   = W / 2;

    for (let i = 0; i < halfCount; i++) {
      const binIdx = Math.floor((i / halfCount) * bufLen * 0.75);
      const rawVal = dataArray[binIdx] / 255;
      const barH   = minBarH + rawVal * (maxBarH - minBarH);
      const offset = i * (barW + gap);

      const xR = centerX + offset + gap / 2;
      const xL = centerX - offset - barW - gap / 2;

      const normPos  = (centerX + offset) / W;
      const isPlayed = normPos < (0.5 + progress * 0.5);

      ctx.fillStyle = isPlayed ? colors.played : colors.unplayed;

      ctx.beginPath();
      ctx.roundRect(xR, centerY - barH / 2, barW, barH, barW / 2);
      ctx.fill();

      ctx.beginPath();
      ctx.roundRect(xL, centerY - barH / 2, barW, barH, barW / 2);
      ctx.fill();
    }
  }

  // ── Draw signal line (fixed-rate oscillation, not audio-driven) ───
  function drawSignal(ts) {
    signalAnimId = requestAnimationFrame(drawSignal);

    const dpr    = window.devicePixelRatio || 1;
    const W      = signalCanvas.width;
    const H      = signalCanvas.height;
    const ctx    = signalCanvas.getContext('2d');
    const colors = getSignalColors();
    const t      = ts / 1000;
    const freq   = 0.5;   // 1 full cycle every 2 seconds
    const cy     = H / 2;
    const amp    = H * 0.46;
    const pts    = 48;

    ctx.clearRect(0, 0, W, H);

    // Track — dim straight baseline
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(W, cy);
    ctx.strokeStyle = colors.track;
    ctx.lineWidth   = 1 * dpr;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Oscillating signal
    ctx.beginPath();
    for (let i = 0; i <= pts; i++) {
      const x     = (i / pts) * W;
      const phase = (i / pts) * Math.PI * 2 - t * freq * Math.PI * 2;
      const y     = cy + Math.sin(phase) * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = colors.line;
    ctx.lineWidth   = 1 * dpr;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Layer transitions ─────────────────────────────────────────────
  function showWaveform() {
    waveLayer.classList.remove('fading');
    waveLayer.classList.add('visible');
    staticLayer.classList.remove('visible');
    tx.classList.add('active');
    if (!signalAnimId) {
      initSignalCanvas();
      signalAnimId = requestAnimationFrame(drawSignal);
    }
  }

  function showStatic() {
    waveLayer.classList.add('fading');
    tx.classList.remove('active');
    if (signalAnimId) {
      cancelAnimationFrame(signalAnimId);
      signalAnimId = null;
      signalCanvas.getContext('2d').clearRect(0, 0, signalCanvas.width, signalCanvas.height);
    }
    setTimeout(() => {
      // With a control bar, playback can restart during this fade — leave the waveform up
      if (!audio.paused) { waveLayer.classList.remove('fading'); return; }
      waveLayer.classList.remove('visible', 'fading');
      if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
      staticLayer.classList.add('visible');
    }, 1400);
  }

  // ── Playback ──────────────────────────────────────────────────────
  function startPlayback() {
    audio.currentTime = 0;
    const doPlay = () => audio.play().catch(() => {});
    // Resume must complete before play — a suspended context routes audio silently
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().then(doPlay, doPlay);
    } else {
      doPlay();
    }
  }

  function play() {
    initAudio();
    resizeWaveCanvas();
    // Label swap: first play vs replay
    txLabel.textContent = hasPlayed ? 'replaying transmission' : 'new transmission';
    hasPlayed = true;
    showWaveform();
    if (!waveAnimId) drawWave();
    startPlayback();
  }

  // ── Audio events ──────────────────────────────────────────────────
  audio.addEventListener('play', () => {
    if (waveAnimId) return;
    if (!audioReady) initAudio();
    showWaveform();
    drawWave();
  });

  audio.addEventListener('ended', () => {
    if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
    showStatic();
  });

  audio.addEventListener('error', () => {
    if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
    showStatic();
  });

  playBtn.addEventListener('click', play);

  // Resizing clears the canvas; the peaks waveform is static, so paint it again
  window.addEventListener('resize', () => { resizeWaveCanvas(); if (controls) paintPeaks(); });

  // Expose startPlayback() so the intro handler can call it synchronously
  // within the user gesture — setTimeout breaks the browser's autoplay permission.
  wrap.startPlayback = () => {
    resizeWaveCanvas();
    play();
    // If audio is still paused after 800ms (blocked), fall back to static UI
    const guard = setTimeout(() => { if (audio.paused) showStatic(); }, 800);
    audio.addEventListener('play', () => clearTimeout(guard), { once: true });
  };

  // ── Control bar behaviour ────────────────────────────────────────
  if (controls) {
    const ICON_PLAY  = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5L13 8L4 13.5V2.5Z" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke-width="2.25" stroke-linecap="round"/></svg>';
    const clock = s => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
    let completed = false;   // has it played through at least once?
    let pauseTimer = null;

    const setToggle = playing => {
      toggleBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      toggleBtn.classList.toggle('is-playing', playing);
      toggleBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    };

    // Put the thumb, the fill and the clock at a given 0..1 position
    const showRatio = ratio => {
      const seconds = ratio * (audio.duration || 0);
      seek.value = String(Math.round(ratio * 1000));
      seek.style.setProperty('--played', `${(ratio * 100).toFixed(2)}%`);
      seek.setAttribute('aria-valuetext', `${clock(seconds)} of ${clock(audio.duration)}`);
      currentEl.textContent = clock(seconds);
    };

    // Follow the audio — except while a finger owns the thumb, or while a seek is still
    // landing. On iOS currentTime reports the old position until the seek completes, and
    // following it then is what made the thumb snap back under a drag.
    let pendingSeek = false;
    let pendingTimer = null;
    const syncProgress = () => {
      if (scrubRatio !== null || pendingSeek) return;
      showRatio(audio.duration ? audio.currentTime / audio.duration : 0);
    };

    const commitSeek = ratio => {
      if (!audio.duration) return;
      pendingSeek = true;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { pendingSeek = false; }, 1500);   // in case 'seeked' never fires
      audio.currentTime = ratio * audio.duration;
      showRatio(ratio);
      paintPeaks();
    };
    audio.addEventListener('seeked', () => { pendingSeek = false; clearTimeout(pendingTimer); syncProgress(); });

    // Play from wherever the scrubber is; from the top if it had finished
    const resume = () => {
      initAudio();
      resizeWaveCanvas();
      if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.05)) audio.currentTime = 0;
      txLabel.textContent = completed ? 'replaying transmission' : 'new transmission';
      hasPlayed = true;
      const go = () => audio.play().catch(() => {});   // a blocked autoplay just leaves the play button
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().then(go, go);
      else go();
    };

    toggleBtn.addEventListener('click', () => (audio.paused ? resume() : audio.pause()));

    audio.addEventListener('play', () => {
      clearTimeout(pauseTimer);
      setToggle(true);
      showWaveform();
      if (!waveAnimId) drawWave();
    });

    audio.addEventListener('pause', () => {
      setToggle(false);
      if (audio.ended) return;   // the 'ended' handler takes it from here
      tx.classList.remove('active');
      if (signalAnimId) {
        cancelAnimationFrame(signalAnimId);
        signalAnimId = null;
        signalCanvas.getContext('2d').clearRect(0, 0, signalCanvas.width, signalCanvas.height);
      }
      // Let the bars settle, then stop animating and leave a flat, progress-coloured frame
      pauseTimer = setTimeout(() => {
        if (!audio.paused) return;
        if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
        paintWave(false);
      }, 350);
    });

    audio.addEventListener('ended', () => { completed = true; syncProgress(); });
    audio.addEventListener('timeupdate', syncProgress);
    audio.addEventListener('loadedmetadata', () => { totalEl.textContent = clock(audio.duration); syncProgress(); });
    if (audio.readyState >= 1) totalEl.textContent = clock(audio.duration);

    // Scrubbing by pointer. iPhone sliders only move when you grab the thumb itself and
    // ignore taps on the track, so we position the thumb ourselves: press anywhere on the
    // bar to jump there, drag to scrub, and the audio seeks when you let go.
    const THUMB_INSET = 8;   // half the thumb's width, so the ends of the track are reachable
    const ratioAt = e => {
      const r = seek.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left - THUMB_INSET) / (r.width - THUMB_INSET * 2)));
    };
    const moveScrub = e => {
      scrubRatio = ratioAt(e);
      showRatio(scrubRatio);
      paintPeaks();
    };
    seek.addEventListener('pointerdown', e => {
      if (!audio.duration || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      try { seek.setPointerCapture(e.pointerId); } catch { /* not capturable — moves still arrive while over the bar */ }
      moveScrub(e);
    });
    seek.addEventListener('pointermove', e => { if (scrubRatio !== null) moveScrub(e); });
    const endScrub = () => {
      if (scrubRatio === null) return;
      const ratio = scrubRatio;
      scrubRatio = null;
      commitSeek(ratio);
    };
    seek.addEventListener('pointerup', endScrub);
    seek.addEventListener('pointercancel', endScrub);

    // Arrow keys (and any native slider movement) arrive as input events
    seek.addEventListener('input', () => {
      if (scrubRatio !== null) return;
      commitSeek(Number(seek.value) / 1000);
    });

    loadPeaks();

    setToggle(false);
    syncProgress();

    wrap.resume = resume;
    wrap.pause  = () => audio.pause();
  }

  // Expose stop() so show mode can cut a transmission when the listener moves on:
  // rewinds and returns to the static layer, where the play button lives.
  wrap.stop = () => {
    if (audio.paused && audio.currentTime === 0) return;
    audio.pause();
    audio.currentTime = 0;
    if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
    showStatic();
  };

  return wrap;
}

// =====================
// INTRO SEQUENCE
//
// On load: body gets .intro-active — CSS hides textarea/send, shows start btn.
// Click "Start exploring":
//   1. Remove .intro-active — start btn hides
//   2. Fade out input (hidden while audio plays)
//   3. Wrap and append voice embed — fade it in (1.4s, matching Spotify)
//   4. Start hum at the same moment embed fades in
//   5. Input fades back in 1.5s before audio ends
//   6. Hum fades out a beat after audio ends
// =====================
(function initIntro() {
  const startBtn = document.getElementById('intro-start-btn');
  if (!startBtn) return;

  const STORAGE_KEY = 'efrain_fm_transmission';

  // ── Helper: build photo grid (shared by both paths) ───────────────────
  function buildPhotoGrid(immediate) {
    const allPhotos = [
      { src: '/images/photo1.jpg',  caption: 'One of my first California sunsets', hasMe: true },
      { src: '/images/photo2.jpg',  caption: 'This chicken cutlet is shaped like New Jersey', hasMe: false },
      { src: '/images/photo3.jpg',  caption: 'I made music for a while', hasMe: true },
      { src: '/images/photo4.jpg',  caption: 'My pup, Ernie', hasMe: false },
      { src: '/images/photo5.jpg',  caption: 'One is a professional wrestling champion, another is a product designer. Both are Cuban.', hasMe: true },
      { src: '/images/photo6.jpg',  caption: 'Caught my dog Ernie during the golden hour', hasMe: false },
      { src: '/images/photo7.jpg',  caption: 'Me, live in Hoboken way back as Rare Books', hasMe: true },
      { src: '/images/photo8.jpg',  caption: 'Camp day at Oscar with some awesome colleagues', hasMe: true },
      { src: '/images/photo9.jpg',  caption: "I won 2nd place two years in a row at Oscar's fun poker tournament. I was enjoying my opponents' body language here.", hasMe: true },
      { src: '/images/photo10.jpg', caption: 'Live shot from a Black Pumas show at Asbury Park', hasMe: false },
      { src: '/images/photo11.jpg', caption: 'Me and my fiancé Elaine at Niagara Falls', hasMe: true },
      { src: '/images/photo12.jpg', caption: 'Product designers from Cityblock making sandcastles together at a San Diego offsite', hasMe: false },
      { src: '/images/photo13.jpg', caption: "Let's go Mets!", hasMe: true },
      { src: '/images/photo14.jpg', caption: 'Always wanted one of these "stickies on a wall" photos - collaborating at Cityblock in Brooklyn', hasMe: false },
      { src: '/images/photo15.jpg', caption: 'A gift from my local record shop, a signed Tiny Tim 7"', hasMe: false },
      { src: '/images/photo16.jpg', caption: 'Cityblock engagement team offsite in Chicago, all trying to get that bean photo', hasMe: false },
      { src: '/images/photo17.jpg', caption: "I no longer have that mullet-y cut, but it was a fun time.", hasMe: true },
    ];

    // Pick 4: 1–2 with hasMe, rest without, then shuffle
    function pickPhotos(pool) {
      const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
      const mePool    = shuffle(pool.filter(p => p.hasMe));
      const otherPool = shuffle(pool.filter(p => !p.hasMe));
      const meCount   = Math.floor(Math.random() * 2) + 1; // 1 or 2
      const picked    = [
        ...mePool.slice(0, meCount),
        ...otherPool.slice(0, 4 - meCount),
      ];
      return shuffle(picked);
    }

    const introPhotos = pickPhotos(allPhotos);

    const photoGrid = document.createElement('div');
    photoGrid.className = 'intro-photo-grid';

    const photoItems = introPhotos.map((p) => {
      const item = document.createElement('div');
      item.className = 'intro-photo-item';
      const img = document.createElement('img');
      img.src = p.src;
      img.alt = p.caption;
      img.draggable = false;
      item.appendChild(img);
      item.addEventListener('click', () => openLightbox(p.src, p.caption));
      photoGrid.appendChild(item);
      return item;
    });

    chatMessages.appendChild(photoGrid);
    scrollToBottom();

    if (immediate) {
      // Return visit: all photos already visible, no delay
      photoItems.forEach(item => item.classList.add('loaded'));
    } else {
      // First visit: stagger fade in starting 5s after audio begins
      photoItems.forEach((item, i) => {
        setTimeout(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              item.classList.add('loaded');
              scrollToBottom();
            });
          });
        }, 5000 + i * 1400);
      });
    }
  }

  // ── Helper: inject completed embed with saved title ────────────────────
  function injectCompletedEmbed(savedTitle) {
    const embed = createVoiceEmbed('/audio/AIntro.m4a', '');
    const wrapper = document.createElement('div');
    wrapper.className = 'voice-embed-wrapper';
    wrapper.appendChild(embed);
    chatMessages.appendChild(wrapper);

    // Show immediately in completed (static) state — no waveform, no fade sequence
    embed.classList.add('loaded');
    const staticLayer = embed.querySelector('.voice-embed__static');
    if (staticLayer) staticLayer.classList.add('visible');
    const titleEl = embed.querySelector('.voice-embed__title');
    if (titleEl) {
      titleEl.innerHTML = savedTitle;
      titleEl.dataset.durationSet = '1';
    }

    scrollToBottom();
  }

  // ── RETURN VISIT ───────────────────────────────────────────────────────
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    document.body.classList.remove('intro-active');
    fadeInInput();
    injectCompletedEmbed(saved);
    buildPhotoGrid(true);
    const needsPlayerPick = !localStorage.getItem(PLAYER_KEY);
    setTimeout(() => {
      if (needsPlayerPick) {
        showPlayerPicker("Welcome back — I made some changes and can now share music in new ways. Which do you use to listen to music?");
      } else {
        addMessageToChatWithTyping("Thanks for coming back. What are you looking for?", 'assistant');
      }
    }, 1400);
    return;
  }

  // ── FIRST VISIT ────────────────────────────────────────────────────────
  document.body.classList.add('intro-active');

  startBtn.addEventListener('click', () => {
    // Pre-hide input wrapper first so it doesn't flash when intro-active is removed
    const inputWrapper = document.getElementById('input-wrapper');
    inputWrapper.style.opacity = '0';
    inputWrapper.style.pointerEvents = 'none';
    document.body.classList.remove('intro-active');

    // Capture time at moment of click
    const now = new Date();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const yy   = String(now.getFullYear()).slice(-2);
    const hours = now.getHours();
    const mins  = String(now.getMinutes()).padStart(2, '0');
    const ampm  = hours >= 12 ? 'PM' : 'AM';
    const h12   = String(hours % 12 || 12).padStart(2, '0');

    const embed = createVoiceEmbed('/audio/AIntro.m4a', '');
    const wrapper = document.createElement('div');
    wrapper.className = 'voice-embed-wrapper';
    wrapper.appendChild(embed);
    chatMessages.appendChild(wrapper);
    scrollToBottom();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => embed.classList.add('loaded'));
    });

    embed.startPlayback();

    const voiceAudio = embed.querySelector('audio');
    if (voiceAudio) {
      // No early fadeInInput here — showPlayerPicker handles input restoration
      voiceAudio.addEventListener('ended', () => {
        const secs    = Math.round(voiceAudio.duration);
        const titleEl = embed.querySelector('.voice-embed__title');
        if (titleEl && !titleEl.dataset.durationSet) {
          const fullTitle = `TRANSMISSION //<br>WELCOME MSG, ON AIR <span class="voice-embed__date">${mm}-${dd}-${yy}</span><span class="voice-embed__time"> ${h12}:${mins} ${ampm} [${secs}s]</span>`;
          titleEl.innerHTML = fullTitle;
          titleEl.dataset.durationSet = '1';
          localStorage.setItem(STORAGE_KEY, fullTitle);
        }
        // Show player picker after a short breath
        setTimeout(() => showPlayerPicker(undefined, { offerEpisode: true }), 800);
      });
    }

    buildPhotoGrid(false);
  });
})();

// =====================
// INTRO LIGHTBOX
// =====================
(function initLightbox() {
  const scrim = document.createElement('div');
  scrim.className = 'intro-lightbox-scrim';

  const img = document.createElement('img');
  img.className = 'intro-lightbox-img';
  img.alt = '';

  const caption = document.createElement('p');
  caption.className = 'intro-lightbox-caption';

  scrim.appendChild(img);
  scrim.appendChild(caption);
  scrim.style.display = 'none';
  document.body.appendChild(scrim);

  scrim.addEventListener('click', closeLightbox);

  window.openLightbox = function(src, text) {
    img.src = src;
    caption.textContent = text;
    scrim.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrim.classList.add('visible'));
    });
  };

  function closeLightbox() {
    scrim.classList.remove('visible');
    scrim.addEventListener('transitionend', () => {
      scrim.style.display = 'none';
      img.src = '';
    }, { once: true });
  }
})();

// =====================
// GROOVE MAP — radio button + Three.js rock modal
// =====================
(function initGrooveMap() {

  const mapBtn   = document.getElementById('groove-map-btn');
  const modal    = document.getElementById('groove-modal');
  const closeBtn = document.getElementById('groove-modal-close');
  const card         = document.getElementById('groove-zone-card');
  const cardPreTitle = document.getElementById('groove-card-pretitle');
  const cardTitle    = document.getElementById('groove-card-title');
  const cardFill     = document.getElementById('groove-card-fill');
  const cardLabel    = document.getElementById('groove-card-label');
  const cardCta      = document.getElementById('groove-card-cta');
  const prevBtn      = document.getElementById('groove-prev');
  const nextBtn      = document.getElementById('groove-next');
  if (!mapBtn || !modal) return;

  let clickLocked = false;

  // ── All-time cluster play counts ──────────────────────────────────────
  const CLUSTER_PLAYS_KEY = 'efrain_fm_cluster_plays';
  function getAllTimePlays() {
    try { return JSON.parse(localStorage.getItem(CLUSTER_PLAYS_KEY)) || {}; } catch { return {}; }
  }
  function saveAllTimePlays(counts) {
    localStorage.setItem(CLUSTER_PLAYS_KEY, JSON.stringify(counts));
  }
  const persistedCounts = getAllTimePlays();
  Object.assign(clusterPlayCounts, persistedCounts);

  function recordClusterPlay(cluster) {
    clusterPlayCounts[cluster] = (clusterPlayCounts[cluster] || 0) + 1;
    saveAllTimePlays(clusterPlayCounts);
  }
  window.recordClusterPlay = recordClusterPlay;

  // ── Visibility ────────────────────────────────────────────────────────
  function syncButtonVisibility() {
    const count = grooveState.unlockedClusters.length;
    // The button is always shown in Explore now (see #groove-map-btn in style.css)
    const subtitleEl = document.getElementById('groove-modal-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = count >= 9 ? 'All 9 unlocked' : `${count} of 9 unlocked`;
    }
  }
  syncButtonVisibility();
  window.addEventListener('grooveRingUnlock', syncButtonVisibility);

  // ── Zone card ─────────────────────────────────────────────────────────
  const CLUSTER_INDEX    = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5, C6: 6, C7: 7, C8: 8, C9: 9 };
  const UNLOCK_THRESHOLD = 3;

  function showZoneCard(zone) {
    if (!card || !zone) return;
    syncNavIdx(zone);
    const idx    = CLUSTER_INDEX[zone.cluster] || '—';
    const total  = zone.songs || 0;
    const played = clusterPlayCounts[zone.cluster] || 0;

    cardPreTitle.textContent = `Cluster ${idx}`;
    cardTitle.textContent    = zone.label;

    if (zone.discovered) {
      card.classList.remove('locked');
      const pct = total > 0 ? Math.min(100, Math.round((played / total) * 100)) : 0;
      if (cardFill) { cardFill.style.width = `${pct}%`; cardFill.classList.remove('unlock'); }
      if (cardLabel) cardLabel.textContent = `${played} of ${total} songs discovered`;
      if (cardCta)   cardCta.textContent   = 'Replay groove';
    } else {
      card.classList.add('locked');
      const playsLeft = Math.max(0, UNLOCK_THRESHOLD - played);
      const unlockPct = Math.min(100, Math.round((played / UNLOCK_THRESHOLD) * 100));
      if (cardFill) { cardFill.style.width = `${unlockPct}%`; cardFill.classList.add('unlock'); }
      if (cardLabel) cardLabel.textContent = playsLeft > 0
        ? `Discover ${playsLeft} more song${playsLeft === 1 ? '' : 's'} to unlock`
        : 'Ready to unlock';
      if (cardCta)   cardCta.textContent   = `Discover ${zone.label} song`;
    }

    card.classList.add('visible');
  }

  function hideZoneCard() {
    if (card) card.classList.remove('visible');
  }

  // ── Modal open / close ────────────────────────────────────────────────
  function openModal() {
    clickLocked = false;
    modal.classList.add('open');
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('visible')));
    initRock();
  }

  function closeModal() {
    modal.classList.remove('visible');
    modal.addEventListener('transitionend', () => {
      modal.classList.remove('open');
      destroyRock();
    }, { once: true });
  }

  mapBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });

  // ── Three.js state ────────────────────────────────────────────────────
  let renderer, scene, camera, group, animId;
  let zoneMeshes = [];
  let pointerDown = false, hasDragged = false;
  let dragStartX = 0, dragStartY = 0;
  let velX = 0, velY = 0;
  let autoRotate = true;
  let autoRotateTimer = null;
  let hoveredZone = null;
  let activeZone  = null;
  // Tween state — null when idle
  let tweenTargetY  = null;
  let tweenTargetX  = null;
  let navZoneIdx    = 0;

  // Auto-rotation speed (rad/frame). Increased ~15% from 0.0026.
  const AUTO_ROT_SPEED = 0.003;
  // Tween: ease-out factor. Starts fast, decelerates.
  const TWEEN_FACTOR   = 0.10;
  // Arrival threshold
  const TWEEN_THRESH   = 0.005;
  // Pulse: 3s cycle, drives emissive brightness ±30%
  const PULSE_PERIOD   = 3; // seconds

  // Normalise any angle to [-PI, PI]
  function normAngle(a) {
    return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  // CTA button — closes modal and fires the zone action
  if (cardCta) {
    cardCta.addEventListener('click', () => {
      if (activeZone && !clickLocked) {
        clickLocked = true;
        handleZoneClick(activeZone);
      }
    });
  }

  // ── Caret navigation ──────────────────────────────────────────────────
  const NAV_ORDER = ['C1','C2','C3','C4','C5','C6','C7','C8','C9'];

  let KEYFRAMES = {};

  function computeKeyframes() {
    // Solved by grid search using correct Three.js Euler XYZ order (Rx then Ry)
    // and actual camera projection (FOV=38, z=7.2, aspect=1).
    // All values verified to project zone centroid to (0,0) on screen.
    KEYFRAMES = {
      C1: { rotY:  2.543, rotX: -0.795 },
      C2: { rotY:  0.629, rotX: -0.760 },
      C3: { rotY: -0.792, rotX: -0.044 },
      C4: { rotY:  0.795, rotX:  0.445 },
      C5: { rotY:  1.691, rotX: -0.121 },
      C6: { rotY: -2.117, rotX: -0.348 },
      C7: { rotY: -3.006, rotX:  0.202 },
      C8: { rotY:  2.543, rotX:  1.230 },
      C9: { rotY: -0.584, rotX: -1.040 },
    };
  }

  function resumeAutoRotate() {
    autoRotate = true;
    tweenTargetY = null;
    tweenTargetX = null;
    velX = velY = 0;
  }

  function scheduleAutoRotate(ms) {
    clearTimeout(autoRotateTimer);
    autoRotateTimer = setTimeout(resumeAutoRotate, ms);
  }

  function syncNavIdx(zone) {
    const i = NAV_ORDER.indexOf(zone.cluster);
    if (i !== -1) navZoneIdx = i;
  }

  // ── Fade/pulse helpers ────────────────────────────────────────────────
  function clearFade(zm) {
    if (!zm) return;
    zm._fadeDir = null;
    zm._fadeProgress = null;
  }

  function deactivateAllExcept(keepZm) {
    zoneMeshes.forEach(zm => {
      if (zm !== keepZm) {
        zm._pulsing = false;
        zm._fadeDir = null;
        zm._fadeProgress = null;
        zm._selectedStateApplied = false;
        applyMatState(zm, defaultState(zm));
      }
    });
  }

  // Make a zone the active selection: snap to hover state instantly, no fade flash
  function selectZone(zm) {
    if (!zm) return;
    deactivateAllExcept(zm);
    hoveredZone   = null;
    activeZone    = zm;
    zm._pulsing   = true;
    zm._fadeDir   = null;
    zm._fadeProgress = null;
    const hover = zm.discovered ? 'hoverDiscovered' : 'hoverUndiscovered';
    applyMatState(zm, hover);
    syncNavIdx(zm);
    showZoneCard(zm);
  }

  // Tween rock to face a keyframe position
  function tweenToKeyframe(cluster) {
    const kf = KEYFRAMES[cluster];
    if (!kf || !group) return;
    // Normalise current rotation before setting target so shortest arc is guaranteed
    group.rotation.y = normAngle(group.rotation.y);
    tweenTargetY = kf.rotY;
    tweenTargetX = kf.rotX;
    autoRotate   = false;
    velX = velY  = 0;
  }

  function navToIndex(idx) {
    if (!Object.keys(KEYFRAMES).length) return;
    navZoneIdx = ((idx % NAV_ORDER.length) + NAV_ORDER.length) % NAV_ORDER.length;
    const cluster = NAV_ORDER[navZoneIdx];
    const zm = zoneMeshes.find(z => z.cluster === cluster);
    if (!zm) return;
    selectZone(zm);
    tweenToKeyframe(cluster);
    scheduleAutoRotate(700);
  }

  if (prevBtn) prevBtn.addEventListener('click', () => navToIndex(navZoneIdx - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => navToIndex(navZoneIdx + 1));

  const ZONES = [
    { cluster: 'C8', label: 'Memory',   songs: 110 },
    { cluster: 'C4', label: 'Cosmic',   songs: 103 },
    { cluster: 'C7', label: 'Art',      songs: 101 },
    { cluster: 'C3', label: 'Raw',      songs: 92  },
    { cluster: 'C5', label: 'Soul',     songs: 72  },
    { cluster: 'C6', label: 'Loss',     songs: 71  },
    { cluster: 'C2', label: 'Night',    songs: 68  },
    { cluster: 'C1', label: 'Outsider', songs: 67  },
    { cluster: 'C9', label: 'Static',   songs: 26  },
  ];
  const TOTAL_SONGS = ZONES.reduce((s, z) => s + z.songs, 0);

  // Zone material colors — three states per zone type
  const MAT = {
    undiscovered:      { color: 0x1a1a1a, emissive: 0x000000, specular: 0x2a2a2a, shininess: 5  },
    discovered:        { color: 0x4a2a18, emissive: 0x1a0a02, specular: 0xc87941, shininess: 60 },
    hoverUndiscovered: { color: 0x3a3d2e, emissive: 0x0e100a, specular: 0x6a7850, shininess: 22 },
    hoverDiscovered:   { color: 0x6a3c22, emissive: 0x220e04, specular: 0xd88848, shininess: 68 },
    // Selected + discovered: noticeably brighter than resting copper, static
    selectedDiscovered: { color: 0x7a4828, emissive: 0x9a4a10, specular: 0xd88848, shininess: 68 },
  };

  function lerpHex(a, b, t) {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return ((ar + (br - ar) * t) << 16) | ((ag + (bg - ag) * t) << 8) | (ab + (bb - ab) * t);
  }

  function applyMatState(zm, state) {
    zm.mat.color.setHex(MAT[state].color);
    zm.mat.emissive.setHex(MAT[state].emissive);
    zm.mat.specular.setHex(MAT[state].specular);
    zm.mat.shininess = MAT[state].shininess;
    clearFade(zm);
  }

  function defaultState(zm) {
    return zm.discovered ? 'discovered' : 'undiscovered';
  }

  function seededRand(seed) {
    let s = seed;
    return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  function buildIrregularGeo(seed, baseR, jitterAmt) {
    const geo  = new THREE.IcosahedronGeometry(baseR, 2);
    const pos  = geo.attributes.position;
    const rand = seededRand(seed);
    const vertMap = new Map();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
      if (!vertMap.has(k)) {
        const v = new THREE.Vector3(x, y, z).normalize();
        const wave =
          Math.sin(v.x * 1.8 + v.y * 2.9) * 0.45 +
          Math.sin(v.y * 2.4 + v.z * 1.6) * 0.35 +
          Math.cos(v.z * 3.3 + v.x * 1.2) * 0.20;
        const radialPush  = jitterAmt * (0.5 + wave * 0.9);
        const lateralNoise = jitterAmt * 0.22;
        vertMap.set(k, v.clone().multiplyScalar(radialPush).add(
          new THREE.Vector3(
            (rand() - 0.5) * lateralNoise,
            (rand() - 0.5) * lateralNoise,
            (rand() - 0.5) * lateralNoise
          )
        ));
      }
    }
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const j = vertMap.get(`${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`);
      pos.setXYZ(i, x + j.x, y + j.y, z + j.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  function buildZonedRock() {
    const geo = buildIrregularGeo(42, 1.6, 0.72);
    const pos = geo.attributes.position;

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const N = ZONES.length;
    const seeds = ZONES.map((z, i) => {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = goldenAngle * i;
      return {
        pos:    new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta)).normalize(),
        weight: z.songs / TOTAL_SONGS,
      };
    });

    const faceCount = pos.count / 3;
    const faceZones = new Int32Array(faceCount);

    for (let f = 0; f < faceCount; f++) {
      const centroid = new THREE.Vector3(
        (pos.getX(f*3) + pos.getX(f*3+1) + pos.getX(f*3+2)) / 3,
        (pos.getY(f*3) + pos.getY(f*3+1) + pos.getY(f*3+2)) / 3,
        (pos.getZ(f*3) + pos.getZ(f*3+1) + pos.getZ(f*3+2)) / 3
      ).normalize();
      let bestScore = -Infinity, bestIdx = 0;
      seeds.forEach((s, i) => {
        const score = centroid.dot(s.pos) + s.weight * 2.2;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      });
      faceZones[f] = bestIdx;
    }

    const discovered = new Set(grooveState.unlockedClusters);
    zoneMeshes = [];

    ZONES.forEach((zone, zIdx) => {
      const isDiscovered = discovered.has(zone.cluster);
      const indices = [];
      for (let f = 0; f < faceCount; f++) {
        if (faceZones[f] === zIdx) indices.push(f*3, f*3+1, f*3+2);
      }
      if (!indices.length) return;

      const zoneGeo = new THREE.BufferGeometry();
      const verts = new Float32Array(indices.length * 3);
      const norms = new Float32Array(indices.length * 3);
      const nAttr = geo.attributes.normal;
      indices.forEach((vi, i) => {
        verts[i*3]   = pos.getX(vi); verts[i*3+1] = pos.getY(vi); verts[i*3+2] = pos.getZ(vi);
        norms[i*3]   = nAttr.getX(vi); norms[i*3+1] = nAttr.getY(vi); norms[i*3+2] = nAttr.getZ(vi);
      });
      zoneGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      zoneGeo.setAttribute('normal',   new THREE.BufferAttribute(norms, 3));

      const state = isDiscovered ? 'discovered' : 'undiscovered';
      const mat = new THREE.MeshPhongMaterial({
        color:     MAT[state].color,
        emissive:  MAT[state].emissive,
        specular:  MAT[state].specular,
        shininess: MAT[state].shininess,
        flatShading: true,
      });

      const mesh = new THREE.Mesh(zoneGeo, mat);
      mesh.scale.setScalar(0.964);
      group.add(mesh);

      zoneMeshes.push({ mesh, mat, cluster: zone.cluster, label: zone.label, songs: zone.songs, discovered: isDiscovered });
    });

    // Inner void sphere — crack depth illusion
    group.add(new THREE.Mesh(
      buildIrregularGeo(42, 1.44, 0.72),
      new THREE.MeshPhongMaterial({ color: 0x040404, side: THREE.BackSide, flatShading: true })
    ));
  }

  function initRock() {
    if (renderer) return;

    const canvas    = document.getElementById('groove-rock-canvas');
    const container = document.getElementById('groove-rock-container');
    const W = container.clientWidth  || 300;
    const H = container.clientHeight || 300;

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);

    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 100);
    camera.position.z = 7.2; // pulled back to avoid clipping

    scene.add(new THREE.AmbientLight(0x2a2a2a, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-2, 3, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(0x888888, 0.3);
    fill.position.set(3, -1, 1); scene.add(fill);
    const rim = new THREE.DirectionalLight(0x444444, 0.45);
    rim.position.set(0.5, -2, -3); scene.add(rim);
    // Copper backlight — animates between gray and warm copper
    const rimCopper = new THREE.DirectionalLight(0xc87941, 0.0);
    rimCopper.position.set(0.5, -2, -3); scene.add(rimCopper);

    group = new THREE.Group();
    scene.add(group);
    window._rockGroup = group; // diagnostic: lets you run group.rotation in console
    buildZonedRock();
    computeKeyframes(); // must run after zoneMeshes are populated

    // CSS glow — radial gradient div sitting behind the canvas in DOM space.
    // Lives outside the WebGL context so it can bleed past canvas bounds freely.
    const glowDiv = document.createElement('div');
    glowDiv.id = 'groove-rock-glow';
    glowDiv.style.cssText = 'position:absolute;inset:-30px;border-radius:50%;background:radial-gradient(ellipse at center,rgba(245,242,238,0.22) 0%,rgba(232,228,222,0.10) 35%,rgba(220,216,210,0.04) 60%,transparent 78%);pointer-events:none;z-index:0;';
    container.appendChild(glowDiv);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function getZoneAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      mouse.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
      mouse.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(zoneMeshes.map(z => z.mesh));
      if (!hits.length) return null;
      return zoneMeshes.find(z => z.mesh === hits[0].object) || null;
    }

    function setHover(zone) {
      if (hoveredZone === zone) return;
      hoveredZone = zone;
      canvas.style.cursor = zone ? 'pointer' : 'default';
    }

    // ── Pointer events ────────────────────────────────────────────────
    function onPointerDown(clientX, clientY) {
      pointerDown = true;
      hasDragged  = false;
      dragStartX  = clientX;
      dragStartY  = clientY;
      velX = velY = 0;
      autoRotate  = false;
      tweenTargetY = null;
      tweenTargetX = null;
      clearTimeout(autoRotateTimer);
    }

    function onPointerMove(clientX, clientY) {
      if (!pointerDown) {
        setHover(getZoneAt(clientX, clientY));
        return;
      }
      const dx = clientX - dragStartX;
      const dy = clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged = true;
      // Normalise before applying drag so accumulated drift never builds up
      group.rotation.y = normAngle(group.rotation.y + dx * 0.005);
      group.rotation.x = Math.max(-1.6, Math.min(1.6, group.rotation.x + dy * 0.005));
      velX = dx * 0.005;
      velY = dy * 0.005;
      dragStartX = clientX;
      dragStartY = clientY;
    }

    function onPointerUp(clientX, clientY) {
      if (!pointerDown) return;
      pointerDown = false;
      if (!hasDragged) {
        const zone = getZoneAt(clientX, clientY);
        if (zone) {
          if (zone === activeZone) {
            // Tapping already-selected zone: reposition it to face camera, then resume
            tweenToKeyframe(zone.cluster);
            scheduleAutoRotate(700);
          } else {
            selectZone(zone);
            tweenToKeyframe(zone.cluster);
            scheduleAutoRotate(700);
          }
        } else {
          // Tapped empty space — resume rotation
          scheduleAutoRotate(700);
        }
      } else {
        // After drag — short pause then resume
        scheduleAutoRotate(700);
      }
    }

    // Mouse
    canvas.addEventListener('mousedown', (e) => onPointerDown(e.clientX, e.clientY));
    canvas.addEventListener('mousemove', (e) => onPointerMove(e.clientX, e.clientY));
    window.addEventListener('mouseup',   (e) => onPointerUp(e.clientX, e.clientY));
    canvas.addEventListener('mouseleave', () => {
      // Clear hover when pointer leaves canvas without button held
      if (!pointerDown) setHover(null);
    });

    // Touch
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      onPointerDown(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      onPointerUp(t.clientX, t.clientY);
    }, { passive: false });

    // Render loop
    function animate() {
      animId = requestAnimationFrame(animate);
      const now = performance.now() / 1000; // seconds

      // ── Always normalise rotation.y to [-PI, PI] ──────────────────
      // This is the key fix: accumulated drift can never build up, so
      // tween targets (which are in [-PI, PI]) are always reachable via
      // the shortest arc regardless of how much the user has dragged.
      group.rotation.y = normAngle(group.rotation.y);

      if (tweenTargetY !== null) {
        // Ease-out tween on both axes
        let diffY = tweenTargetY - group.rotation.y;
        if (diffY >  Math.PI) diffY -= Math.PI * 2;
        if (diffY < -Math.PI) diffY += Math.PI * 2;
        group.rotation.y += diffY * TWEEN_FACTOR;
        if (tweenTargetX !== null) {
          group.rotation.x += (tweenTargetX - group.rotation.x) * TWEEN_FACTOR;
        }
        // Arrived?
        if (Math.abs(diffY) < TWEEN_THRESH &&
            (tweenTargetX === null || Math.abs(tweenTargetX - group.rotation.x) < TWEEN_THRESH)) {
          group.rotation.y = tweenTargetY;
          if (tweenTargetX !== null) group.rotation.x = tweenTargetX;
          tweenTargetY = null;
          tweenTargetX = null;
        }
      } else if (autoRotate) {
        group.rotation.y += AUTO_ROT_SPEED;
        group.rotation.x += (0.15 - group.rotation.x) * 0.015;
      } else {
        // Post-drag momentum decay
        velX *= 0.92; velY *= 0.92;
        group.rotation.y += velX;
        group.rotation.x = Math.max(-1.6, Math.min(1.6, group.rotation.x + velY));
      }

      renderer.render(scene, camera);

      // ── Rim light copper pulse — 10s cycle, gray ↔ copper ────────────
      const rimT = (Math.sin((now / 10) * Math.PI * 2) + 1) / 2; // 0→1→0
      rim.intensity       = 0.45 * (1 - rimT);   // gray fades out
      rimCopper.intensity = 0.55 * rimT;          // copper fades in

      // ── Material fades (2s in, 1s out) ───────────────────────────────
      const FADE_IN_SPEED  = 1 / (2 * 60);
      const FADE_OUT_SPEED = 1 / (1 * 60);
      zoneMeshes.forEach(zm => {
        const hover = zm.discovered ? 'hoverDiscovered' : 'hoverUndiscovered';
        const def   = defaultState(zm);

        // Fade in / out
        if (zm._fadeDir) {
          if (zm._fadeDir === 'in') {
            zm._fadeProgress = Math.min(1, (zm._fadeProgress || 0) + FADE_IN_SPEED);
            const t = zm._fadeProgress;
            zm.mat.color.setHex(lerpHex(MAT[def].color, MAT[hover].color, t));
            zm.mat.emissive.setHex(lerpHex(MAT[def].emissive, MAT[hover].emissive, t));
            zm.mat.specular.setHex(lerpHex(MAT[def].specular, MAT[hover].specular, t));
            zm.mat.shininess = MAT[def].shininess + (MAT[hover].shininess - MAT[def].shininess) * t;
            if (zm._fadeProgress >= 1) clearFade(zm);
          } else if (zm._fadeDir === 'out') {
            zm._fadeProgress = Math.max(0, (zm._fadeProgress || 1) - FADE_OUT_SPEED);
            const t = zm._fadeProgress;
            zm.mat.color.setHex(lerpHex(MAT[def].color, MAT[hover].color, t));
            zm.mat.emissive.setHex(lerpHex(MAT[def].emissive, MAT[hover].emissive, t));
            zm.mat.specular.setHex(lerpHex(MAT[def].specular, MAT[hover].specular, t));
            zm.mat.shininess = MAT[def].shininess + (MAT[hover].shininess - MAT[def].shininess) * t;
            if (zm._fadeProgress <= 0) {
              clearFade(zm);
              applyMatState(zm, def);
            }
          }
        }

        // ── Selected zone state ───────────────────────────────────────
        if (zm._pulsing && zm === activeZone && !zm._fadeDir) {
          if (zm.discovered) {
            // Discovered + selected: apply brighter static copper, once on entry
            if (!zm._selectedStateApplied) {
              zm.mat.color.setHex(MAT.selectedDiscovered.color);
              zm.mat.emissive.setHex(MAT.selectedDiscovered.emissive);
              zm.mat.specular.setHex(MAT.selectedDiscovered.specular);
              zm.mat.shininess = MAT.selectedDiscovered.shininess;
              zm._selectedStateApplied = true;
            }
          } else {
            // Undiscovered + selected: keep existing pulse behaviour
            const sine   = (Math.sin((now / PULSE_PERIOD) * Math.PI * 2) + 1) / 2;
            const bright = 0.7 + sine * 0.3;
            const baseEmissive = MAT[hover].emissive;
            const r = ((baseEmissive >> 16) & 0xff) * bright | 0;
            const g = ((baseEmissive >>  8) & 0xff) * bright | 0;
            const b = ( baseEmissive        & 0xff) * bright | 0;
            zm.mat.emissive.setRGB(r / 255, g / 255, b / 255);
          }
        } else if (!zm._pulsing || zm !== activeZone) {
          zm._selectedStateApplied = false;
        }
      });

    }
    animate();

    // ── Default selection on open ─────────────────────────────────────
    const defaultCluster = grooveState.unlockedClusters.length
      ? grooveState.unlockedClusters[grooveState.unlockedClusters.length - 1]
      : 'C1';
    const defaultZm = zoneMeshes.find(z => z.cluster === defaultCluster);
    if (defaultZm) {
      const kf = KEYFRAMES[defaultCluster];
      if (kf) {
        group.rotation.y = kf.rotY;
        group.rotation.x = kf.rotX;
      }
      tweenTargetY = null;
      tweenTargetX = null;
      autoRotate = true;
      selectZone(defaultZm);
    }
  }

  function destroyRock() {
    if (animId) cancelAnimationFrame(animId);
    if (renderer) { renderer.dispose(); renderer = null; }
    scene = camera = group = animId = null;
    zoneMeshes = [];
    hoveredZone = activeZone = null;
    tweenTargetY = tweenTargetX = null;
    pointerDown = hasDragged = false;
    velX = velY = 0;
    clearTimeout(autoRotateTimer);
    hideZoneCard();
    const glowDiv = document.getElementById('groove-rock-glow');
    if (glowDiv) glowDiv.remove();
  }

  // ── Zone click handler ────────────────────────────────────────────────
  function handleZoneClick(zone) {
    closeModal();

    if (zone.discovered) {
      const keystone = keystoneByCluster[zone.cluster];
      if (!keystone) return;

      setTimeout(async () => {
        isTyping = true;
        fadeOutInput();
        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message:          `push ${zone.cluster}`,
              sessionId,
              unlockedClusters: grooveState.unlockedClusters,
              clusterCounts:    {},
              pushCluster:      zone.cluster,
            }),
          });
          const data = await res.json();
          if (data.song) await playGrooveTransmission(keystone, data.song, null);
        } catch (e) { console.error('Replay error', e); }
        isTyping = false;
        setTimeout(fadeInInput, 600);
      }, 400);

    } else {
      setTimeout(async () => {
        const sysMsg = document.createElement('div');
        sysMsg.className = 'groove-invoke-msg';
        sysMsg.textContent = `// Invoke ${zone.label}`;
        chatMessages.appendChild(sysMsg);
        scrollToBottom();

        fadeOutInput();
        isTyping = true;
        const typingIndicator = showTypingIndicator();

        try {
          const res = await fetch('/api/invoke-cluster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cluster:          zone.cluster,
              sessionId,
              clusterCounts:    clusterPlayCounts,
              unlockedClusters: grooveState.unlockedClusters,
            }),
          });
          const data = await res.json();
          removeTypingIndicator(typingIndicator);
          if (data.song) {
            const cl = data.song.cluster;
            if (cl) {
              // Increment and persist — server reads this on the next request
              clusterPlayCounts[cl] = (clusterPlayCounts[cl] || 0) + 1;
              saveClusterCounts();
            }

            // Server handles keystone threshold — if it returned groove metadata, handle it
            const grooveHandled = await handleGrooveSong(data);
            if (grooveHandled) {
              isTyping = false;
              setTimeout(fadeInInput, 600);
              return;
            }

            // Normal invoke
            await displaySong(data.song, data.response);
            sessionStats.songsPlayed++;
          } else if (data.response) {
            await addMessageToChatWithTyping(data.response, 'assistant');
          }
        } catch (e) {
          console.error('Invoke error', e);
          removeTypingIndicator(typingIndicator);
        }
        isTyping = false;
        setTimeout(fadeInInput, 600);
      }, 400);
    }
  }

})();

// =====================
// SHOW MODE
// A monthly on-rails episode: a fixed order of songs and voice transmissions that the
// listener steps through with one footer button. No free text, nothing timed.
//
// - Lives beside Explore on the same page. body.mode-show swaps which one is visible;
//   neither is torn down, so switching never loses progress in either.
// - Entered via /show (or /episode) in the address bar, or the /show command.
// - Only one embed exists at a time. Leaving a mode removes its embeds so nothing keeps
//   playing out of sight; our own <audio> is paused and resumed in place.
// - Progress is saved per episode id in localStorage.
// - Show plays never touch Groove counts or Explore's played-song list.
// =====================
(function initShow() {
  // LAUNCH SWITCH — launched 2026-10-01. When true, every visitor is offered the episode
  // (header button in Explore, and the "explore or episode?" question on a first visit).
  // Set to false to pull it back: it is then only offered in browsers that have already
  // entered show mode by address or command.
  const SHOW_PUBLIC = true;

  const UNLOCK_KEY   = 'efrain_fm_show_unlocked';
  const PROGRESS_KEY = 'efrain_fm_show_progress';
  const SHOW_PATHS   = ['/show', '/episode'];

  const view = document.getElementById('show-view');
  if (!view) return;

  const listEl        = document.getElementById('show-list');
  const stageEl       = document.getElementById('show-stage');
  const nextBtn       = document.getElementById('show-next-btn');
  const pill          = document.getElementById('show-service-pill');
  const countEl       = document.getElementById('show-count');
  const durationEl    = document.getElementById('show-duration');
  const editionEl     = document.getElementById('show-edition');
  const titleEl       = document.getElementById('show-title');
  const modeSwitch      = document.getElementById('mode-switch');
  const modeSwitchIcon  = document.getElementById('mode-switch-icon');
  const modeSwitchLabel = document.getElementById('mode-switch-label');
  const footer        = document.getElementById('input-footer');

  const ICON_MIC  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
  const ICON_TEXT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="13" y2="17"/></svg>';
  // Headphones: "listening on…" — sits before the service name in the pill
  const ICON_SOURCE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';

  let active          = false;   // is show mode in front?
  let episode         = null;
  let episodePromise  = null;
  let items           = [];      // intro + episode steps + outro
  let reached         = 1;       // how many items have been revealed
  let current         = 0;       // which revealed item is loaded
  let needsServicePick = false;  // first visit with no Spotify/Apple choice yet
  let pickerEl        = null;
  let resumeOnReturn  = null;    // transmission <audio> we paused when leaving show mode
  let heldExplore     = [];      // Explore iframes detached while show mode is in front
  let heldExploreAudio = [];
  const typedText = new Set();   // text items already typed out once
  const txEmbeds  = new Map();   // item index → voice embed wrapper (kept so titles persist)

  const isShowPath = () => SHOW_PATHS.includes(window.location.pathname.replace(/\/+$/, '') || '/');

  // ── Episode + progress ─────────────────────────────────────────────────
  function loadEpisode() {
    if (!episodePromise) {
      episodePromise = fetch('/api/show')
        .then(res => {
          if (!res.ok) throw new Error('No episode available');
          return res.json();
        })
        .then(data => {
          episode = data;
          items = [];
          if (data.intro) items.push({ type: 'intro', title: 'Intro', artist: 'Efrain', text: data.intro });
          items.push(...data.steps);
          if (data.outro) items.push({ type: 'outro', title: 'Sign-off', artist: 'Efrain', text: data.outro });
          restoreProgress();
          return data;
        })
        .catch(err => { episodePromise = null; throw err; });
    }
    return episodePromise;
  }

  function restoreProgress() {
    reached = 1;
    current = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY));
      // A different episode id means a new month — start fresh
      if (saved && saved.id === episode.id) {
        reached = Math.min(Math.max(1, saved.reached | 0), items.length);
        current = Math.min(Math.max(0, saved.current | 0), reached - 1);
      }
    } catch { /* corrupt or missing — start fresh */ }
  }

  function saveProgress() {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ id: episode.id, reached, current }));
  }

  const songNumber   = index => items.slice(0, index + 1).filter(i => i.type === 'song').length;
  const songsReached = () => items.slice(0, reached).filter(i => i.type === 'song').length;

  // ── Playlist ───────────────────────────────────────────────────────────
  function renderList() {
    listEl.replaceChildren();
    items.slice(0, reached).forEach((item, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'show-row';
      if (i === current) row.setAttribute('aria-current', 'true');

      const num = document.createElement('span');
      num.className = 'show-row__num';
      if (item.type === 'song') num.textContent = songNumber(i);
      else num.innerHTML = item.type === 'transmission' ? ICON_MIC : ICON_TEXT;

      const text = document.createElement('span');
      text.className = 'show-row__text';
      const title = document.createElement('div');
      title.className = 'show-row__title';
      title.textContent = item.short_title || item.title;
      const artist = document.createElement('div');
      artist.className = 'show-row__artist';
      artist.textContent = item.type === 'transmission' ? 'Efrain' : item.artist;
      text.append(title, artist);

      row.title = item.artist ? `${item.title} — ${item.artist}` : item.title;
      row.append(num, text);
      row.addEventListener('click', () => {
        if (i === current) return;
        current = i;
        saveProgress();
        render({ autoplay: true });
      });
      listEl.appendChild(row);
      if (i === current) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
    });
  }

  // ── Current item ───────────────────────────────────────────────────────
  function clearStage() {
    // Removing an <audio> from the page doesn't stop it — pause any transmission first.
    // It keeps its position, so coming back picks up where the listener left off.
    stageEl.querySelectorAll('.voice-embed').forEach(embed => (embed.pause ? embed.pause() : embed.stop && embed.stop()));
    resumeOnReturn = null;
    stageEl.replaceChildren();
  }

  function buildTextBlock(text, key) {
    const el = document.createElement('div');
    el.className = 'show-text';
    if (key !== null && !typedText.has(key)) {
      typedText.add(key);
      el.typed = typeText(el, text, 14);
    } else {
      el.textContent = text;
      el.typed = Promise.resolve();
    }
    return el;
  }

  // ── Listener note (shown under the sign-off) ───────────────────────────
  // A short message and optional reply address, posted to /api/feedback, which emails
  // it to Efrain. Nothing typed here is ever rendered back into the page.
  const noteDraft = { message: '', email: '' };   // survives switching modes or rows

  // ── Support link (end of episode only) ─────────────────────────────────
  // A plain link to Efrain's Buy Me a Coffee page, opened in a new tab so the listener
  // keeps their place. Deliberately not the Buy Me a Coffee widget: no third-party
  // script, and it stays as quiet as everything around it.
  const SUPPORT_URL = 'https://buymeacoffee.com/efrainfm';
  const ICON_COFFEE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>';
  const ICON_LEAVES = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';

  function buildSupportBlock() {
    const wrap = document.createElement('div');
    wrap.className = 'show-support';

    const line = document.createElement('p');
    line.className = 'show-support__line';
    line.textContent = 'If this hour was worth a coffee to you, you can buy me one.';

    const link = document.createElement('a');
    link.className = 'show-support__link';
    link.href = SUPPORT_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', 'Buy me a coffee (opens in a new tab)');
    link.innerHTML = `${ICON_COFFEE}<span>Buy me a coffee</span>${ICON_LEAVES}`;

    wrap.append(line, link);
    return wrap;
  }
  const noteSentKey = () => `efrain_fm_show_note_${episode.id}`;

  function buildNoteForm() {
    const form = document.createElement('form');
    form.className = 'show-note';
    form.noValidate = true;

    const status = document.createElement('p');
    status.className = 'show-note__status';
    status.setAttribute('role', 'status');

    if (localStorage.getItem(noteSentKey())) {
      status.textContent = 'Your note was sent. Thanks for listening.';
      form.appendChild(status);
      return form;
    }

    const field = (labelText, control) => {
      const label = document.createElement('label');
      label.className = 'show-note__label';
      label.textContent = labelText;
      label.htmlFor = control.id;
      return [label, control];
    };

    const message = document.createElement('textarea');
    message.id = 'show-note-message';
    message.className = 'show-note__input';
    message.rows = 3;
    message.maxLength = 1000;
    message.placeholder = 'What caught your ear?';
    message.value = noteDraft.message;
    message.addEventListener('input', () => { noteDraft.message = message.value; });

    const email = document.createElement('input');
    email.id = 'show-note-email';
    email.className = 'show-note__input';
    email.type = 'email';
    email.autocomplete = 'email';
    email.maxLength = 254;
    email.placeholder = 'name@example.com';
    email.value = noteDraft.email;
    email.addEventListener('input', () => { noteDraft.email = email.value; });

    // Honeypot: hidden from people and screen readers; only bots fill it
    const trap = document.createElement('input');
    trap.type = 'text';
    trap.name = 'website';
    trap.className = 'show-note__trap';
    trap.tabIndex = -1;
    trap.autocomplete = 'off';
    trap.setAttribute('aria-hidden', 'true');

    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'show-note__send';
    send.textContent = 'Send note';

    form.append(
      ...field('Leave a note for Efrain', message),
      ...field('Your email, if you’d like a reply (optional)', email),
      trap, send, status
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = message.value.trim();
      const addr = email.value.trim();
      if (!text) {
        status.textContent = 'Write a note before sending.';
        message.focus();
        return;
      }
      if (addr && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
        status.textContent = 'That email doesn’t look right. Check it, or leave it blank.';
        email.focus();
        return;
      }

      send.disabled = true;
      send.textContent = 'Sending…';
      status.textContent = '';
      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, email: addr, episode: episode.id, website: trap.value }),
        });
        if (res.ok) {
          localStorage.setItem(noteSentKey(), '1');
          noteDraft.message = '';
          noteDraft.email = '';
          status.textContent = 'Your note was sent. Thanks for listening.';
          form.replaceChildren(status);
          return;
        }
        status.textContent = res.status === 429
          ? 'You’ve sent a few notes already. Try again in a few minutes.'
          : 'Your note couldn’t be sent right now. It’s still here; try again in a minute.';
      } catch {
        status.textContent = 'Your note couldn’t be sent. Check your connection and try again.';
      }
      send.disabled = false;
      send.textContent = 'Send note';
    });

    return form;
  }

  function buildSongEmbed(item) {
    // Apple wins if preferred and available; otherwise fall back to whichever link exists
    const useApple = (getPlayerPref() === 'apple' && item.apple_music_url) || !item.spotify_url;
    const wrapper = document.createElement('div');
    wrapper.className = 'song-embed-wrapper';

    const iframe = document.createElement('iframe');
    iframe.className = 'song-embed';
    iframe.title = `${item.title} — ${item.artist}`;
    iframe.addEventListener('load', () => {
      iframe.classList.add('loaded');
      wrapper.classList.add('loaded');
    });

    if (useApple) {
      const url = item.apple_music_url;
      iframe.src = url.includes('?') ? `${url}&theme=dark` : `${url}?theme=dark`;
      iframe.allow = 'autoplay *; encrypted-media *; fullscreen *';
      iframe.style.borderRadius = '10px';
    } else {
      iframe.src = item.spotify_url;
      iframe.allow = 'encrypted-media';
    }

    wrapper.appendChild(iframe);
    return wrapper;
  }

  function getTransmissionEmbed(index, item) {
    if (txEmbeds.has(index)) return txEmbeds.get(index);

    const baseTitle = `${item.title.toUpperCase()} //<br>${episode.edition.toUpperCase()}`;
    const embed = createVoiceEmbed(item.audio, '', { controls: true });
    const wrapper = document.createElement('div');
    wrapper.className = 'voice-embed-wrapper';
    wrapper.appendChild(embed);

    // Start on the static layer (the title), with the control bar below it. Whether it
    // starts playing is decided by renderStage, which knows if a tap brought us here.
    embed.classList.add('loaded');
    embed.querySelector('.voice-embed__static').classList.add('visible');
    const title = embed.querySelector('.voice-embed__title');
    title.innerHTML = baseTitle;

    const audio = embed.querySelector('audio');
    // Name what's playing on the lock screen and in the system's media controls
    audio.addEventListener('play', () => {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  item.title,
        artist: 'Efrain',
        album:  episode.title,
        artwork: [{ src: '/og-image.png', type: 'image/png' }],
      });
    });
    audio.addEventListener('ended', () => {
      if (title.dataset.durationSet) return;
      title.innerHTML = `${baseTitle}<span class="voice-embed__time"> [${Math.round(audio.duration)}s]</span>`;
      title.dataset.durationSet = '1';
    });

    txEmbeds.set(index, wrapper);
    return wrapper;
  }

  // autoplay: start a transmission as it arrives. Only pass true from a tap or click —
  // browsers block audio that starts without one, and only one item is ever on stage,
  // so nothing else can be playing over it.
  function renderStage({ autoplay = false } = {}) {
    clearStage();
    if (needsServicePick) {
      stageEl.appendChild(buildTextBlock('Which do you use to listen to music?', null));
      return;
    }
    const item = items[current];
    if (!item) return;
    if (item.type === 'song') stageEl.appendChild(buildSongEmbed(item));
    else if (item.type === 'transmission') {
      const wrapper = getTransmissionEmbed(current, item);
      stageEl.appendChild(wrapper);
      if (autoplay) wrapper.querySelector('.voice-embed').resume();
    } else {
      const block = buildTextBlock(item.text, current);
      stageEl.appendChild(block);
      // Once the sign-off has finished typing: the note form (only when the server says
      // notes can be delivered, so nobody meets a form that can't send), then the
      // support link. The link is a sibling of the form, so it is still there on the
      // "note sent" confirmation.
      if (item.type === 'outro') {
        block.typed.then(() => {
          if (!stageEl.contains(block)) return;
          if (episode.notes) stageEl.appendChild(buildNoteForm());
          stageEl.appendChild(buildSupportBlock());
        });
      }
    }
  }

  // ── Masthead + footer button ───────────────────────────────────────────
  function nextLabel() {
    const next = items[current + 1];
    if (!next) return 'Explore';
    if (next.type === 'transmission') return 'Transmission from Efrain';
    if (next.type === 'outro') return 'Sign off';
    return songNumber(current + 1) === 1 ? 'Drop the needle' : 'Next up';
  }

  function renderControls() {
    editionEl.textContent = episode.edition;
    titleEl.textContent   = episode.title;

    const total = episode.song_count;
    const heard = songsReached();
    countEl.textContent    = heard ? `${heard} of ${total} songs` : `${total} songs`;
    durationEl.textContent = episode.duration_minutes ? `${episode.duration_minutes} min` : '';
    durationEl.previousElementSibling.hidden = !episode.duration_minutes;

    const service = getPlayerPref();
    pill.className = `service-pill ${service === 'spotify' ? 'spotify' : 'apple'}`;
    pill.innerHTML = ICON_SOURCE + (service === 'spotify' ? 'Spotify' : 'Apple Music');

    nextBtn.textContent = nextLabel();
  }

  function render({ autoplay = false } = {}) {
    renderList();
    renderStage({ autoplay });
    renderControls();
  }

  function renderUnavailable() {
    items = [];
    editionEl.textContent = '';
    titleEl.textContent = 'Show';
    view.querySelector('.show-info').style.display = 'none';
    listEl.replaceChildren();
    stageEl.replaceChildren(buildTextBlock('No episode is available right now.', null));
    nextBtn.textContent = 'Back to exploring';
  }

  // Always reached from a tap (the footer button, or the service choice), so a
  // transmission that arrives can start playing
  function advance() {
    current += 1;
    if (current >= reached) reached = current + 1;
    saveProgress();
    render({ autoplay: true });
  }

  nextBtn.addEventListener('click', () => {
    // On the last item (or with no episode) the button leads into Explore
    if (current + 1 >= items.length) {
      setMode('explore');
      return;
    }
    // Ask Spotify or Apple Music only when it's first needed: just before the first
    // song embed, not before the spoken introduction.
    if (items[current + 1].type === 'song' && !localStorage.getItem(PLAYER_KEY)) {
      needsServicePick = true;
      renderStage();
      openPicker();
      return;
    }
    advance();
  });

  // ── Spotify / Apple Music question (footer, same pattern as Explore's interrupt bar) ──
  function openPicker() {
    if (pickerEl) {
      if (!needsServicePick) closePicker();   // tapping the pill again dismisses it
      return;
    }
    pickerEl = document.createElement('div');
    pickerEl.id = 'show-picker';

    [{ label: 'Spotify', val: 'spotify' }, { label: 'Apple Music', val: 'apple' }].forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'interrupt-btn';
      btn.textContent = opt.label;
      btn.style.animationDelay = `${i * 70}ms`;
      btn.addEventListener('click', () => {
        const wasFirstPick = needsServicePick;   // the stage is showing the question, not an item
        const changed      = getPlayerPref() !== opt.val;
        setPlayerPref(opt.val);
        needsServicePick = false;
        closePicker();
        renderControls();
        // The first pick was asked for on the way to a song, so carry on to it. Otherwise
        // reload only if the service changed and a song is showing — never interrupt
        // a transmission.
        if (wasFirstPick) advance();
        else if (changed && items[current] && items[current].type === 'song') renderStage();
      });
      pickerEl.appendChild(btn);
    });

    footer.appendChild(pickerEl);
    document.body.classList.add('show-picking');
    const el = pickerEl;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
  }

  function closePicker() {
    if (!pickerEl) return;
    const el = pickerEl;
    pickerEl = null;
    document.body.classList.remove('show-picking');
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }

  pill.addEventListener('click', openPicker);

  // ── Keeping the hidden mode quiet ──────────────────────────────────────
  // Spotify/Apple embeds can't be paused from outside, so the only way to stop one is to
  // take it off the page. Detached iframes reload from the start when put back.
  function holdExploreMedia() {
    chatMessages.querySelectorAll('iframe').forEach(iframe => {
      heldExplore.push({ iframe, parent: iframe.parentNode, next: iframe.nextSibling });
      iframe.remove();
    });
    chatMessages.querySelectorAll('audio').forEach(audio => {
      if (!audio.paused) {
        audio.pause();
        heldExploreAudio.push(audio);
      }
    });
  }

  function releaseExploreMedia() {
    heldExplore.forEach(({ iframe, parent, next }) => {
      if (!parent.isConnected) return;
      iframe.classList.remove('loaded');
      parent.classList.remove('loaded');
      parent.insertBefore(iframe, next && next.parentNode === parent ? next : null);
    });
    heldExplore = [];
    heldExploreAudio.forEach(audio => audio.play().catch(() => {}));
    heldExploreAudio = [];
  }

  function leaveStage() {
    const item = items[current];
    if (item && item.type === 'transmission') {
      const audio = stageEl.querySelector('audio');
      if (audio && !audio.paused) {
        audio.pause();
        resumeOnReturn = audio;
      }
    } else {
      stageEl.replaceChildren();
    }
  }

  // byTap: the listener tapped their way in (header button, "Hear EP. 01", the /show
  // command), as opposed to loading /show directly or using back/forward
  function returnToStage(byTap = false) {
    const item = items[current];
    const stillOnStage = item && item.type === 'transmission' && !needsServicePick && stageEl.querySelector('.voice-embed');
    if (stillOnStage) {
      renderList();
      renderControls();
      // Only pick a transmission back up if leaving is what paused it
      if (resumeOnReturn) stageEl.querySelector('.voice-embed').resume();
      resumeOnReturn = null;
    } else {
      render({ autoplay: byTap });
    }
  }

  // ── Mode switching ─────────────────────────────────────────────────────
  const ICON_EPISODE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>';
  const ICON_EXPLORE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>';

  const episodeNumber = () => (episode && episode.number ? String(episode.number).padStart(2, '0') : '');
  const episodeLabel  = () => (episodeNumber() ? `EP. ${episodeNumber()}` : 'Episode');
  const episodeName   = () => (episodeNumber() ? `Episode ${episodeNumber()}` : 'the episode');

  // Is the episode offered to this visitor from Explore? (See SHOW_PUBLIC above.)
  const isOffered = () => Boolean(episode) && (SHOW_PUBLIC || Boolean(localStorage.getItem(UNLOCK_KEY)));

  // One header button that names where it takes you
  function syncSwitch() {
    modeSwitch.hidden = !(active || isOffered());
    modeSwitchIcon.innerHTML = active ? ICON_EXPLORE : ICON_EPISODE;
    modeSwitchLabel.textContent = active ? 'Explore' : episodeLabel();
    modeSwitch.setAttribute('aria-label', active ? 'Switch to Explore' : `Switch to ${episode ? episode.title : 'the episode'}`);
  }

  function setMode(mode, { push = true, byTap = false } = {}) {
    const toShow = mode === 'show';
    if (toShow === active) return;
    active = toShow;
    document.body.classList.toggle('mode-show', toShow);

    if (toShow) {
      view.hidden = false;
      localStorage.setItem(UNLOCK_KEY, '1');
      holdExploreMedia();
      loadEpisode()
        .then(() => { if (active) returnToStage(byTap); syncSwitch(); })
        .catch(() => { if (active) renderUnavailable(); });
    } else {
      closePicker();
      needsServicePick = false;   // an unanswered question is simply asked again later
      leaveStage();
      releaseExploreMedia();
    }

    syncSwitch();
    if (push) history.pushState({ mode }, '', toShow ? '/show' : '/');
  }

  modeSwitch.addEventListener('click', () => setMode(active ? 'explore' : 'show', { byTap: true }));
  window.addEventListener('popstate', () => setMode(isShowPath() ? 'show' : 'explore', { push: false }));

  // Used by the /show and /show-reset commands
  window.enterShowMode = () => setMode('show', { byTap: true });
  window.resetShowMode = () => {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(UNLOCK_KEY);
    typedText.clear();
    txEmbeds.clear();
    if (episode) restoreProgress();
    syncSwitch();
  };

  // What Explore's first-visit flow needs to offer the episode
  window.showMode = {
    isOffered,
    label:     episodeLabel,
    name:      episodeName,
    songCount: () => (episode ? episode.song_count : 0),
    enter:     () => setMode('show', { byTap: true }),
  };

  syncSwitch();
  if (isShowPath()) setMode('show', { push: false });
  // Explore needs the episode too, for the header button's label and the first-visit offer
  else loadEpisode().then(syncSwitch).catch(() => {});
})();

