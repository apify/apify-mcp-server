export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '0.1.0';

export const HEADER_READINESS_PROBE = 'x-apify-container-server-readiness-probe';
export const MAX_DESCRIPTION_LENGTH = 500;
export const USER_AGENT_ORIGIN = 'Origin/mcp-server';

export const defaults = {
    actors: [
        'apify/instagram-scraper',
        'apify/rag-web-browser',
        'lukaskrivka/google-maps-with-contact-details',
    ],
    enableActorAutoLoading: false,
    maxMemoryMbytes: 4096,
};

export const ACTOR_OUTPUT_MAX_CHARS_PER_ITEM = 5_000;
export const ACTOR_OUTPUT_TRUNCATED_MESSAGE = `Output was truncated because it will not fit into context.`
    + `There is no reason to call this tool again!`;
export const ACTOR_ADDITIONAL_INSTRUCTIONS = 'Never call/execute tool/Actor unless confirmed by the user. '
    + 'Always limit the number of results in the call arguments.';

export enum InternalTools {
    DISCOVER_ACTORS = 'discover-actors',
    ADD_ACTOR_TO_TOOLS = 'add-actor-to-tools',
    REMOVE_ACTOR_FROM_TOOLS = 'remove-actor-from-tools',
    GET_ACTOR_DETAILS = 'get-actor-details',
}

export enum Routes {
    ROOT = '/',
    SSE = '/sse',
    MESSAGE = '/message',
}
