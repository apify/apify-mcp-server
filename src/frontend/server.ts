import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response } from 'express';

import { MCPClient } from './mcpClient.js';

// Load environment variables
dotenv.config();

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const app = express();
app.use(express.json());

// Serve your public folder (where index.html is located)
// Adjust if you keep it in a different directory
app.use(express.static(path.join(dirname, 'public')));

// Create a single instance of your MCP client
const client = new MCPClient();
let isConnected = false;

/**
 * POST /api/chat
 * Receives: { query: string, messages: MessageParam[] }
 * Returns: { newMessages: MessageParam[] }
 */
app.post('/api/chat', async (req: Request, res: Response) : Promise<Response> => {
    try {
        console.log('Received POST /api/chat:'); // eslint-disable-line no-console
        const { query, messages } = req.body;
        if (!isConnected) {
            // Connect to server once, the same way your original code does
            // Pass the arguments needed for your server script if needed:
            await client.connectToServer();
            isConnected = true;
        }
        // process the query with your existing logic
        const nrMessagesBefore = messages.length;
        const updatedMessages = await client.processQuery(query, messages);

        // newMessages = whatever was appended to messages by the call
        // i.e. everything after the original length
        const newMessages = updatedMessages.slice(nrMessagesBefore);

        return res.json({ newMessages });
    } catch (error) {
        console.error('Error in /api/chat:', error); // eslint-disable-line no-console
        res.status(500).json({ error: (error as Error).message || 'Internal server error' });
        return res.end();
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`); // eslint-disable-line no-console
});
