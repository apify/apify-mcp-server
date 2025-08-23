#!/usr/bin/env node
/**
 * This script initializes and starts the Apify MCP server using the Stdio transport.
 *
 * Usage:
 *   node <script_name> --actors=<actor1,actor2,...>
 *
 * Command-line arguments:
 *   --actors - A comma-separated list of Actor full names to add to the server.
 *   --help - Display help information
 *
 * Example:
 *   node stdio.js --actors=apify/google-search-scraper,apify/instagram-scraper
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import yargs from 'yargs';
// Had to ignore the eslint import extension error for the yargs package.
// Using .js or /index.js didn't resolve it due to the @types package issues.
// eslint-disable-next-line import/extensions
import { hideBin } from 'yargs/helpers';

import log from '@apify/log';

import { ActorsMcpServer } from './mcp/server.js';
import { toolCategories } from './tools/index.js';
import type { Input, ServerConfigCli, ToolCategory } from './types.js';
import { loadToolsFromInput } from './utils/tools-loader.js';

// Configure logging, set to ERROR
log.setLevel(log.LEVELS.ERROR);

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .env()
    .option('actors', {
        type: 'string',
        describe: 'Comma-separated list of Actor full names to add to the server. Can also be set via ACTORS environment variable.',
        example: 'apify/google-search-scraper,apify/instagram-scraper',
    })
    .option('enable-adding-actors', {
        type: 'boolean',
        default: true,
        describe: 'Enable dynamically adding Actors as tools based on user requests. Can also be set via ENABLE_ADDING_ACTORS environment variable.',
    })
    .option('enableActorAutoLoading', {
        type: 'boolean',
        default: true,
        hidden: true,
        describe: 'Deprecated: use enable-adding-actors instead.',
    })
    .options('tools', {
        type: 'string',
        describe: `Comma-separated list of specific tool categories to enable. Can also be set via TOOLS environment variable.

Available choices: ${Object.keys(toolCategories).join(', ')}

Tool categories are as follows:
- docs: Search and fetch Apify documentation tools.
- runs: Get Actor runs list, run details, and logs from a specific Actor run.
- storage: Access datasets, key-value stores, and their records.
- preview: Experimental tools in preview mode.

Note: Tools that enable you to search Actors from the Apify Store and get their details are always enabled by default.
`,
        example: 'docs,runs,storage',
    })
    .help('help')
    .alias('h', 'help')
    .version(false)
    .epilogue(
        'To connect, set your MCP client server command to `npx @apify/actors-mcp-server`'
        + ' and set the environment variable `APIFY_TOKEN` to your Apify API token.\n',
    )
    .epilogue('For more information, visit https://mcp.apify.com or https://github.com/apify/apify-mcp-server')
    .parseSync() as ServerConfigCli;

const enableAddingActors = argv.enableAddingActors && argv.enableActorAutoLoading;
const actors = argv.actors as string || '';
const actorList = actors ? actors.split(',').map((a: string) => a.trim()) : [];
// Keys of the tool categories to enable
const toolCategoryKeys = argv.tools ? argv.tools.split(',').map((t: string) => t.trim()) : [];

// Propagate log.error to console.error for easier debugging
const originalError = log.error.bind(log);
log.error = (...args: Parameters<typeof log.error>) => {
    originalError(...args);
    // eslint-disable-next-line no-console
    console.error(...args);
};

// Validate environment
if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

async function main() {
    const mcpServer = new ActorsMcpServer({ enableAddingActors, enableDefaultActors: false });

    // Create an Input object from CLI arguments
    const input: Input = {
        actors: actorList.length ? actorList : [],
        enableAddingActors,
        tools: toolCategoryKeys as ToolCategory[],
    };

    // Use the shared tools loading logic
    const tools = await loadToolsFromInput(input, process.env.APIFY_TOKEN as string, actorList.length === 0);

    mcpServer.upsertTools(tools);

    // Start server
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
}

main().catch((error) => {
    log.error('Server error', { error });
    process.exit(1);
});
