// Actor input const
export const ACTOR_README_MAX_LENGTH = 5_000;
export const ACTOR_ENUM_MAX_LENGTH = 200;
export const ACTOR_MAX_DESCRIPTION_LENGTH = 500;

export const ACTOR_RUN_DATASET_OUTPUT_MAX_ITEMS = 5;

// Actor run const
export const ACTOR_MAX_MEMORY_MBYTES = 4_096; // If the Actor requires 8GB of memory, free users can't run actors-mcp-server and requested Actor

// MCP Server
export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '1.0.0';

// User agent headers
export const USER_AGENT_ORIGIN = 'Origin/mcp-server';

export enum HelperTools {
    ACTOR_ADD = 'add-actor',
    ACTOR_CALL = 'call-actor',
    ACTOR_GET = 'get-actor',
    ACTOR_GET_DETAILS = 'get-actor-details',
    ACTOR_REMOVE = 'remove-actor',
    ACTOR_RUNS_ABORT = 'abort-actor-run',
    ACTOR_RUNS_GET = 'get-actor-run',
    ACTOR_RUNS_LOG = 'get-actor-log',
    ACTOR_RUN_LIST_GET = 'get-actor-run-list',
    DATASET_GET = 'get-dataset',
    DATASET_LIST_GET = 'get-dataset-list',
    DATASET_GET_ITEMS = 'get-dataset-items',
    KEY_VALUE_STORE_LIST_GET = 'get-key-value-store-list',
    KEY_VALUE_STORE_GET = 'get-key-value-store',
    KEY_VALUE_STORE_KEYS_GET = 'get-key-value-store-keys',
    KEY_VALUE_STORE_RECORD_GET = 'get-key-value-store-record',
    APIFY_MCP_HELP_TOOL = 'apify-actor-help-tool',
    STORE_SEARCH = 'search-actors',
}

export const defaults = {
    actors: [
        'apify/rag-web-browser',
    ],
};

// Actor output const
export const ACTOR_OUTPUT_MAX_CHARS_PER_ITEM = 5_000;
export const ACTOR_OUTPUT_TRUNCATED_MESSAGE = `Output was truncated because it will not fit into context.`
    + `There is no reason to call this tool again! You can use ${HelperTools.DATASET_GET_ITEMS} tool to get more items from the dataset.`;

export const ACTOR_ADDITIONAL_INSTRUCTIONS = 'Never call/execute tool/Actor unless confirmed by the user.';

export const ACTOR_CACHE_MAX_SIZE = 500;
export const ACTOR_CACHE_TTL_SECS = 30 * 60; // 30 minutes

export const ACTOR_PRICING_MODEL = {
    /** Rental actors */
    FLAT_PRICE_PER_MONTH: 'FLAT_PRICE_PER_MONTH',
    FREE: 'FREE',
    /** Pay per result (PPR) actors */
    PRICE_PER_DATASET_ITEM: 'PRICE_PER_DATASET_ITEM',
    /** Pay per event (PPE) actors */
    PAY_PER_EVENT: 'PAY_PER_EVENT',
} as const;

/**
 * Used in search Actors tool to search above the input supplied limit,
 * so we can safely filter out rental Actors from the search and ensure we return some results.
 */
export const ACTOR_SEARCH_ABOVE_LIMIT = 50;

export const MCP_STREAMABLE_ENDPOINT = '/mcp';
