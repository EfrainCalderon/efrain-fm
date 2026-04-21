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

// =====================
// PLAYER PREFERENCE
// Toggles between 'spotify' and 'apple' via /player command.
// Persists in localStorage. Default is spotify.
// =====================
const PLAYER_KEY = 'efrain_fm_player';
function getPlayerPref() { return localStorage.getItem(PLAYER_KEY) || 'spotify'; }
function setPlayerPref(val) { localStorage.setItem(PLAYER_KEY, val); }

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

// Session-only state (resets on page reload — intentional)
let clusterPlayCounts = {}; // { C1: 2, C3: 1, ... } for this session only

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
    case '/theme':
      if (args === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else if (args === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else if (args === 'auto') {
        document.documentElement.removeAttribute('data-theme');
      }
      return true;

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
        console.log('Player set to Apple Music. Songs with Apple Music URLs will use that player.');
      } else if (pref === 'spotify') {
        setPlayerPref('spotify');
        console.log('Player set to Spotify.');
      } else {
        console.log(`Current player: ${getPlayerPref()}. Usage: /player apple | /player spotify`);
      }
      return true;
    }

    case '/help':
      console.log('Commands: /theme [light|dark|auto], /reset, /debug, /push [c1-c9], /groove-reset, /player [apple|spotify], /help');
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
      updateRingGlowState(0, false);
      console.log('Groove state reset. Reload to clear session cluster counts.');
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
  window._lastGrooveInput = message; // captured for groove unlock logging

  fadeOutInput();

  await new Promise(r => setTimeout(r, 250));
  const typingIndicator = showTypingIndicator();
  isTyping = true;

  try {
    const endpoint = pendingFavoriteInput ? '/api/favorite' : '/api/chat';
    const body = pendingFavoriteInput
      ? { input: message, sessionId }
      : {
          message,
          sessionId,
          unlockedClusters: grooveState.unlockedClusters,
          clusterCounts:    clusterPlayCounts,
          pushCluster:      null,
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
        // Normal song — track cluster count for future groove unlock
        if (data.song && data.song.cluster) {
          const cl = data.song.cluster;
          clusterPlayCounts[cl] = (clusterPlayCounts[cl] || 0) + 1;
        }
        await displaySong(data.song, data.response);
        sessionStats.songsPlayed++;
      }
    } else if (data.response) {
      removeTypingIndicator(typingIndicator);
      await addMessageToChatWithTyping(data.response, 'assistant');
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

async function addMessageToChatWithTyping(message, sender) {
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('message', sender);
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
  await typeText(messageDiv, message);
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

async function displaySong(song, storyText) {
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
      iframe.src = appleUrl;
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

    let embedUrl = ytUrl;
    if (embedUrl.includes('watch?v=')) embedUrl = embedUrl.replace('watch?v=', 'embed/').split('&')[0];
    else if (embedUrl.includes('youtu.be/')) embedUrl = embedUrl.replace('youtu.be/', 'youtube.com/embed/');
    ytIframe.src = embedUrl;
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

    let embedUrl = spotifyUrl;
    if (embedUrl.includes('watch?v=')) embedUrl = embedUrl.replace('watch?v=', 'embed/').split('&')[0];
    else if (embedUrl.includes('youtu.be/')) embedUrl = embedUrl.replace('youtu.be/', 'youtube.com/embed/');
    ytIframe.src = embedUrl;
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
  sessionStats.songsPlayed++;

  // Short pause, then light the ring
  await new Promise(r => setTimeout(r, 800));

  // Update groove state
  if (!grooveState.unlockedClusters.includes(keystoneConfig.cluster)) {
    grooveState.unlockedClusters.push(keystoneConfig.cluster);
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
function createVoiceEmbed(audioUrl, title = 'Welcome') {

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

  // ── State ─────────────────────────────────────────────────────────
  let audioCtx, analyser, source, dataArray, bufLen;
  let audioReady   = false;
  let waveAnimId   = null;
  let signalAnimId = null;
  let hasPlayed    = false;

  // ── Web Audio ─────────────────────────────────────────────────────
  function initAudio() {
    if (audioReady) return;
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
  function resizeWaveCanvas() {
    const dpr  = window.devicePixelRatio || 1;
    const pad  = 16;
    const rect = wrap.getBoundingClientRect();
    const w    = (rect.width - pad * 2) * dpr;
    const h    = rect.height * dpr;
    waveCanvas.width  = w;
    waveCanvas.height = h;
    waveCanvas.style.width  = (rect.width - pad * 2) + 'px';
    waveCanvas.style.height = rect.height + 'px';
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
    analyser.getByteFrequencyData(dataArray);

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
      waveLayer.classList.remove('visible', 'fading');
      if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
      staticLayer.classList.add('visible');
    }, 1400);
  }

  // ── Playback ──────────────────────────────────────────────────────
  function startPlayback() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    audio.currentTime = 0;
    audio.play().catch(() => {});
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

  window.addEventListener('resize', resizeWaveCanvas);

  // Expose startPlayback() so the intro handler can call it synchronously
  // within the user gesture — setTimeout breaks the browser's autoplay permission.
  wrap.startPlayback = () => {
    resizeWaveCanvas();
    play();
    // If audio is still paused after 800ms (blocked), fall back to static UI
    const guard = setTimeout(() => { if (audio.paused) showStatic(); }, 800);
    audio.addEventListener('play', () => clearTimeout(guard), { once: true });
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
    // Skip intro entirely — go straight to ready state
    document.body.classList.remove('intro-active');
    // Don't show start button at all; restore input immediately
    fadeInInput();
    // Inject the completed embed with the persisted title
    injectCompletedEmbed(saved);
    // Photos already seen — show immediately
    buildPhotoGrid(true);
    setTimeout(() => {
      addMessageToChatWithTyping("Thanks for coming back. What are you looking for?", 'assistant');
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
      const scheduleRestore = () => {
        const dur = voiceAudio.duration;
        if (!isFinite(dur)) return;
        const restoreDelay = Math.max((dur - 1.5) * 1000, 0);
        setTimeout(() => fadeInInput(), restoreDelay);
      };

      if (isFinite(voiceAudio.duration)) {
        scheduleRestore();
      } else {
        voiceAudio.addEventListener('loadedmetadata', scheduleRestore, { once: true });
      }

      voiceAudio.addEventListener('ended', () => {
        const secs    = Math.round(voiceAudio.duration);
        const titleEl = embed.querySelector('.voice-embed__title');
        if (titleEl && !titleEl.dataset.durationSet) {
          const fullTitle = `TRANSMISSION //<br>WELCOME MSG, ON AIR <span class="voice-embed__date">${mm}-${dd}-${yy}</span><span class="voice-embed__time"> ${h12}:${mins} ${ampm} [${secs}s]</span>`;
          titleEl.innerHTML = fullTitle;
          titleEl.dataset.durationSet = '1';
          // Persist for return visits — store as HTML string
          localStorage.setItem(STORAGE_KEY, fullTitle);
        }
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
  const hint     = document.getElementById('groove-modal-hint');
  if (!mapBtn || !modal) return;

  let clickLocked = false; // prevents double-invoke

  // ── Visibility ────────────────────────────────────────────────────────
  function syncButtonVisibility() {
    const count = grooveState.unlockedClusters.length;
    mapBtn.classList.toggle('visible', count > 0);
    const titleEl = document.getElementById('groove-modal-title');
    if (titleEl) titleEl.textContent = `${count} Groove${count === 1 ? '' : 's'} Unlocked`;
  }
  syncButtonVisibility();
  window.addEventListener('grooveRingUnlock', syncButtonVisibility);

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
  let frontmostZone = null;

  // Hint click — fires once at IIFE level, not inside initRock
  // so it doesn't stack up on repeated modal opens
  if (hint) {
    hint.addEventListener('click', () => {
      if (frontmostZone && !clickLocked) {
        clickLocked = true;
        handleZoneClick(frontmostZone);
      }
    });
    hint.addEventListener('mousedown', () => hint.classList.add('pressed'));
    hint.addEventListener('mouseup',   () => hint.classList.remove('pressed'));
    hint.addEventListener('mouseleave',() => hint.classList.remove('pressed'));
    hint.addEventListener('touchstart',() => hint.classList.add('pressed'),   { passive: true });
    hint.addEventListener('touchend',  () => hint.classList.remove('pressed'), { passive: true });
  }

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
  };

  function applyMatState(zm, state) {
    zm.mat.color.setHex(MAT[state].color);
    zm.mat.emissive.setHex(MAT[state].emissive);
    zm.mat.specular.setHex(MAT[state].specular);
    zm.mat.shininess = MAT[state].shininess;
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
      zoneMeshes.push({ mesh, mat, cluster: zone.cluster, label: zone.label, discovered: isDiscovered });
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

    group = new THREE.Group();
    scene.add(group);
    buildZonedRock();

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
      if (hoveredZone) applyMatState(hoveredZone, defaultState(hoveredZone));
      hoveredZone = zone;
      if (zone) {
        applyMatState(zone, zone.discovered ? 'hoverDiscovered' : 'hoverUndiscovered');
        hint.textContent = zone.discovered
          ? `// ${zone.label}`
          : `// ${zone.label} — Invoke`;
        canvas.style.cursor = 'pointer';
      } else {
        hint.textContent = '';
        canvas.style.cursor = 'default';
      }
    }

    // ── Pointer events (mouse + touch unified) ────────────────────────
    // mouseup on WINDOW so drag never gets stuck if pointer leaves canvas
    function onPointerDown(clientX, clientY) {
      pointerDown  = true;
      hasDragged   = false;
      dragStartX   = clientX;
      dragStartY   = clientY;
      velX = velY  = 0;
      autoRotate   = false;
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
      velX = dx * 0.005;
      velY = dy * 0.005;
      group.rotation.y += velX;
      // Clamp x rotation so rock never flips fully vertical
      group.rotation.x = Math.max(-0.8, Math.min(0.8, group.rotation.x + velY));
      dragStartX = clientX;
      dragStartY = clientY;
    }

    function onPointerUp(clientX, clientY) {
      if (!pointerDown) return;
      pointerDown = false;
      if (!hasDragged && !clickLocked) {
        const zone = getZoneAt(clientX, clientY);
        if (zone) {
          clickLocked = true; // block any further clicks until modal fully closes
          handleZoneClick(zone);
        }
      }
      autoRotateTimer = setTimeout(() => { autoRotate = true; }, 1800);
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
      if (autoRotate) {
        // y-rotation sweeps all 9 zones past the front continuously.
        // x eases to a fixed tilt so no zone hides at the poles.
        group.rotation.y += 0.004;
        group.rotation.x += (0.18 - group.rotation.x) * 0.02;
      } else {
        velX *= 0.93; velY *= 0.93;
        group.rotation.y += velX;
        group.rotation.x = Math.max(-0.8, Math.min(0.8, group.rotation.x + velY));
      }
      renderer.render(scene, camera);

      // Story 1 + 2: Find frontmost zone and apply selected visual state.
      // When hovering on desktop, hover takes priority and frontmost is reset.
      if (!hoveredZone) {
        let newFrontmost = null, bestZ = Infinity;
        const center = new THREE.Vector3();
        const proj   = new THREE.Vector3();
        zoneMeshes.forEach(zm => {
          zm.mesh.geometry.computeBoundingBox();
          zm.mesh.geometry.boundingBox.getCenter(center);
          center.applyMatrix4(zm.mesh.matrixWorld);
          proj.copy(center).project(camera);
          // In NDC, z ranges -1 (near) to 1 (far). Lowest z = closest to camera.
          // Also check the centroid is in front of the camera (proj.z < 1) and on screen.
          if (proj.z < 1 && Math.abs(proj.x) < 1.2 && proj.z < bestZ) {
            bestZ = proj.z;
            newFrontmost = zm;
          }
        });

        if (newFrontmost !== frontmostZone) {
          if (frontmostZone) applyMatState(frontmostZone, defaultState(frontmostZone));
          frontmostZone = newFrontmost;
        }
        // Apply selected state every frame — same visual as desktop hover
        if (frontmostZone) {
          applyMatState(frontmostZone, frontmostZone.discovered ? 'hoverDiscovered' : 'hoverUndiscovered');
          hint.textContent = frontmostZone.discovered
            ? `// ${frontmostZone.label}`
            : `// ${frontmostZone.label} — Invoke`;
          hint.style.cursor = 'pointer';
        } else {
          hint.textContent = '';
          hint.style.cursor = 'default';
        }
      } else {
        // Desktop hover active — reset any frontmost highlight
        if (frontmostZone) {
          applyMatState(frontmostZone, defaultState(frontmostZone));
          frontmostZone = null;
        }
        hint.style.cursor = 'default';
      }
    }
    animate();
  }

  function destroyRock() {
    if (animId) cancelAnimationFrame(animId);
    if (renderer) { renderer.dispose(); renderer = null; }
    scene = camera = group = animId = null;
    zoneMeshes = [];
    hoveredZone = null;
    frontmostZone = null;
    pointerDown = hasDragged = false;
    if (hint) { hint.textContent = ''; hint.style.cursor = 'default'; hint.classList.remove('pressed'); }
    window._grooveMouseUpActive = false;
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
            body: JSON.stringify({ cluster: zone.cluster, sessionId }),
          });
          const data = await res.json();
          removeTypingIndicator(typingIndicator);
          if (data.song) {
            const cl = data.song.cluster;
            if (cl) {
              clusterPlayCounts[cl] = (clusterPlayCounts[cl] || 0) + 1;

              // Check if this invoke just hit the groove threshold
              // 2 previous plays + this one = time to surface the keystone
              const isUnlocked = grooveState.unlockedClusters.includes(cl);
              const count      = clusterPlayCounts[cl];
              const keystone   = keystoneByCluster[cl];

              if (!isUnlocked && count >= 2 && keystone) {
                // Fetch keystone song and play groove transmission instead of normal song
                try {
                  const kRes = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      message:          `push ${cl}`,
                      sessionId,
                      unlockedClusters: [],
                      clusterCounts:    {},
                      pushCluster:      cl,
                    }),
                  });
                  const kData = await kRes.json();
                  if (kData.song) {
                    await playGrooveTransmission(keystone, kData.song, null);
                  } else {
                    // Keystone fetch failed — show the regular invoke song as fallback
                    await displaySong(data.song, data.response);
                    sessionStats.songsPlayed++;
                  }
                } catch (ke) {
                  console.error('Keystone fetch error', ke);
                  await displaySong(data.song, data.response);
                  sessionStats.songsPlayed++;
                }
                isTyping = false;
                setTimeout(fadeInInput, 600);
                return;
              }
            }

            // Normal invoke — no threshold hit
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

