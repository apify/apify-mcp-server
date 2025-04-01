#!/usr/bin/env node
/**
 * This script initializes and starts the Apify MCP server using the Stdio transport.
 *
 * Usage:
 *   node <script_name> --actors=<actor1,actor2,...>
 *
 * Command-line arguments:
 *   --actors - A comma-separated list of actor full names to add to the server.
 *
 * Example:
 *   node index.js --actors=apify/google-search-scraper,apify/instagram-scraper
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import minimist from 'minimist';

import { log } from './logger.js';
import { ApifyMcpServer } from './mcp-server.js';
import { getActorDiscoveryTools, getActorAutoLoadingTools } from './tools.js';

log.setLevel(log.LEVELS.ERROR);

const argv = minimist(process.argv.slice(2));
const argActors = argv.actors?.split(',').map((actor: string) => actor.trim()) || [];
const argEnableActorAutoLoading = argv.enableActorAutoLoading || false;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

async function main() {
    const server = new ApifyMcpServer();
    await (argActors.length !== 0
        ? server.addToolsFromActors(argActors)
        : server.addToolsFromDefaultActors());
    server.updateTools(getActorDiscoveryTools());
    if (argEnableActorAutoLoading) {
        server.updateTools(getActorAutoLoadingTools());
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error); // eslint-disable-line no-console
    process.exit(1);
});
