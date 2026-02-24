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
  this.style.height = 'auto';
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

    // Lock scroll for duration of typing
    container.style.overflowY = 'hidden';

    const interval = setInterval(() => {
      if (index < text.length) {
        element.textContent += text[index];
        index++;
        // Keep the bottom of the growing message pinned to the container bottom
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        if (elementRect.bottom > containerRect.bottom) {
          container.scrollTop += (elementRect.bottom - containerRect.bottom) + 8;
        }
      } else {
        clearInterval(interval);
        // Snap to true bottom, then unlock scrolling
        container.scrollTop = container.scrollHeight;
        container.style.overflowY = '';
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
  inputWrapper.style.opacity = '1';
  inputWrapper.style.pointerEvents = 'auto';
  // Restore placeholder after input has faded back in
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
      userInput.style.height = 'auto';
      return;
    }
  }

  addMessageToChat(message, 'user');
  userInput.value = '';
  userInput.style.height = 'auto';
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

    const data = await response.json();
    removeTypingIndicator(typingIndicator);
    sessionStats.messagesExchanged++;

    if (data.song) {
      if (data.bridgingResponse) {
        await addMessageToChatWithTyping(data.bridgingResponse, 'assistant');
      }
      await displaySong(data.song, data.response);
      sessionStats.songsPlayed++;
    } else if (data.response) {
      await addMessageToChatWithTyping(data.response, 'assistant');
    }

    // Handle interrupt if present — delay 4s after song/response loads
    if (data.interrupt) {
      setTimeout(() => { showInterrupt(data.interrupt); }, 4000);
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
    addMessageToChat('Something went wrong. Please try again.', 'assistant');
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

sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
