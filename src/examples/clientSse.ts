/* eslint-disable no-console */
/**
 * Connect to the MCP server using SSE transport and call a tool.
 * The Actors MCP Server will load default Actors.
 *
 * !!! NOT WORKING - This example needs to be fixed as it does not work !!!
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { EventSource } from 'eventsource';

// Resolve dirname equivalent in ES module
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

dotenv.config({ path: path.resolve(dirname, '../../.env') });

const SERVER_URL = 'https://actors-mcp-server/sse';
// We need to change forward slash / to underscore _ in the tool name as Anthropic does not allow forward slashes in the tool name
const SELECTED_TOOL = 'apify_rag-web-browser';

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
        console.log('Calling actor ...');
        const result = await client.callTool(
            { name: SELECTED_TOOL, arguments: { query: 'web browser for Anthropic' } },
            CallToolResultSchema,
        );
        console.log('Tool result:', JSON.stringify(result, null, 2));
    } catch (error: unknown) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
            console.error(error.stack);
        } else {
            console.error('An unknown error occurred:', error);
        }
    }
}

await main();
