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

// Typing animation
async function typeText(element, text, speed = 20) {
  return new Promise((resolve) => {
    let index = 0;
    element.textContent = '';

    const interval = setInterval(() => {
      if (index < text.length) {
        element.textContent += text[index];
        index++;
        scrollToElement(element);
      } else {
        clearInterval(interval);
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

  await new Promise(r => setTimeout(r, 250));
  const typingIndicator = showTypingIndicator();
  isTyping = true;

  try {
    // If we're in a pending favorite state, route to /api/favorite
    const endpoint = pendingFavoriteInput ? '/api/favorite' : '/api/chat';
    const body = pendingFavoriteInput
      ? { input: message, sessionId }
      : { message, sessionId };

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
    } else {
      await addMessageToChatWithTyping(data.response, 'assistant');
    }

    // Handle interrupt if present — delay 4s after song loads
    if (data.interrupt) {
      setTimeout(() => { showInterrupt(data.interrupt); }, 4000);
    }

    isTyping = false;

  } catch (error) {
    console.error('Error:', error);
    removeTypingIndicator(typingIndicator);
    addMessageToChat('Something went wrong. Please try again.', 'assistant');
    isTyping = false;
  }
}

function addMessageToChat(message, sender) {
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('message', sender);
  messageDiv.textContent = message;
  chatMessages.appendChild(messageDiv);
  scrollToElement(messageDiv);
}

async function addMessageToChatWithTyping(message, sender) {
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('message', sender);
  chatMessages.appendChild(messageDiv);
  scrollToElement(messageDiv);
  await typeText(messageDiv, message);
}

function showTypingIndicator() {
  const typingDiv = document.createElement('div');
  typingDiv.classList.add('message', 'typing');
  typingDiv.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  chatMessages.appendChild(typingDiv);
  scrollToElement(typingDiv);

  // Sine wave opacity — same rhythm as triangle indicator preview
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

  // Wrapper div clamps the iframe height — prevents Spotify from stretching
  const embedWrapper = document.createElement('div');
  embedWrapper.classList.add('song-embed-wrapper');
  if (isYouTube) embedWrapper.classList.add('youtube');

  const iframe = document.createElement('iframe');
  iframe.classList.add('song-embed');
  iframe.frameBorder = '0';

  // Fade in the embed once loaded, remove skeleton shimmer
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
      link.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
        ${song.tag_title}
      `;
      liveTag.appendChild(link);
    } else {
      liveTag.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        ${song.tag_title}
      `;
    }

    songContainer.appendChild(liveTag);
  }

  const storyDiv = document.createElement('div');
  storyDiv.classList.add('song-story');
  storyDiv.style.marginTop = '8px';
  songContainer.appendChild(storyDiv);

  chatMessages.appendChild(songContainer);
  scrollToElement(songContainer);

  if (storyText && storyText.trim() !== '') {
    await typeText(storyDiv, storyText);
  } else {
    storyDiv.remove();
  }
}

function scrollToElement(element) {
  const container = document.getElementById('chat-container');
  setTimeout(() => {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (elementRect.bottom > containerRect.bottom) {
      container.scrollTop += (elementRect.bottom - containerRect.bottom) + 16;
    }
  }, 50);
}

// =====================
// INTERRUPT / BUTTON UI
// =====================

async function showInterrupt(interrupt) {
  const footer = document.getElementById('input-footer');
  const inputWrapper = document.getElementById('input-wrapper');

  // Fade footer to slightly more opaque
  footer.classList.add('interrupt-active');

  // display:none removes it from layout entirely — no ghost space
  inputWrapper.style.display = 'none';

  await new Promise(r => setTimeout(r, 200));

  // Send interrupt question as assistant message
  if (!interrupt.freeText) {
    await addMessageToChatWithTyping(interrupt.message, 'assistant');
  }

  // Build interrupt UI
  const interruptEl = document.createElement('div');
  interruptEl.id = 'interrupt-bar';

  const question = document.createElement('p');
  question.id = 'interrupt-question';
  question.textContent = interrupt.message;
  interruptEl.appendChild(question);

  const btnRow = document.createElement('div');
  btnRow.id = 'interrupt-buttons';

  if (interrupt.freeText) {
    // Favorite question — restore input but flag it as favorite mode
    pendingFavoriteInput = true;
    userInput.placeholder = 'Type a song or artist...';
    interruptEl.remove();
    footer.classList.remove('interrupt-active');
    inputWrapper.style.display = '';

    // Show question as assistant message instead
    await addMessageToChatWithTyping(interrupt.message, 'assistant');
    return;
  }

  // Button options
  if (interrupt.options) {
    interrupt.options.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.className = 'interrupt-btn';
      btn.textContent = label;
      btn.style.animationDelay = `${i * 80}ms`;
      btn.addEventListener('click', () => {
        dismissInterrupt();
        // Send choice as a message
        userInput.value = label;
        sendMessage();
      });
      btnRow.appendChild(btn);
    });
  }

  // Dismiss X
  const dismissBtn = document.createElement('button');
  dismissBtn.id = 'interrupt-dismiss';
  dismissBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  dismissBtn.title = 'Dismiss';
  dismissBtn.addEventListener('click', dismissInterrupt);
  interruptEl.appendChild(dismissBtn);

  interruptEl.appendChild(btnRow);
  footer.insertBefore(interruptEl, inputWrapper);

  // Trigger entrance
  requestAnimationFrame(() => {
    interruptEl.classList.add('visible');
  });
}

function dismissInterrupt() {
  const footer = document.getElementById('input-footer');
  const inputWrapper = document.getElementById('input-wrapper');
  const interruptEl = document.getElementById('interrupt-bar');

  if (interruptEl) {
    interruptEl.classList.remove('visible');
    setTimeout(() => interruptEl.remove(), 300);
  }

  footer.classList.remove('interrupt-active');
  userInput.placeholder = 'Ask me for a song recommendation...';
  pendingFavoriteInput = false;

  setTimeout(() => {
    inputWrapper.style.display = '';
    inputWrapper.style.opacity = '1';
    inputWrapper.style.pointerEvents = 'auto';
  }, 150);
}

sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
