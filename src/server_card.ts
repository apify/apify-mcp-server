import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import {
    APIFY_DOCS_MCP_URL,
    APIFY_FAVICON_URL,
    APIFY_MCP_URL,
    HELPER_TOOLS,
    SERVER_NAME,
    SERVER_TITLE,
} from './const.js';
import type { ServerCard, ServerCardRemote, ServerCardRepository, ServerCardTool } from './types.js';
import { SERVER_MODE } from './types.js';
import { readJsonFile } from './utils/generic.js';
import { getToolsForServerMode } from './utils/tools_loader.js';
import { getPackageVersion } from './utils/version.js';

type ServerJson = {
    $schema: string;
    name: string;
    title: string;
    description: string;
    websiteUrl: string;
    repository: ServerCardRepository;
    icons: ServerCard['icons'];
    remotes: ServerCardRemote[];
};

/**
 * The registry-shaped half of the server card lives in `server.json`, which is already the
 * source of truth for registry publishing and is version-bumped by the release workflow.
 * Reading it here keeps the card from drifting out of sync with what we publish.
 *
 * Undefined when the file can't be read: a broken install (truncated npx cache, files from two
 * releases) must not stop the stdio server at import time.
 */
const serverJson = ((): ServerJson | undefined => {
    try {
        return readJsonFile<ServerJson>(import.meta.url, '../server.json');
    } catch {
        return undefined;
    }
})();

/** Returns the `serverInfo` (MCP `Implementation`) advertised in the initialize response. */
export function getServerInfo(): Implementation {
    return {
        name: SERVER_NAME,
        title: serverJson?.title ?? SERVER_TITLE,
        version: getPackageVersion()!,
        description: serverJson?.description,
        websiteUrl: serverJson?.websiteUrl,
        // An older server.json (before 0.21.3) has no icons.
        icons: Array.isArray(serverJson?.icons) ? [...serverJson.icons] : undefined,
    };
}

/**
 * Summarises the tools a default session serves. `getDefaultTools()` under-reports — it omits
 * what `call-actor` pulls in — and `report-problem` is client-gated at serve time, so a static
 * card cannot carry it. Each tool's plain `description` is by contract the session-less render.
 */
function getServerCardTools(): ServerCardTool[] {
    return getToolsForServerMode({}, [], SERVER_MODE.DEFAULT)
        .filter((tool) => tool.name !== HELPER_TOOLS.PROBLEM_REPORT)
        .map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            annotations: tool.annotations,
        }));
}

/** Returns the MCP server card object. See {@link ServerCard} for why it is a hybrid shape. */
export function getServerCard(): ServerCard {
    // Only the hosted server serves the card, from its own complete install.
    if (!serverJson) throw new Error('server.json could not be read');
    return {
        $schema: serverJson.$schema,

        name: serverJson.name,
        title: serverJson.title,
        description: serverJson.description,
        version: getPackageVersion()!,
        websiteUrl: serverJson.websiteUrl,
        repository: serverJson.repository,
        icons: [...serverJson.icons],
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
