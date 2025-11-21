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

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import yargs from 'yargs';
// Had to ignore the eslint import extension error for the yargs package.
// Using .js or /index.js didn't resolve it due to the @types package issues.
// eslint-disable-next-line import/extensions
import { hideBin } from 'yargs/helpers';

import log from '@apify/log';

import { ApifyClient } from './apify-client.js';
import { DEFAULT_TELEMETRY_ENV, TELEMETRY_ENV, type TelemetryEnv } from './const.js';
import { processInput } from './input.js';
import { ActorsMcpServer } from './mcp/server.js';
import { getTelemetryEnv } from './telemetry.js';
import type { Input, ToolSelector } from './types.js';
import { parseCommaSeparatedList } from './utils/generic.js';
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
    /** Enable or disable telemetry tracking (default: true) */
    telemetryEnabled: boolean;
    /** Telemetry environment: 'prod' or 'dev' (default: 'prod', only used when telemetry-enabled is true) */
    telemetryEnv: TelemetryEnv;
}

/**
 * Attempts to read Apify token from ~/.apify/auth.json file
 * Returns the token if found, undefined otherwise
 */
function getTokenFromAuthFile(): string | undefined {
    try {
        const authPath = join(homedir(), '.apify', 'auth.json');
        const content = readFileSync(authPath, 'utf-8');
        const authData = JSON.parse(content);
        return authData.token || undefined;
    } catch {
        return undefined;
    }
}

// Configure logging, set to ERROR
log.setLevel(log.LEVELS.ERROR);

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
    .wrap(null) // Disable automatic wrapping to avoid issues with long lines and links
    .usage('Usage: $0 [options]')
    .env()
    .option('actors', {
        type: 'string',
        describe: 'Comma-separated list of Actor full names to add to the server. Can also be set via ACTORS environment variable.',
        example: 'apify/google-search-scraper,apify/instagram-scraper',
    })
    .option('enable-adding-actors', {
        type: 'boolean',
        default: false,
        describe: `Enable dynamically adding Actors as tools based on user requests. Can also be set via ENABLE_ADDING_ACTORS environment variable.
Deprecated: use tools add-actor instead.`,
    })
    .option('enableActorAutoLoading', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe: 'Deprecated: Use tools add-actor instead.',
    })
    .options('tools', {
        type: 'string',
        describe: `Comma-separated list of tools to enable. Can be either a tool category, a specific tool, or an Apify Actor. For example: --tools actors,docs,apify/rag-web-browser. Can also be set via TOOLS environment variable.

For more details visit https://mcp.apify.com`,
        example: 'actors,docs,apify/rag-web-browser',
    })
    .option('telemetry-enabled', {
        type: 'boolean',
        default: true,
        describe: `Enable or disable telemetry tracking for tool calls. Can also be set via TELEMETRY_ENABLED environment variable.
Default: true (enabled)`,
    })
    .option('telemetry-env', {
        type: 'string',
        choices: [TELEMETRY_ENV.PROD, TELEMETRY_ENV.DEV],
        default: DEFAULT_TELEMETRY_ENV,
        hidden: true,
        describe: `Telemetry environment when telemetry is enabled. Can also be set via TELEMETRY_ENV environment variable.
- 'prod': Send events to production Segment workspace (default)
- 'dev': Send events to development Segment workspace
Only used when --telemetry-enabled is true`,
    })
    .help('help')
    .alias('h', 'help')
    .version(false)
    .epilogue(
        'To connect, set your MCP client server command to `npx @apify/actors-mcp-server`'
        + ' and set the environment variable `APIFY_TOKEN` to your Apify API token.\n',
    )
    .epilogue('For more information, visit https://mcp.apify.com or https://github.com/apify/apify-mcp-server')
    .parseSync() as CliArgs;

// Respect either the new flag or the deprecated one
const enableAddingActors = Boolean(argv.enableAddingActors || argv.enableActorAutoLoading);
// Split actors argument, trim whitespace, and filter out empty strings
const actorList = argv.actors !== undefined ? parseCommaSeparatedList(argv.actors) : undefined;
// Split tools argument, trim whitespace, and filter out empty strings
const toolCategoryKeys = argv.tools !== undefined ? parseCommaSeparatedList(argv.tools) : undefined;

// Propagate log.error to console.error for easier debugging
const originalError = log.error.bind(log);
log.error = (...args: Parameters<typeof log.error>) => {
    originalError(...args);
    // eslint-disable-next-line no-console
    console.error(...args);
};

// Get token from environment or auth file
const apifyToken = process.env.APIFY_TOKEN || getTokenFromAuthFile();

// Validate environment
if (!apifyToken) {
    log.error('APIFY_TOKEN is required but not set in the environment variables or in ~/.apify/auth.json');
    process.exit(1);
}

async function main() {
    const mcpServer = new ActorsMcpServer({
        transportType: 'stdio',
        telemetry: {
            enabled: argv.telemetryEnabled,
            env: getTelemetryEnv(argv.telemetryEnv),
        },
        token: apifyToken,
    });

    // Create an Input object from CLI arguments
    const input: Input = {
        actors: actorList,
        enableAddingActors,
        tools: toolCategoryKeys as ToolSelector[],
    };

    // Normalize (merges actors into tools for backward compatibility)
    const normalizedInput = processInput(input);

    const apifyClient = new ApifyClient({ token: apifyToken });
    // Use the shared tools loading logic
    const tools = await loadToolsFromInput(normalizedInput, apifyClient);

    mcpServer.upsertTools(tools);

    // Start server
    const transport = new StdioServerTransport();

    // Generate a unique session ID for this stdio connection
    // Note: stdio transport does not have a strict session ID concept like HTTP transports,
    // so we generate a UUID4 to represent this single session interaction for telemetry tracking
    const mcpSessionId = randomUUID();

    // Create a proxy for transport.onmessage to intercept and capture initialize request data
    // This is a hacky way to inject client information into the ActorsMcpServer class
    const originalOnMessage = transport.onmessage;

    transport.onmessage = (message: JSONRPCMessage) => {
        // Extract client information from initialize message
        const msgRecord = message as Record<string, unknown>;
        if (msgRecord.method === 'initialize') {
            // Update mcpServer options with initialize request data
            (mcpServer.options as Record<string, unknown>).initializeRequestData = msgRecord as Record<string, unknown>;
        }
        // Inject session ID into tool call messages
        if (msgRecord.method === 'tools/call' && msgRecord.params) {
            const params = msgRecord.params as Record<string, unknown>;
            params.mcpSessionId = mcpSessionId;
        }

        // Call the original onmessage handler
        if (originalOnMessage) {
            originalOnMessage(message);
        }
    };

    await mcpServer.connect(transport);
}

main().catch((error) => {
    log.error('Server error', { error });
    process.exit(1);
});
