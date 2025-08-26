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

import { processInput } from './input.js';
import { ActorsMcpServer } from './mcp/server.js';
import type { Input, ToolSelector } from './types.js';
import { loadToolsFromInput } from './utils/tools-loader.js';

// Keeping this interface here and not types.ts since
// it is only relevant to the CLI/STDIO transport in this file
/**
 * Interface for command line arguments
 */
interface CliArgs {
    actors?: string;
    enableAddingActors: boolean;
    /** @deprecated */
    enableActorAutoLoading: boolean;
    /** Tool categories to include */
    tools?: string;
}

// Configure logging, set to ERROR
log.setLevel(log.LEVELS.ERROR);

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
    .wrap(null) // Disable automatic wrapping to avoid issues with long lines and links
    .usage('Usage: $0 [options]')
    .option('actors', {
        type: 'string',
        describe: `Comma-separated list of Actor full names to add to the server.
Deprecated: use tools instead.`,
        example: 'apify/google-search-scraper,apify/instagram-scraper',
    })
    .option('enable-adding-actors', {
        type: 'boolean',
        default: false,
        describe: `Enable dynamically adding Actors as tools based on user requests.
Deprecated: use tools experimental category instead.`,
    })
    .option('enableActorAutoLoading', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe: 'Deprecated: use enable-adding-actors instead.',
    })
    .options('tools', {
        type: 'string',
        describe: `Comma-separated list of tools to enable. Can be either a tool category, a specific tool, or an Apify Actor. For example: --tools actors,docs,apify/rag-web-browser.

For more details visit https://mcp.apify.com`,
        example: 'actors,docs,apify/rag-web-browser',
    })
    .help('help')
    .alias('h', 'help')
    .version(false)
    .epilogue(
        'To connect, set your MCP client server command to `npx @apify/actors-mcp-server`'
        + ' and set the environment variable `APIFY_TOKEN` to your Apify API token.\n',
    )
    .epilogue('For more information, visit https://mcp.apify.com or https://github.com/apify/actors-mcp-server')
    .parseSync() as CliArgs;

// Respect either the new flag or the deprecated one
const enableAddingActors = Boolean(argv.enableAddingActors || argv.enableActorAutoLoading);
// Split actors argument, trim whitespace, and filter out empty strings
const actorList = argv.actors !== undefined
    ? argv.actors.split(',').map((a: string) => a.trim()).filter((a: string) => a.length > 0)
    : undefined;
// Split tools argument, trim whitespace, and filter out empty strings
const toolCategoryKeys = argv.tools !== undefined
    ? argv.tools.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0)
    : undefined;

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
    const mcpServer = new ActorsMcpServer();

    // Create an Input object from CLI arguments
    const input: Input = {
        actors: actorList,
        enableAddingActors,
        tools: toolCategoryKeys as ToolSelector[],
    };

    // Normalize (merges actors into tools for backward compatibility)
    const normalized = processInput(input);

    // Use the shared tools loading logic
    const tools = await loadToolsFromInput(normalized, process.env.APIFY_TOKEN as string);

    mcpServer.upsertTools(tools);

    // Start server
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
}

main().catch((error) => {
    log.error('Server error', { error });
    process.exit(1);
});
