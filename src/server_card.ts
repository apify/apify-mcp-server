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
import type { ServerCard } from './types.js';
import { readJsonFile } from './utils/generic.js';
import { getPackageVersion } from './utils/version.js';

const serverJson = readJsonFile<{ description: string }>(import.meta.url, '../server.json');

/** Returns the `serverInfo` (MCP `Implementation`) advertised in the initialize response. */
export function getServerInfo(): Implementation {
    return {
        name: SERVER_NAME,
        title: SERVER_TITLE,
        version: getPackageVersion()!,
        description: serverJson.description,
        websiteUrl: APIFY_MCP_URL,
        icons: [
            {
                src: APIFY_LOGO_URL,
                mimeType: 'image/png',
                sizes: ['180x180'],
            },
        ],
    };
}

/** Returns the MCP server card object per SEP-1649. */
export function getServerCard(): ServerCard {
    return {
        $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
        version: '1.0',
        protocolVersion: LATEST_PROTOCOL_VERSION,
        serverInfo: {
            name: SERVER_NAME,
            title: SERVER_TITLE,
            version: getPackageVersion()!,
        },
        description: serverJson.description,
        iconUrl: APIFY_FAVICON_URL,
        documentationUrl: APIFY_DOCS_MCP_URL,
        transport: {
            type: 'streamable-http',
            endpoint: '/',
        },
        capabilities: {
            tools: { listChanged: true },
        },
        authentication: {
            required: true,
            schemes: ['bearer', 'oauth2'],
        },
        tools: 'dynamic',
    };
}
