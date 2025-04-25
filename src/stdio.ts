#!/usr/bin/env node
/**
 * This script initializes and starts the Apify MCP server using the Stdio transport.
 *
 * Usage:
 *   node <script_name> --actors=<actor1,actor2,...>
 *
 * Command-line arguments:
 *   --actors - A comma-separated list of Actor full names to add to the server.
 *
 * Example:
 *   node stdio.js --actors=apify/google-search-scraper,apify/instagram-scraper
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import minimist from 'minimist';

import log from '@apify/log';

import { defaults } from './const.js';
import { ActorsMcpServer } from './mcp/server.js';
import { getActorsAsTools } from './tools/index.js';

// Configure logging, set to ERROR
log.setLevel(log.LEVELS.ERROR);

// Parse command line arguments
const parser = minimist;
const argv = parser(process.argv.slice(2), {
    boolean: [
        'enable-adding-actors',
        'enableActorAutoLoading', // deprecated
    ],
    string: ['actors'],
    default: {
        'enable-adding-actors': false,
    },
});
const enableAddingActors = argv['enable-adding-actors'] || argv.enableActorAutoLoading || false;
const { actors = '' } = argv;
const actorList = actors ? actors.split(',').map((a: string) => a.trim()) : [];

// Validate environment
if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

async function main() {
    const mcpServer = new ActorsMcpServer({ enableAddingActors, enableDefaultActors: false });
    const tools = await getActorsAsTools(actorList.length ? actorList : defaults.actors, process.env.APIFY_TOKEN as string);
    mcpServer.updateTools(tools);

    // Start server
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
}

main().catch((error) => {
    log.error('Server error:', error);
    process.exit(1);
});
