const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-button');
const siteTitle = document.getElementById('site-title');

let sessionStats = {
  songsPlayed: 0,
  messagesExchanged: 0,
  startTime: new Date()
};

let isTyping = false;

// Auto-expand textarea
userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
});

// Typing animation for text
async function typeText(element, text, speed = 15) {
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

// Secret command parser
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
      sessionStats = {
        songsPlayed: 0,
        messagesExchanged: 0,
        startTime: new Date()
      };
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

// Send message function
async function sendMessage() {
  if (isTyping) return;
  
  const message = userInput.value.trim();
  if (!message) return;

  // Check for secret commands
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

  const typingIndicator = showTypingIndicator();
  isTyping = true;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    const data = await response.json();
    removeTypingIndicator(typingIndicator);
    sessionStats.messagesExchanged++;

    if (data.song) {
      await displaySong(data.song, data.response);
      sessionStats.songsPlayed++;
    } else {
      await addMessageToChatWithTyping(data.response, 'assistant');
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
  typingDiv.innerHTML = `
    <div class="typing-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  chatMessages.appendChild(typingDiv);
  scrollToElement(typingDiv);
  return typingDiv;
}

function removeTypingIndicator(indicator) {
  if (indicator && indicator.parentNode) {
    indicator.parentNode.removeChild(indicator);
  }
}

async function displaySong(song, storyText) {
  const songContainer = document.createElement('div');
  songContainer.classList.add('message', 'song');

  const iframe = document.createElement('iframe');
  iframe.classList.add('song-embed');
  iframe.src = song.spotify_url;
  iframe.width = '100%';
  iframe.height = '152';
  iframe.frameBorder = '0';
  iframe.allow = 'encrypted-media';
  songContainer.appendChild(iframe);

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
  songContainer.appendChild(storyDiv);

  chatMessages.appendChild(songContainer);
  scrollToElement(songContainer);

  await typeText(storyDiv, storyText);
}

function scrollToElement(element) {
  const container = document.getElementById('chat-container');
  const elementTop = element.offsetTop;
  
  container.scrollTo({
    top: elementTop - 20,
    behavior: 'smooth'
  });
}

sendButton.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
