// client.js
const chatLog = document.getElementById('chatLog');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');
const spinner = document.getElementById('spinner');

// Keep track of all messages
const messages = [];

/**
 * formatAnyContent(content):
 *   - If content is a string -> run your normal markdown/HTML formatting.
 *   - If it's an array -> check for tool-related messages, collapse them, etc.
 *   - If it's an object -> show a JSON-encoded <pre> block.
 */
function formatAnyContent(content) {
    // If you have a separate function that does markdown → HTML, keep it:
    function formatMarkdown(text) {
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

    // 1) If content is a simple string, just format it
    if (typeof content === 'string') {
        return formatMarkdown(content);
    }

    // 2) If content is an array, loop through each item
    if (Array.isArray(content)) {
        return content.map((item) => {
            // e.g. detect "tool_use", "tool_result"
            if (item.type === 'tool_use') {
                // Display it collapsed
                return `
<details class="tool-block">
  <summary>Tool use: <strong>${item.name}</strong></summary>
  <div style="font-size: 0.9rem; margin: 6px 0;">
    <strong>ID:</strong> ${item.id || 'unknown'}
  </div>
  <pre>${escapeHTML(JSON.stringify(item.input, null, 2))}</pre>
</details>
`;
            } if (item.type === 'tool_result') {
                // Try to parse the content as JSON, pretty-print
                let parsed = null;
                let pretty = '';
                try {
                    parsed = JSON.parse(item.content);
                    pretty = JSON.stringify(parsed, null, 2);
                } catch {
                    // Fallback if not valid JSON
                    pretty = item.content;
                }

                const summary = item.is_error ? 'Tool Result (Error)' : 'Tool Result';
                return `
<details class="tool-block">
  <summary>${summary}</summary>
  <pre>${escapeHTML(pretty)}</pre>
</details>
`;
            }
            // Otherwise, fallback to raw JSON
            return `<pre>${JSON.stringify(item, null, 2)}</pre>`;
        }).join('\n');
    }

    // 3) If content is a plain object, show JSON
    if (typeof content === 'object' && content !== null) {
        return `<pre>${JSON.stringify(content, null, 2)}</pre>`;
    }

    // 4) If all else fails, just coerce to string
    return String(content);
}

/**
 * A simple function to escape HTML special chars (used inside <pre> if needed).
 */
function escapeHTML(str) {
    if (typeof str !== 'string') return String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Convert basic Markdown-like syntax to HTML.
 * - Replaces triple backticks ```...``` with <pre><code>...</code></pre>
 * - Replaces single backticks `...` with <code>...</code>
 * - Replaces **bold** text
 * - Replaces *italics* text
 * - Replaces newlines with <br> for better multiline display
 */

/**
 * Append a message to the chat log
 */
function appendMessage(role, content) {
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
    bubble.innerHTML = formatAnyContent(content);

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
