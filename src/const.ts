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

// TODO - describe the flow, that each actor will produce a dataset id and key value store

// Actor run const
export const ACTOR_MAX_MEMORY_MBYTES = 4_096; // If the Actor requires 8GB of memory, free users can't run actors-mcp-server and requested Actor

// MCP Server
export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '1.0.0';

// User agent headers
export const USER_AGENT_ORIGIN = 'Origin/mcp-server';

export enum HelperTools {
    SEARCH_ACTORS = 'search-actors',
    ADD_ACTOR = 'add-actor',
    REMOVE_ACTOR = 'remove-actor',
    GET_ACTOR_DETAILS = 'get-actor-details',
    HELP_TOOL = 'help-tool',
    GET_ACTOR = 'get-actor',
    GET_ACTOR_RUN_LIST = 'get-actor-run-list',
}

export const defaults = {
    actors: [
        'apify/rag-web-browser',
    ],
    helperTools: [
        HelperTools.SEARCH_ACTORS,
        HelperTools.GET_ACTOR_DETAILS,
        HelperTools.HELP_TOOL,
    ],
    actorAddingTools: [
        HelperTools.ADD_ACTOR,
        HelperTools.REMOVE_ACTOR,
    ],
};

export const APIFY_USERNAME = 'apify';
