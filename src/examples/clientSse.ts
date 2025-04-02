/* eslint-disable no-console */
/**
 * Connect to the MCP server using SSE transport and call a tool.
 * The Actors MCP Server will load default Actors.
 *
 * It requires the `APIFY_TOKEN` in the `.env` file.
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { EventSource } from 'eventsource';

import { actorNameToToolName } from '../actors.js';

const REQUEST_TIMEOUT = 120_000; // 2 minutes
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

dotenv.config({ path: path.resolve(dirname, '../../.env') });

const SERVER_URL = process.env.MCP_SERVER_URL_BASE || 'https://actors-mcp-server.apify.actor/sse';
// We need to change forward slash / to underscore -- in the tool name as Anthropic does not allow forward slashes in the tool name
const SELECTED_TOOL = actorNameToToolName('apify/rag-web-browser');
// const QUERY = 'web browser for Anthropic';
const QUERY = 'apify';

if (!process.env.APIFY_TOKEN) {
    console.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

async function main(): Promise<void> {
    const transport = new SSEClientTransport(
        new URL(SERVER_URL),
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                },
            },
            eventSourceInit: {
                // The EventSource package augments EventSourceInit with a "fetch" parameter.
                // You can use this to set additional headers on the outgoing request.
                // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                async fetch(input: Request | URL | string, init?: RequestInit) {
                    const headers = new Headers(init?.headers || {});
                    headers.set('authorization', `Bearer ${process.env.APIFY_TOKEN}`);
                    return fetch(input, { ...init, headers });
                },
            // We have to cast to "any" to use it, since it's non-standard
            } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        },
    );
    const client = new Client(
        { name: 'example-client', version: '1.0.0' },
        { capabilities: {} },
    );

    try {
        // Connect to the MCP server
        await client.connect(transport);

        // List available tools
        const tools = await client.listTools();
        console.log('Available tools:', tools);

        if (tools.tools.length === 0) {
            console.log('No tools available');
            return;
        }

        const selectedTool = tools.tools.find((tool) => tool.name === SELECTED_TOOL);
        if (!selectedTool) {
            console.error(`The specified tool: ${selectedTool} is not available. Exiting.`);
            return;
        }

        // Call a tool
        console.log(`Calling actor ... ${SELECTED_TOOL}`);
        const result = await client.callTool(
            { name: SELECTED_TOOL, arguments: { query: QUERY } },
            CallToolResultSchema,
            { timeout: REQUEST_TIMEOUT },
        );
        console.log('Tool result:', JSON.stringify(result, null, 2));
    } catch (error: unknown) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
            console.error(error.stack);
        } else {
            console.error('An unknown error occurred:', error);
        }
    } finally {
        await client.close();
    }
}

await main();
