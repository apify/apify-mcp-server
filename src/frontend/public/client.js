// client.js
const chatLog = document.getElementById('chatLog');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');
const spinner = document.getElementById('spinner');

// Keep track of all messages
const messages = [];

/**
 * Convert basic Markdown-like syntax to HTML.
 * - Replaces triple backticks ```...``` with <pre><code>...</code></pre>
 * - Replaces single backticks `...` with <code>...</code>
 * - Replaces **bold** text
 * - Replaces *italics* text
 * - Replaces newlines with <br> for better multiline display
 */
function formatMessageContent(text) {
    // Escape HTML special chars to avoid injection
    let safe = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Then apply some naive markdown transforms:
    // 1) Fenced code blocks: ```...```
    safe = safe.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // 2) Inline code: `...`
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 3) Bold: **text**
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 4) Italics: *text*
    safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // 5) Replace newlines with <br>
    safe = safe.replace(/\n/g, '<br>');
    // 6) Replace markdown links [text](url) with <a href="url">text</a>
    safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    return safe;
}

/**
 * Append a message to the chat log
 */
function appendMessage(role, content) {

    console.log('role:', role);
    console.log('content:', content);
    const row = document.createElement('div');
    row.className = 'message-row';

    if (role === 'user') {
        row.classList.add('user-message');
    } else if (role === 'assistant') {
        row.classList.add('assistant-message');
    } else {
        row.classList.add('internal-message');
    }

    // Create the bubble
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;

    // Transform markdown in the message text
    bubble.innerHTML = formatMessageContent(content);

    row.appendChild(bubble);
    chatLog.appendChild(row);

    // Scroll to the bottom
    chatLog.scrollTop = chatLog.scrollHeight;
}

/**
 * Send a message to the server
 */
async function sendQuery(query) {
    spinner.style.display = 'inline-block';
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, messages }),
        });
        const data = await response.json();
        if (data && data.newMessages) {
            data.newMessages.forEach((msg) => {
                messages.push(msg);
                appendMessage(msg.role, msg.content);
            });
        }
    } catch (err) {
        console.error('Error calling server:', err); // eslint-disable-line no-console
        appendMessage('internal', `Error calling server: ${err.message}`);
    }
    spinner.style.display = 'none';
}

/** EVENT HANDLERS * */

// Click the "Send" button
sendBtn.addEventListener('click', () => {
    const query = queryInput.value.trim();
    if (query) {
        sendQuery(query);
        queryInput.value = '';
    }
});

// Press Enter to send
queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});
