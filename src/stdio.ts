#!/usr/bin/env node

// Must stay the first import so Sentry instruments every module loaded after it.
import './instrument.js';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import yargs from 'yargs';
// The yargs typings don't resolve with a .js or /index.js extension.
// eslint-disable-next-line import/extensions
import { hideBin } from 'yargs/helpers';

import log from '@apify/log';

import { ApifyClient } from './apify_client.js';
import { DEFAULT_TELEMETRY_ENV, TELEMETRY_ENV } from './const.js';
import { processInput } from './input.js';
import { ActorsMcpServer } from './mcp/server.js';
import { getTelemetryEnv } from './telemetry.js';
import type { ApifyRequestParams, Input, ServerModeOption, TelemetryEnv, ToolSelector } from './types.js';
import { isApiTokenRequired } from './utils/auth.js';
import { parseQueryParamList } from './utils/generic.js';
import { injectMcpSessionId } from './utils/mcp.js';
import { parseServerMode } from './utils/server_mode.js';
import { getPackageVersion } from './utils/version.js';

type CliArgs = {
    // yargs turns a repeated flag (`--tools a --tools b`) into an array.
    actors?: string | string[];
    tools?: string | string[];
    telemetryEnabled: boolean;
    telemetryEnv: TelemetryEnv;
    ui: ServerModeOption;
};

/** Reads the token saved by `apify login`. */
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

log.setLevel(log.LEVELS.ERROR);
const packageVersion = getPackageVersion() ?? '0.0.0';

const argv = yargs(hideBin(process.argv))
    .wrap(null) // Wrapping breaks long links.
    .usage('Usage: $0 [options]')
    .env()
    .option('actors', {
        type: 'string',
        describe:
            'Comma-separated list of Actor full names to add to the server. Can also be set via ACTORS environment variable.',
        example: 'apify/google-search-scraper,apify/instagram-scraper',
    })
    .options('tools', {
        type: 'string',
        describe: `Comma-separated list of tools to enable. Can be either a tool category, a specific tool, or an Apify Actor. For example: --tools actors,docs,apify/web-search,apify/web-fetch. Can also be set via TOOLS environment variable.

For more details visit https://mcp.apify.com`,
        example: 'actors,docs,apify/web-search,apify/web-fetch',
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
        coerce: (arg: string) => arg?.toUpperCase(),
        describe: `Telemetry environment when telemetry is enabled. Can also be set via TELEMETRY_ENV environment variable.
- 'PROD': Send events to production Segment workspace (default)
- 'DEV': Send events to development Segment workspace
Only used when --telemetry-enabled is true`,
    })
    .option('ui', {
        default: undefined,
        coerce: (arg: string | boolean | undefined): ServerModeOption => {
            // A bare `--ui` means 'true'.
            const normalized = arg === true || arg === '' ? 'true' : arg;
            return parseServerMode((normalized as string) || process.env.UI_MODE);
        },
        describe: `Server mode. Can also be set via UI_MODE environment variable.
--ui apps | --ui true | --ui on   : force MCP Apps widget rendering
--ui default | --ui false | --ui off : force standard tool set
--ui auto (default)               : resolve from client capabilities`,
    })
    .help('help')
    .alias('h', 'help')
    .version(packageVersion)
    .epilogue(
        'To connect, set your MCP client server command to `npx @apify/actors-mcp-server`' +
            ' and set the environment variable `APIFY_TOKEN` to your Apify API token.\n',
    )
    .epilogue('For more information, visit https://mcp.apify.com or https://github.com/apify/apify-mcp-server')
    .parseSync() as CliArgs;

const actorList = argv.actors !== undefined ? parseQueryParamList(argv.actors) : undefined;
const toolCategoryKeys = argv.tools !== undefined ? parseQueryParamList(argv.tools) : undefined;

const originalError = log.error.bind(log);
log.error = (...args: Parameters<typeof log.error>) => {
    originalError(...args);
    // eslint-disable-next-line no-console
    console.error(...args);
};

const apifyToken = process.env.APIFY_TOKEN || getTokenFromAuthFile();

// Only public tools (e.g. docs) work without a token.
const requiresAuthentication = isApiTokenRequired({
    toolCategoryKeys,
    actorList,
});

if (requiresAuthentication && !apifyToken) {
    log.error('APIFY_TOKEN is required but not set in the environment variables or in ~/.apify/auth.json');
    process.exit(1);
}

async function main() {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 22) {
        // eslint-disable-next-line no-console
        console.error(
            `Error: Apify MCP server requires Node.js 22 or later (you have ${process.version}).\n` +
                'Please update Node.js: https://nodejs.org',
        );
        process.exit(1);
    }

    const mcpServer = new ActorsMcpServer({
        transportType: 'stdio',
        telemetry: {
            enabled: argv.telemetryEnabled,
            env: getTelemetryEnv(argv.telemetryEnv),
        },
        token: apifyToken,
        serverMode: argv.ui,
        allowUnauthMode: !requiresAuthentication,
    });

    const input: Input = {
        actors: actorList,
        tools: toolCategoryKeys as ToolSelector[],
    };
    const normalizedInput = processInput(input);

    const apifyClient = new ApifyClient({ token: apifyToken });
    // The server mode is applied in the initialize handler, once client capabilities are known.
    await mcpServer.loadToolsFromInput(normalizedInput, apifyClient);

    const transport = new StdioServerTransport();

    // stdio has no session ID; one is generated for telemetry and task isolation.
    const mcpSessionId = randomUUID();

    await mcpServer.connect(transport);

    const sdkOnMessage = transport.onmessage;
    transport.onmessage = (message) => {
        const msgRecord = message as Record<string, unknown>;
        msgRecord.params = injectMcpSessionId(msgRecord.params as ApifyRequestParams | undefined, mcpSessionId);

        sdkOnMessage?.(message);
    };
}

main().catch(async (error) => {
    log.error('Server error', { error });
    const Sentry = await import('@sentry/node');
    Sentry.captureException(error);
    await Sentry.flush(5000);
    process.exit(1);
});
