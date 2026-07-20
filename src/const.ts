// Actor input const
export const ACTOR_README_MAX_LENGTH = 5_000;
// Actor enum property max length, we need to make sure that most of the enum values fit into the input (such as geocodes)
export const ACTOR_ENUM_MAX_LENGTH = 2000;
export const ACTOR_MAX_DESCRIPTION_LENGTH = 500;

// Actor run const
export const ACTOR_MAX_MEMORY_MBYTES = 4_096; // If the Actor requires 8GB of memory, free users can't run actors-mcp-server and requested Actor

// Tool output
/**
 * Content larger than this is linked out instead of inlined, since inlining it would blow up the context
 * window (base64 inflates a binary payload ~33%, and a large text/JSON body overflows it just as easily).
 * The key-value-store-record tool caps binaries here (link to a fetchable URL); the API-resource proxy
 * caps every body here — its download is also aborted mid-flight at this limit via axios `maxContentLength`.
 */
export const MAX_INLINE_BYTES = 256 * 1024;

/**
 * Advisory threshold (uncompressed bytes) above which dataset tools append a size hint steering the
 * caller to narrow the fetch. A soft hint, not a truncation cap; ~50 KB mirrors the ~25k-token budget.
 */
export const DATASET_SIZE_HINT_BYTES = 50000;

/** Shared steer appended to large-output hints so the model narrows instead of refetching everything. */
export const NARROW_OUTPUT_HINT = 'narrow with fields= or page with offset';

// MCP Server
/** When `false`, `resolveServerMode('auto', ...)` forces {@link SERVER_MODE.DEFAULT} regardless of client capabilities. */
export const SERVER_MODE_AUTO_DETECTION_ENABLED = true;

export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_TITLE = 'Apify MCP Server';
export const HELPER_TOOLS = {
    ACTOR_ADD: 'add-actor',
    ACTOR_CALL: 'call-actor',
    ACTOR_CALL_WIDGET: 'call-actor-widget',
    ACTOR_GET_DETAILS: 'fetch-actor-details',
    ACTOR_GET_DETAILS_WIDGET: 'fetch-actor-details-widget',
    ACTOR_RUNS_ABORT: 'abort-actor-run',
    ACTOR_RUNS_GET: 'get-actor-run',
    ACTOR_RUNS_GET_WIDGET: 'get-actor-run-widget',
    ACTOR_RUNS_LOG: 'get-actor-log',
    ACTOR_RUN_LIST_GET: 'get-actor-run-list',
    DATASET_GET: 'get-dataset',
    DATASET_LIST_GET: 'get-dataset-list',
    DATASET_GET_ITEMS: 'get-dataset-items',
    DATASET_SCHEMA_GET: 'get-dataset-schema',
    KEY_VALUE_STORE_LIST_GET: 'get-key-value-store-list',
    KEY_VALUE_STORE_GET: 'get-key-value-store',
    KEY_VALUE_STORE_KEYS_GET: 'get-key-value-store-keys',
    KEY_VALUE_STORE_RECORD_GET: 'get-key-value-store-record',
    STORE_SEARCH: 'search-actors',
    STORE_SEARCH_WIDGET: 'search-actors-widget',
    DOCS_SEARCH: 'search-apify-docs',
    DOCS_FETCH: 'fetch-apify-docs',
    PROBLEM_REPORT: 'report-problem',
} as const;
export type HelperToolName = (typeof HELPER_TOOLS)[keyof typeof HELPER_TOOLS];

/**
 * Client-name substrings (lowercased, matched against `clientInfo.name`) that `report-problem` is
 * hidden from. Applied once per connection in the compose step, where the client is known.
 * `report-problem` is hidden from Anthropic surfaces (Claude.ai / Claude Desktop / Claude Code /
 * `local-agent-mode-apify`) pending the directory review. Substring matching covers new client builds
 * without a maintained allowlist; over-matching only hides an optional tool, which is the safe failure
 * mode.
 */
export const REPORT_PROBLEM_BLOCKED_CLIENTS: string[] = ['claude', 'anthropic', 'local-agent-mode-apify'];

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
    actors: [RAG_WEB_BROWSER],
};

/** API rejects `includeInputSchema=true` above this; mirrors apify-core `MAX_LIMIT_WITH_INPUT_SCHEMA`. */
export const MAX_LIMIT_WITH_INPUT_SCHEMA = 10;
/** Max input fields shown inline in text and structured Actor cards. */
export const MAX_INPUT_FIELDS_IN_ACTOR_CARD = 20;

