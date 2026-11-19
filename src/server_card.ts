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
 * Read from `server.json`, the file published to the MCP registry, so the card can't drift from it.
 * Undefined on a broken install (e.g. a truncated npx cache), which must not stop the stdio server.
 */
const serverJson = ((): ServerJson | undefined => {
    try {
        return readJsonFile<ServerJson>(import.meta.url, '../server.json');
    } catch {
        return undefined;
    }
})();

export function getServerInfo(): Implementation {
    return {
        name: SERVER_NAME,
        title: serverJson?.title ?? SERVER_TITLE,
        version: getPackageVersion()!,
        description: serverJson?.description,
        websiteUrl: serverJson?.websiteUrl,
        // server.json before 0.21.3 has no icons.
        icons: Array.isArray(serverJson?.icons) ? [...serverJson.icons] : undefined,
    };
}

/**
 * Tools of a default session. Not `getDefaultTools()`: it omits what `call-actor` pulls in.
 * `report-problem` is left out because it is enabled per client at serve time.
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

/** See {@link ServerCard} for why the card is a hybrid shape. */
export function getServerCard(): ServerCard {
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
