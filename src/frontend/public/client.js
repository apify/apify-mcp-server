const chatLog = document.getElementById('chatLog');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');

// Keep track of all messages (system, user, assistant).
const messages = [];

// Helper function to append a message to the chat log
function appendMessage(role, content) {
    const row = document.createElement('div');
    row.className = 'message-row';
    let roleClass;
    if (role === 'assistant') {
        roleClass = 'assistant';
    } else if (role === 'user') {
        roleClass = 'user';
    } else {
        roleClass = 'internal';
    }
    row.innerHTML = `<strong class="${roleClass}">${role}:</strong> ${content}`;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
}

// Handle sending the user’s query to the server
async function sendQuery(query) {
    // 1. Add to our in-memory "messages"
    messages.push({ role: 'user', content: query });
    appendMessage('user', query);
    console.log('Messages:', messages); // eslint-disable-line no-console

    // 2. Send to server
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, messages }),
        });
        const data = await response.json();
        console.log('Data:', data); // eslint-disable-line no-console
        if (data && data.newMessages) {
            // newMessages are the newly generated messages from server (assistant or "internal" placeholders, etc.)
            data.newMessages.forEach((msg) => {
                messages.push(msg);
                // Show them in UI
                appendMessage(msg.role, msg.content);
            });
        }
    } catch (err) {
        console.error('Error:', err); // eslint-disable-line no-console
        appendMessage('internal', `Error calling server: ${err.message}`);
    }
}

// Click/Enter handlers
sendBtn.addEventListener('click', () => {
    const query = queryInput.value.trim();
    if (query) {
        sendQuery(query);
        queryInput.value = '';
    }
});
queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});
