import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import {
    APIFY_DOCS_MCP_URL,
    APIFY_FAVICON_URL,
    APIFY_LOGO_URL,
    APIFY_MCP_URL,
    SERVER_NAME,
    SERVER_TITLE,
} from './const.js';
import { getDefaultTools } from './tools/index.js';
import type { ServerCard, ServerCardRemote, ServerCardRepository, ServerCardTool } from './types.js';
import { readJsonFile } from './utils/generic.js';
import { getPackageVersion } from './utils/version.js';

/**
 * The registry-shaped half of the server card lives in `server.json`, which is already the
 * source of truth for registry publishing and is version-bumped by the release workflow.
 * Reading it here keeps the card from drifting out of sync with what we publish.
 */
const serverJson = readJsonFile<{
    $schema: string;
    name: string;
    description: string;
    repository: ServerCardRepository;
    remotes: ServerCardRemote[];
}>(import.meta.url, '../server.json');

/**
 * Server icon, shared by the initialize response and the server card so the two cannot diverge.
 * PNG rather than the `.ico` favicon: the registry schema restricts `icons[].mimeType` to
 * png/jpeg/jpg/svg+xml/webp.
 */
const SERVER_ICONS: ServerCard['icons'] = [
    {
        src: APIFY_LOGO_URL,
        mimeType: 'image/png',
        sizes: ['180x180'],
    },
];

/** Returns the `serverInfo` (MCP `Implementation`) advertised in the initialize response. */
export function getServerInfo(): Implementation {
    return {
        name: SERVER_NAME,
        title: SERVER_TITLE,
        version: getPackageVersion()!,
        description: serverJson.description,
        websiteUrl: APIFY_MCP_URL,
        icons: [...SERVER_ICONS],
    };
}

/**
 * Summarises the default tool set for the card.
 *
 * Uses each tool's plain `description`, which by contract holds the render for consumers without
 * a session tool set — exactly the session-less case a static card describes. Only the default
 * server mode is described: the card is served from a single URL, and the modes differ only in
 * one tool description.
 */
function getServerCardTools(): ServerCardTool[] {
    return getDefaultTools().map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
    }));
}

/** Returns the MCP server card object. See {@link ServerCard} for why it is a hybrid shape. */
export function getServerCard(): ServerCard {
    return {
        $schema: serverJson.$schema,

        name: serverJson.name,
        title: SERVER_TITLE,
        description: serverJson.description,
        version: getPackageVersion()!,
        websiteUrl: APIFY_MCP_URL,
        repository: serverJson.repository,
        icons: [...SERVER_ICONS],
        remotes: serverJson.remotes,
        serverUrl: APIFY_MCP_URL,

        protocolVersion: LATEST_PROTOCOL_VERSION,
        serverInfo: {
            name: SERVER_NAME,
            title: SERVER_TITLE,
            version: getPackageVersion()!,
        },
        iconUrl: APIFY_FAVICON_URL,
        documentationUrl: APIFY_DOCS_MCP_URL,
        transport: {
            type: 'streamable-http',
            endpoint: '/',
        },
        capabilities: {
            tools: {},
        },
        authentication: {
            required: true,
            schemes: ['bearer', 'oauth2'],
        },

        tools: getServerCardTools(),
    };
}
