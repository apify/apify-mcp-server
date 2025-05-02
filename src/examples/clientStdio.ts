/* eslint-disable no-console */
/**
 * Connect to the MCP server using stdio transport and call a tool.
 * This script uses a selected tool without LLM involvement.
 * You need to provide the path to the MCP server and `APIFY_TOKEN` in the `.env` file.
 * You can choose actors to run in the server, for example: `apify/rag-web-browser`.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv'; // eslint-disable-line import/no-extraneous-dependencies

import { actorNameToToolName } from '../tools/utils.js';

// Resolve dirname equivalent in ES module
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

dotenv.config({ path: path.resolve(dirname, '../../.env') });
const SERVER_PATH = path.resolve(dirname, '../../dist/stdio.js');
const NODE_PATH = execSync(process.platform === 'win32' ? 'where node' : 'which node').toString().trim();

const TOOLS = 'apify/rag-web-browser,lukaskrivka/google-maps-with-contact-details';
const SELECTED_TOOL = actorNameToToolName('apify/rag-web-browser');

if (!process.env.APIFY_TOKEN) {
    console.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

// Create server parameters for stdio connection
const transport = new StdioClientTransport({
    command: NODE_PATH,
    args: [SERVER_PATH, '--actors', TOOLS],
    env: { APIFY_TOKEN: process.env.APIFY_TOKEN || '' },
});

// Create a new client instance
const client = new Client(
    { name: 'example-client', version: '0.1.0' },
    { capabilities: {} },
);

// Main function to run the example client
async function run() {
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

        // Example: Call the first available tool
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
        console.log('Tool result:', JSON.stringify(result));

        await client.close();
    } catch (error) {
        console.error('Error:', error);
    }
}

run().catch((error) => {
    console.error(`Error running MCP client: ${error as Error}`);
    process.exit(1);
});
