// Actor input const
export const ACTOR_README_MAX_LENGTH = 5_000;
export const ACTOR_ENUM_MAX_LENGTH = 200;
export const ACTOR_MAX_DESCRIPTION_LENGTH = 500;

export const ACTOR_RUN_DATASET_OUTPUT_MAX_ITEMS = 5;

// Actor run const
export const ACTOR_MAX_MEMORY_MBYTES = 4_096; // If the Actor requires 8GB of memory, free users can't run actors-mcp-server and requested Actor

// Tool output
/**
 * Usual tool output limit is 25k tokens, let's use 20k
 * just in case where 1 token =~ 4 characters thus 80k chars.
 * This is primarily used for Actor tool call output, but we can then
 * reuse this in other tools as well.
 */
export const TOOL_MAX_OUTPUT_CHARS = 80000;

// MCP Server
export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '1.0.0';

// User agent headers
export const USER_AGENT_ORIGIN = 'Origin/mcp-server';

export enum HelperTools {
    ACTOR_ADD = 'add-actor',
    ACTOR_CALL = 'call-actor',
    ACTOR_GET_DETAILS = 'fetch-actor-details',
    ACTOR_OUTPUT_GET = 'get-actor-output',
    ACTOR_RUNS_ABORT = 'abort-actor-run',
    ACTOR_RUNS_GET = 'get-actor-run',
    ACTOR_RUNS_LOG = 'get-actor-log',
    ACTOR_RUN_LIST_GET = 'get-actor-run-list',
    DATASET_GET = 'get-dataset',
    DATASET_LIST_GET = 'get-dataset-list',
    DATASET_GET_ITEMS = 'get-dataset-items',
    DATASET_SCHEMA_GET = 'get-dataset-schema',
    KEY_VALUE_STORE_LIST_GET = 'get-key-value-store-list',
    KEY_VALUE_STORE_GET = 'get-key-value-store',
    KEY_VALUE_STORE_KEYS_GET = 'get-key-value-store-keys',
    KEY_VALUE_STORE_RECORD_GET = 'get-key-value-store-record',
    STORE_SEARCH = 'search-actors',
    DOCS_SEARCH = 'search-apify-docs',
    DOCS_FETCH = 'fetch-apify-docs',
}

export const defaults = {
    actors: [
        'apify/rag-web-browser',
    ],
};

export const ACTOR_ADDITIONAL_INSTRUCTIONS = 'Never call/execute tool/Actor unless confirmed by the user.';

// Cache
export const ACTOR_CACHE_MAX_SIZE = 500;
export const ACTOR_CACHE_TTL_SECS = 30 * 60; // 30 minutes
export const APIFY_DOCS_CACHE_MAX_SIZE = 500;
export const APIFY_DOCS_CACHE_TTL_SECS = 60 * 60; // 1 hour

export const ACTOR_PRICING_MODEL = {
    /** Rental Actors */
    FLAT_PRICE_PER_MONTH: 'FLAT_PRICE_PER_MONTH',
    FREE: 'FREE',
    /** Pay per result (PPR) Actors */
    PRICE_PER_DATASET_ITEM: 'PRICE_PER_DATASET_ITEM',
    /** Pay per event (PPE) Actors */
    PAY_PER_EVENT: 'PAY_PER_EVENT',
} as const;

/**
 * Used in search Actors tool to search above the input supplied limit,
 * so we can safely filter out rental Actors from the search and ensure we return some results.
 */
export const ACTOR_SEARCH_ABOVE_LIMIT = 50;

export const MCP_STREAMABLE_ENDPOINT = '/mcp';

export const ALGOLIA = {
    appId: 'N8EOCSBQGH',
    apiKey: 'e97714a64e2b4b8b8fe0b01cd8592870', // search only (public) API key
    indexName: 'test_test_apify_sdk',
};

export const PROGRESS_NOTIFICATION_INTERVAL_MS = 5_000; // 5 seconds

export const APIFY_STORE_URL = 'https://apify.com';
