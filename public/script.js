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

    case '/help':
      console.log('Commands: /theme [light|dark|auto], /reset, /debug, /help');
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

  fadeOutInput();

  await new Promise(r => setTimeout(r, 250));
  const typingIndicator = showTypingIndicator();
  isTyping = true;

  try {
    const endpoint = pendingFavoriteInput ? '/api/favorite' : '/api/chat';
    const body = pendingFavoriteInput
      ? { input: message, sessionId }
      : { message, sessionId };

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
      await displaySong(data.song, data.response);
      sessionStats.songsPlayed++;
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

  const isYouTube = song.spotify_url && (
    song.spotify_url.includes('youtube.com') ||
    song.spotify_url.includes('youtu.be')
  );

  const embedWrapper = document.createElement('div');
  embedWrapper.classList.add('song-embed-wrapper');
  if (isYouTube) embedWrapper.classList.add('youtube');

  const iframe = document.createElement('iframe');
  iframe.classList.add('song-embed');
  iframe.frameBorder = '0';

  iframe.addEventListener('load', () => {
    iframe.classList.add('loaded');
    embedWrapper.classList.add('loaded');
  });

  if (isYouTube) {
    let embedUrl = song.spotify_url;
    if (embedUrl.includes('watch?v=')) {
      embedUrl = embedUrl.replace('watch?v=', 'embed/').split('&')[0];
    } else if (embedUrl.includes('youtu.be/')) {
      embedUrl = embedUrl.replace('youtu.be/', 'youtube.com/embed/');
    }
    iframe.src = embedUrl;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
  } else {
    iframe.src = song.spotify_url;
    iframe.allow = 'encrypted-media';
  }

  embedWrapper.appendChild(iframe);
  songContainer.appendChild(embedWrapper);

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
      { src: '/images/photo5.jpg',  caption: 'One is a professional wrestling champion, another is a product designer. Both are Cuban.', hasMe: true },
      { src: '/images/photo6.jpg',  caption: 'Caught my dog Ernie during the golden hour', hasMe: false },
      { src: '/images/photo7.jpg',  caption: 'Me, live in Hoboken way back as Rare Books', hasMe: true },
      { src: '/images/photo8.jpg',  caption: 'Camp day at Oscar with some awesome colleagues', hasMe: true },
      { src: '/images/photo9.jpg',  caption: "I won 2nd place two years in a row at Oscar's fun poker tournament. I was enjoying my opponents' body language here.", hasMe: true },
      { src: '/images/photo10.jpg', caption: 'Live shot from a Black Pumas show at Asbury Park', hasMe: false },
      { src: '/images/photo11.jpg', caption: 'The pandemic was a strange time that called for strange hair configurations', hasMe: true },
      { src: '/images/photo12.jpg', caption: 'Me and my fiancé Elaine at Niagara Falls', hasMe: true },
      { src: '/images/photo13.jpg', caption: 'Product designers from Cityblock making sandcastles together at a San Diego offsite', hasMe: false },
      { src: '/images/photo14.jpg', caption: "Let's go Mets!", hasMe: true },
      { src: '/images/photo15.jpg', caption: 'Always wanted one of these "stickies on a wall" photos - collaborating at Cityblock in Brooklyn', hasMe: false },
      { src: '/images/photo16.jpg', caption: 'Cityblock engagement team offsite in Chicago, all trying to get that bean photo', hasMe: true },
      { src: '/images/photo17.jpg', caption: 'A fine gift from my local record shop, a signed Tiny Tim 7"', hasMe: true },
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
    const embed = createVoiceEmbed('/audio/welcomemsg.m4a', '');
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
      addMessage("Thanks for coming back. What are you looking for?", 'assistant');
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

    const embed = createVoiceEmbed('/audio/welcomemsg.m4a', '');
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

