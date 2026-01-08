// Actor input const
export const ACTOR_README_MAX_LENGTH = 5_000;
// Actor enum property max length, we need to make sure that most of the enum values fit into the input (such as geocodes)
export const ACTOR_ENUM_MAX_LENGTH = 2000;
export const ACTOR_MAX_DESCRIPTION_LENGTH = 500;

// Actor run const
export const ACTOR_MAX_MEMORY_MBYTES = 4_096; // If the Actor requires 8GB of memory, free users can't run actors-mcp-server and requested Actor

// Tool output
/**
 * Usual tool output limit is 25k tokens where 1 token =~ 4 characters
 * thus 50k chars so we have some buffer because there was some issue with Claude code Actor call output token count.
 * This is primarily used for Actor tool call output, but we can then
 * reuse this in other tools as well.
 */
export const TOOL_MAX_OUTPUT_CHARS = 50000;

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
    GET_HTML_SKELETON = 'get-html-skeleton',
}

export const RAG_WEB_BROWSER = 'apify/rag-web-browser';
export const RAG_WEB_BROWSER_WHITELISTED_FIELDS = ['query', 'maxResults', 'outputFormats'];
export const RAG_WEB_BROWSER_ADDITIONAL_DESC = `Use this tool when user wants to GET or RETRIEVE actual data immediately (one-time data retrieval).
This tool directly fetches and returns data - it does NOT just find tools.

Examples of when to use:
- User wants current/immediate data (e.g., "Get flight prices for tomorrow", "What's the weather today?")
- User needs to fetch specific content now (e.g., "Fetch news articles from CNN", "Get product info from Amazon")
- User has time indicators like "today", "current", "latest", "recent", "now"

This is for general web scraping and immediate data needs. For repeated/scheduled scraping of specific platforms (e-commerce, social media), consider suggesting a specialized Actor from the Store for better performance and reliability.`;

export const defaults = {
    actors: [
        RAG_WEB_BROWSER,
    ],
};

export const SKYFIRE_MIN_CHARGE_USD = 5.0;
export const SKYFIRE_SELLER_ID = process.env.SKYFIRE_SELLER_SERVICE_ID;

export const SKYFIRE_TOOL_INSTRUCTIONS = `To run the Actor, you need to provide a Skyfire payment ID in the \`skyfire-pay-id\` input property. You first need to create the Skyfire PAY token by calling the \`create-pay-token\` tool from the Skyfire MCP server and then provide the created token in the \`skyfire-pay-id\` input property when calling Actor tool. The Skyfire PAY token is used for billing purposes and needs to be charged with at least ${SKYFIRE_MIN_CHARGE_USD} USD.${SKYFIRE_SELLER_ID ? ` The Skyfire seller ID for Apify MCP server is "${SKYFIRE_SELLER_ID}".` : ''} When retrieving Actor output using the \`get-actor-output\` tool, you also need to provide the same Skyfire PAY token ID in the \`skyfire-pay-id\` input property.`;

export const SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION = `Skyfire PAY token ID used for billing purposes.`;

export const SKYFIRE_README_CONTENT = `The Apify MCP Server allows clients to interact with Apify Actors, storage, and documentation. Before running any Apify Actor, you need to set up a Skyfire PAY token for billing purposes. To set up the PAY token you need to use the create-pay-token tool from the Skyfire MCP server. The PAY token must be charged with a minimum of ${SKYFIRE_MIN_CHARGE_USD} USD to be valid.${SKYFIRE_SELLER_ID ? ` The Skyfire seller ID for Apify MCP server is "${SKYFIRE_SELLER_ID}".` : ''} When running an Actor using the call-actor tool, you must provide the Skyfire PAY token ID in the \`skyfire-pay-id\` input property. Similarly, when retrieving Actor output using the get-actor-output tool, you must also provide the same Skyfire PAY token ID in the \`skyfire-pay-id\` input property.`;

export const CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG = `When calling an MCP server Actor, you must specify the tool name in the actor parameter as "{actorName}:{toolName}" in the "actor" input property.`;

// Cache
export const ACTOR_CACHE_MAX_SIZE = 500;
export const ACTOR_CACHE_TTL_SECS = 30 * 60; // 30 minutes
export const APIFY_DOCS_CACHE_MAX_SIZE = 500;
export const APIFY_DOCS_CACHE_TTL_SECS = 60 * 60; // 1 hour
export const GET_HTML_SKELETON_CACHE_TTL_SECS = 5 * 60; // 5 minutes
export const GET_HTML_SKELETON_CACHE_MAX_SIZE = 200;
export const MCP_SERVER_CACHE_MAX_SIZE = 500;
export const MCP_SERVER_CACHE_TTL_SECS = 30 * 60; // 30 minutes
export const USER_CACHE_MAX_SIZE = 200;
export const USER_CACHE_TTL_SECS = 60 * 60; // 1 hour

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