export const ACTOR_PRICING_MODEL = {
    /** Rental Actors */
    FLAT_PRICE_PER_MONTH: 'FLAT_PRICE_PER_MONTH',
    FREE: 'FREE',
    /** Pay per result (PPR) Actors */
    PRICE_PER_DATASET_ITEM: 'PRICE_PER_DATASET_ITEM',
    /** Pay per event (PPE) Actors */
    PAY_PER_EVENT: 'PAY_PER_EVENT',
} as const;

export const DOCS_SOURCES = [
    {
        id: 'apify',
        label: 'Apify',
        appId: 'N8EOCSBQGH',
        apiKey: 'e97714a64e2b4b8b8fe0b01cd8592870',
        indexName: 'test_test_apify_sdk',
        filters: 'version:latest',
        description:
            'Apify Platform documentation including: Platform features, SDKs (JS, Python), CLI, ' +
            'REST API, Academy (web scraping fundamentals), Actor development and deployment',
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
            'Crawlee is a web scraping library for JavaScript. ' +
            'It handles blocking, crawling, proxies, and browsers for you.',
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
            'Crawlee is a web scraping library for Python. ' +
            'It handles blocking, crawling, proxies, and browsers for you.',
    },
] as const;

/**
 * Word window for Algolia `attributesToSnippet` in `search-apify-docs`. Bounds each hit to a
 * match-centered snippet instead of the full indexed `content` attribute — API-reference records
 * inline the whole OpenAPI schema (~34.5k chars each), so 20 hits returned ~173k tokens. The agent
 * fetches full pages via `fetch-apify-docs`.
 */
export const DOCS_SNIPPET_MAX_WORDS = 100;

/**
 * Sentinel used as Algolia `highlightPreTag`/`highlightPostTag` for docs snippets, stripped before
 * returning. An empty-string tag is treated as "unset" and falls back to Algolia's default
 * `<span class="algolia-docsearch-suggestion--highlight">` markup, so we set a private-use
 * character (U+E000) and remove it.
 */
export const DOCS_SNIPPET_HIGHLIGHT_TAG = '\uE000';

export const ALLOWED_DOC_DOMAINS = ['https://docs.apify.com', 'https://crawlee.dev'] as const;

export const APIFY_STORE_URL = 'https://apify.com';
/** Apify Console origin (production). */
export const CONSOLE_BASE_URL = 'https://console.apify.com';
/** Apify Console origin on the staging cluster, selected when running on the staging MCP host. */
export const CONSOLE_BASE_URL_STAGING = 'https://console-securitybyobscurity.apify.com';
/** Staging MCP host; mirrors the check in `getActorMCPServerURL` to pick staging vs production origins. */
export const STAGING_MCP_HOSTNAME = 'mcp-securitybyobscurity.apify.com';
export const APIFY_FAVICON_URL = `${APIFY_STORE_URL}/favicon.ico`;
export const APIFY_LOGO_URL = `${APIFY_STORE_URL}/apple-icon.png`;
export const APIFY_MCP_URL = 'https://mcp.apify.com';
export const APIFY_DOCS_MCP_URL = 'https://docs.apify.com/platform/integrations/mcp';

// Telemetry
export const TELEMETRY_ENV = {
    DEV: 'DEV',
    PROD: 'PROD',
} as const;

export const DEFAULT_TELEMETRY_ENABLED = true;
export const DEFAULT_TELEMETRY_ENV = TELEMETRY_ENV.PROD;

// Tool status
/**
 * Unified status constants for the tool execution lifecycle.
 * Single source of truth for all tool status values.
 */
export const TOOL_STATUS = {
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    ABORTED: 'ABORTED',
    SOFT_FAIL: 'SOFT_FAIL',
} as const;

export const FAILURE_CATEGORY = {
    INVALID_INPUT: 'INVALID_INPUT',
    AUTH: 'AUTH',
    PERMISSION_APPROVAL_REQUIRED: 'PERMISSION_APPROVAL_REQUIRED',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// Apify API error types
export const APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED = 'full-permission-actor-not-approved';
export const APIFY_ERROR_TYPE_MEMORY_LIMIT_EXCEEDED = 'memory-limit-exceeded';
export const APIFY_ERROR_TYPE_CANNOT_START_ACTOR_RUNS = 'cannot-start-actor-runs';

// HTTP status codes
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_PAYMENT_REQUIRED = 402;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;

// Modes that allow long running task tool executions
export const ALLOWED_TASK_TOOL_EXECUTION_MODES = ['optional', 'required'] as const;
