// Actor input const
export const ACTOR_README_MAX_LENGTH = 5_000;
export const ACTOR_ENUM_MAX_LENGTH = 200;
export const ACTOR_MAX_DESCRIPTION_LENGTH = 500;

// Actor output const
export const ACTOR_OUTPUT_MAX_CHARS_PER_ITEM = 5_000;
export const ACTOR_OUTPUT_TRUNCATED_MESSAGE = `Output was truncated because it will not fit into context.`
    + `There is no reason to call this tool again!`;

export const ACTOR_ADDITIONAL_INSTRUCTIONS = 'Never call/execute tool/Actor unless confirmed by the user. '
    + 'Always limit the number of results in the call arguments.';

// Actor run const
export const ACTOR_MAX_MEMORY_MBYTES = 4_096; // If the Actor requires 8GB of memory, free users can't run actors-mcp-server and requested Actor

// MCP Server
export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '0.1.0';

// User agent headers
export const USER_AGENT_ORIGIN = 'Origin/mcp-server';

export enum HelperTools {
    SEARCH = 'search',
    ADD_TOOL = 'add-tool',
    REMOVE_TOOL = 'remove-tool',
    GET_TOOL_DETAILS = 'get-tool-details',
}

export const defaults = {
    actors: [
        'apify/instagram-scraper',
        'apify/rag-web-browser',
        'lukaskrivka/google-maps-with-contact-details',
    ],
    enableActorAutoLoading: false,
    maxMemoryMbytes: 4096,
};

export const APIFY_USERNAME = 'apify';