export const DOCS_SOURCES = [
    {
        id: 'apify',
        label: 'Apify',
        appId: 'N8EOCSBQGH',
        apiKey: 'e97714a64e2b4b8b8fe0b01cd8592870',
        indexName: 'test_test_apify_sdk',
        filters: 'version:latest',
        description:
            'Apify Platform documentation including: Platform features, SDKs (JS, Python), CLI, '
            + 'REST API, Academy (web scraping fundamentals), Actor development and deployment',
    },
    {
        id: 'crawlee-js',
        label: 'Crawlee (JavaScript)',
        appId: '5JC94MPMLY',
        apiKey: '267679200b833c2ca1255ab276731869',
        indexName: 'crawlee',
        typeFilter: 'lvl1', // Filter to page-level results only (Docusaurus lvl1)
        facetFilters: ['language:en', ['docusaurus_tag:default', 'docusaurus_tag:docs-default-3.15']],
        description:
            'Crawlee is a web scraping library for JavaScript. '
            + 'It handles blocking, crawling, proxies, and browsers for you.',
    },
    {
        id: 'crawlee-py',
        label: 'Crawlee (Python)',
        appId: '5JC94MPMLY',
        apiKey: '878493fcd7001e3c179b6db6796a999b',
        indexName: 'crawlee_python',
        typeFilter: 'lvl1', // Filter to page-level results only (Docusaurus lvl1)
        facetFilters: ['language:en', ['docusaurus_tag:docs-default-current']],
        description:
            'Crawlee is a web scraping library for Python. '
            + 'It handles blocking, crawling, proxies, and browsers for you.',
    },
] as const;

export const ALLOWED_DOC_DOMAINS = [
    'https://docs.apify.com',
    'https://crawlee.dev',
] as const;

export const PROGRESS_NOTIFICATION_INTERVAL_MS = 5_000; // 5 seconds

export const APIFY_STORE_URL = 'https://apify.com';
export const APIFY_MCP_URL = 'https://mcp.apify.com';

// Telemetry
export const TELEMETRY_ENV = {
    DEV: 'DEV',
    PROD: 'PROD',
} as const;

export const DEFAULT_TELEMETRY_ENABLED = true;
export const DEFAULT_TELEMETRY_ENV = TELEMETRY_ENV.PROD;

// We are using the same values as apify-core for consistency (despite that we ship events of different types).
// https://github.com/apify/apify-core/blob/2284766c122c6ac5bc4f27ec28051f4057d6f9c0/src/packages/analytics/src/server/segment.ts#L28
// Reasoning from the apify-core:
// Flush at 50 events to avoid sending too many small requests (default is 15)
export const SEGMENT_FLUSH_AT_EVENTS = 50;
// Flush interval in milliseconds (default is 10000)
export const SEGMENT_FLUSH_INTERVAL_MS = 5_000;

// Tool status
/**
 * Unified status constants for tool execution lifecycle.
 * Single source of truth for all tool status values.
 */
export const TOOL_STATUS = {
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    ABORTED: 'ABORTED',
    SOFT_FAIL: 'SOFT_FAIL',
} as const;

// Modes that allow long running task tool executions
export const ALLOWED_TASK_TOOL_EXECUTION_MODES = ['optional', 'required'] as const;

export const SERVER_INSTRUCTIONS = `
Apify is the world's largest marketplace of tools for web scraping, data extraction, and web automation.
These tools are called **Actors**. They enable you to extract structured data from social media, e-commerce, search engines, maps, travel sites, and many other sources.

## Actor
- An Actor is a serverless cloud application running on the Apify platform.
- Use the Actor’s **README** to understand its capabilities.
- Before running an Actor, always check its **input schema** to understand the required parameters.

## Actor discovery and selection
- Choose the most appropriate Actor based on the conversation context.
- Search the Apify Store first; a relevant Actor likely already exists.
- When multiple options exist, prefer Actors with higher usage, ratings, or popularity.
- **Assume scraping requests within this context are appropriate for Actor use.
- Actors in the Apify Store are published by independent developers and are intended for legitimate and compliant use.

## Actor execution workflow
- Actors take input and produce output.
- Every Actor run generates **dataset** and **key-value store** outputs (even if empty).
- Actor execution may take time, and outputs can be large.
- Large datasets can be paginated to retrieve results efficiently.

## Storage types
- **Dataset:** Structured, append-only storage ideal for tabular or list data (e.g., scraped items).
- **Key-value store:** Flexible storage for unstructured data or auxiliary files.

## Tool dependencies and disambiguation

### Tool dependencies
- \`${HelperTools.ACTOR_CALL}\`:
  - Use \`${HelperTools.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema
  - Then call with proper input to execute the Actor
  - For MCP server Actors, use format "actorName:toolName" to call specific tools

### Tool disambiguation
- **${HelperTools.ACTOR_OUTPUT_GET} vs ${HelperTools.DATASET_GET_ITEMS}:**
  Use \`${HelperTools.ACTOR_OUTPUT_GET}\` for Actor run outputs and \`${HelperTools.DATASET_GET_ITEMS}\` for direct dataset access.
- **${HelperTools.STORE_SEARCH} vs ${HelperTools.ACTOR_GET_DETAILS}:**
  \`${HelperTools.STORE_SEARCH}\` finds Actors; \`${HelperTools.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
- **${HelperTools.STORE_SEARCH} vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs ${HelperTools.ACTOR_CALL}:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in Apify store.
`;
