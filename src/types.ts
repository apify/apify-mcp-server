import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { InitializeRequest, Notification, Prompt, Request, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import type {
    Actor as ActorOutdated,
    ActorDefaultRunOptions,
    ActorDefinition,
    ActorRunPricingInfo,
    ActorStats,
    ActorStoreList as ActorStoreListOutdated,
} from 'apify-client';
import type z from 'zod';

import type { ApifyClient } from './apify_client.js';
import type { FAILURE_CATEGORY, TELEMETRY_ENV, TOOL_STATUS } from './const.js';
import type { ActorsMcpServer } from './mcp/server.js';
import type { PaymentProvider } from './payments/types.js';
import type { CATEGORY_NAMES } from './tools/categories.js';
import type { PricingTier, StructuredPricingInfo } from './utils/pricing_info.js';
import type { ProgressTracker } from './utils/progress.js';

export type SchemaProperties = {
    type: string;

    title: string;
    description: string;

    enum?: string[]; // Array of string options for the enum
    enumTitles?: string[]; // Array of string titles for the enum
    default?: unknown;
    prefill?: unknown;

    items?: SchemaProperties;
    editor?: string;
    examples?: unknown[];

    properties?: Record<string, SchemaProperties>;
    required?: string[];
};

export type ActorInputSchema = {
    $id?: string;
    title?: string;
    description?: string;

    type: string;

    properties: Record<string, SchemaProperties>;

    required?: string[];
    schemaVersion?: number;
};

export type ActorDefinitionWithDesc = Omit<ActorDefinition, 'input'> & {
    id: string;
    actorFullName: string;
    description: string;
    readmeSummary?: string;
    defaultRunOptions: ActorDefaultRunOptions;
    input?: ActorInputSchema;
};

/**
 * Pruned Actor definition type.
 * The `id` property is set to Actor ID.
 */
export type ActorDefinitionPruned = Pick<ActorDefinitionWithDesc,
    'id' | 'actorFullName' | 'buildTag' | 'readme' | 'readmeSummary' | 'input' | 'description' | 'defaultRunOptions'> & {
    webServerMcpPath?: string; // Optional, used for Actorized MCP server tools
    pictureUrl?: string; // Optional, URL to the Actor's icon/picture
};

/**
 * Actor definition combined with full actor metadata.
 * Contains both the pruned definition (for schemas) and complete actor info.
 */
export type ActorDefinitionWithInfo = {
    definition: ActorDefinitionPruned;
    info: ActorOutdated;
};

/**
 * Base type for all tools in the MCP server.
 * Extends the MCP SDK's Tool schema, which requires inputSchema to have type: "object".
 * Adds ajvValidate for runtime validation.
 */
export type ToolBase = z.infer<typeof ToolSchema> & {
    /** AJV validation function for the input schema */
    ajvValidate: ValidateFunction;
    /** Whether this tool requires payment validation before execution */
    paymentRequired?: boolean;
};

/**
 * Type for MCP SDK's inputSchema constraint.
 * Extracted directly from the MCP SDK's ToolSchema to ensure alignment with the specification.
 * The MCP SDK requires inputSchema to have type: "object" (literal) at the top level.
 * Use this type when casting schemas that have type: string to the strict MCP format.
 */
export type ToolInputSchema = z.infer<typeof ToolSchema>['inputSchema'];

/**
 * Type for Actor-based tools - tools that wrap Apify Actors.
 * Type discriminator: 'actor'
 */
export type ActorTool = ToolBase & {
    /** Type discriminator for actor tools */
    type: 'actor';
    /** Stable Apify Actor ID (e.g. "JxcaGGqy7TwBdHxMz") — does not change on rename */
    actorId: string;
    /** Full name of the Apify Actor (username/name) */
    actorFullName: string;
    /** Optional memory limit in MB for the Actor execution */
    memoryMbytes?: number;
};

/**
 * Arguments passed to internal tool calls.
 * Contains both the tool arguments and server references.
 */
export type InternalToolArgs = {
    /** Arguments passed to the tool (payment fields already stripped by the server) */
    args: Record<string, unknown>;
    /** MCP request `_meta` field — used by payment providers that read from metadata (e.g., x402) */
    meta?: Record<string, unknown>;
    /** Extra data given to request handlers.
     *
     * Can be used to send notifications from the server to the client.
     *
     * For more details see: https://github.com/modelcontextprotocol/typescript-sdk/blob/f822c1255edcf98c4e73b9bf17a9dd1b03f86716/src/shared/protocol.ts#L102
     */
    extra: RequestHandlerExtra<Request, Notification>;
    /** Reference to the Apify MCP server instance */
    apifyMcpServer: ActorsMcpServer;
    /** Reference to the MCP server instance */
    mcpServer: Server;
    /** Apify API token */
    apifyToken: string;
    /** ApifyClient pre-configured with payment headers (if applicable) or standard token. */
    apifyClient: ApifyClient;
    /** List of Actor IDs that the user has rented */
    userRentedActorIds?: string[];
    /** Optional progress tracker for long running internal tools, like call-actor */
    progressTracker?: ProgressTracker | null;
    /** MCP session ID for logging context */
    mcpSessionId?: string;
};

/**
 * Helper tool - tools implemented directly in the MCP server.
 * Type discriminator: 'internal'
 */
export type HelperTool = ToolBase & {
    /** Type discriminator for helper/internal tools */
    type: 'internal';
    /**
     * Executes the tool with the given arguments
     * @param toolArgs - Arguments and server references
     * @returns Promise resolving to the tool's output
     */
    call: (toolArgs: InternalToolArgs) => Promise<object>;
};

/**
 * Actor MCP tool - tools from Actorized MCP servers that this server proxies.
 * Type discriminator: 'actor-mcp'
 */
export type ActorMcpTool = ToolBase & {
    /** Type discriminator for actor MCP tools */
    type: 'actor-mcp';
    /** Origin MCP server tool name is needed for the tool call */
    originToolName: string;
    /** ID of the Actorized MCP server - for example, apify/actors-mcp-server */
    actorId: string;
    /**
     * ID of the Actorized MCP server the tool is associated with.
     * serverId is generated unique ID based on the serverUrl.
     */
    serverId: string;
    /** Connection URL of the Actorized MCP server */
    serverUrl: string;
};

/**
 * Discriminated union of all tool types.
 *
 * This is a discriminated union that ensures type safety:
 * - When type is 'internal', tool is guaranteed to be HelperTool
 * - When type is 'actor', tool is guaranteed to be ActorTool
 * - When type is 'actor-mcp', tool is guaranteed to be ActorMcpTool
 */
export type ToolEntry = HelperTool | ActorTool | ActorMcpTool;

export type ToolCategory = (typeof CATEGORY_NAMES)[number];
/**
 * Selector for tools input - can be a category key or a specific tool name.
 */
export type ToolSelector = ToolCategory | string;

export type Input = {
    /**
     * When `actors` is undefined, that means the default Actors should be loaded.
     * If it is as an empty string or empty array, then no Actors should be loaded.
     * Otherwise, the specified Actors should be loaded.
     */
    actors?: string[] | string;
    /**
     * @deprecated Use `enableAddingActors` instead.
     */
    enableActorAutoLoading?: boolean | string;
    enableAddingActors?: boolean | string;
    maxActorMemoryBytes?: number;
    /**
     * Tool selectors to include (category keys or concrete tool names).
     * When `tools` is undefined that means the default tool categories should be loaded.
     * If it is an empty string or empty array then no internal tools should be loaded.
     * Otherwise the specified categories and/or concrete tool names should be loaded.
     */
    tools?: ToolSelector[] | string;
};

/**
 * Telemetry environment type.
 * Derived from TELEMETRY_ENV to ensure type safety and avoid duplication.
 */
export type TelemetryEnv = (typeof TELEMETRY_ENV)[keyof typeof TELEMETRY_ENV];

/**
 * Type representing the Actor information needed in order to turn it into an MCP server tool.
 */
export type ActorInfo = {
    webServerMcpPath: string | null; // To determined if the Actor is an MCP server
    definition: ActorDefinitionPruned;
    actor: ActorOutdated;
};

export type ActorStoreList = ActorStoreListOutdated & {
    actorReviewCount?: number;
    actorReviewRating?: number;
    badge?: string | null;
    bookmarkCount?: number;
    categories?: string[];
    currentPricingInfo: ActorRunPricingInfo;
    isWhiteListedForAgenticPayments?: boolean;
    notice?: string | null;
    userFullName?: string;
    stats: ActorStats & {
        actorReviewCount?: number;
        actorReviewRating?: number;
        bookmarkCount?: number;
        publicActorRunStats30Days?: Partial<Record<string, number>> & {
            SUCCEEDED?: number;
            TOTAL?: number;
        };
    };
};

export type Actor = ActorOutdated & {
    actorPermissionLevel?: string;
    hasNoDataset?: boolean;
    isCritical?: boolean;
    isGeneric?: boolean;
    isSourceCodeHidden?: boolean;
    pictureUrl?: string;
    standbyUrl?: string | null;
    stats: ActorStats & {
        publicActorRunStats30Days?: Partial<Record<string, number>> & {
            SUCCEEDED?: number;
            TOTAL?: number;
        };
        actorReviewCount?: number;
        actorReviewRating?: number;
        bookmarkCount?: number;
        lastRunStartedAt?: string | Date | null;
    };
};

export type ActorDefinitionStorage = {
    views: Record<
        string,
        {
            transformation: {
                fields?: string[];
            };
            display: {
                properties: Record<
                    string,
                    object
                >;
            };
        }
    >;
};

export type ApifyDocsSearchResult = {
    /** URL of the documentation page, may include anchor (e.g., https://docs.apify.com/actors#build-actors) */
    url: string;
    /** Piece of content that matches the search query from Algolia */
    content?: string;
};

export type PromptBase = Prompt & {
    /**
     * AJV validation function for the prompt arguments.
     */
    ajvValidate: ValidateFunction;
    /**
     * Function to render the prompt with given arguments
     */
    render: (args: Record<string, string>) => string;
};

export type ActorInputSchemaProperties = Record<string, SchemaProperties>;
export type DatasetItem = Record<number | string, unknown>;
/**
 * Apify token type.
 *
 * Can be null or undefined when a payment provider allows unauthenticated access.
 */
export type ApifyToken = string | null | undefined;

/**
 * Unified status type for the tool execution lifecycle.
 * Derived from TOOL_STATUS to ensure type safety and avoid duplication.
 */
export type ToolStatus = (typeof TOOL_STATUS)[keyof typeof TOOL_STATUS];
export type FailureCategory = (typeof FAILURE_CATEGORY)[keyof typeof FAILURE_CATEGORY];

/**
 * Properties for tool call telemetry events sent to Segment.
 */
export type ToolCallTelemetryProperties = {
    app: 'mcp';
    app_version: string;
    mcp_client_name: string;
    mcp_client_version: string;
    mcp_protocol_version: string;
    mcp_client_capabilities: Record<string, unknown> | null;
    mcp_session_id: string;
    transport_type: string;
    tool_name: string;
    tool_status: ToolStatus;
    tool_exec_time_ms: number;
    failure_category?: FailureCategory;
    failure_http_status?: number;
    failure_detail?: string;
    actor_name?: string;
    actor_id?: string;
    validation_keyword?: string;
    validation_path?: string;
    validation_missing_property?: string;
    validation_additional_property?: string;
    validation_error_count?: number;
};

export type AjvErrorDetails = Pick<ToolCallTelemetryProperties,
    | 'validation_keyword'
    | 'validation_path'
    | 'validation_missing_property'
    | 'validation_additional_property'
    | 'validation_error_count'>;

/**
 * Telemetry reported by tool handlers on the response object.
 * The server reads `toolTelemetry` from the response, strips it, and maps it to CallDiagnostics.
 */
export type ToolTelemetryContext = {
    toolStatus?: ToolStatus;
    failureCategory?: FailureCategory;
    failureHttpStatus?: number;
    failureDetail?: string;
    actorId?: string;
    ajvErrorDetails?: AjvErrorDetails;
};

export type CallDiagnostics = Pick<ToolCallTelemetryProperties,
    | 'failure_category'
    | 'failure_http_status'
    | 'failure_detail'
    | 'actor_name'
    | 'actor_id'
    | 'validation_keyword'
    | 'validation_path'
    | 'validation_missing_property'
    | 'validation_additional_property'
    | 'validation_error_count'>;

/**
 * Server mode — controls which tool variants, descriptions, and response formats are served.
 *
 * - `'default'` — standard MCP tools for generic clients (sync/async execution, text responses)
 * - `'apps'`    — MCP Apps tool variants (always-async execution, widget metadata)
 *
 * The `'apps'` name comes from the [MCP Apps specification (2026-01-26)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
 * the open standard for widget-embedded UI in MCP clients. The value was previously
 * named `'openai'` but is renamed here to reflect that the protocol is no longer
 * OpenAI-specific; `'openai'` is kept as a deprecated alias at CLI/env ingestion
 * (see {@link parseServerMode}) and is silently normalized to `'apps'`.
 */
export const ServerMode = {
    DEFAULT: 'default',
    APPS: 'apps',
} as const;
export type ServerMode = (typeof ServerMode)[keyof typeof ServerMode];

/** All valid server modes, for iteration in tests and caches. */
export const SERVER_MODES: readonly ServerMode[] = Object.values(ServerMode);

/**
 * Server mode option — a concrete {@link ServerMode} or `'auto'` to resolve from
 * the client's `initialize` capabilities at connection time.
 */
export type ServerModeOption = ServerMode | 'auto';

/**
 * Parameters for executing a direct actor tool (`type: 'actor'`).
 * Used by ActorExecutor implementations.
 */
export type ActorExecutionParams = {
    /** Full name of the Actor (e.g., "apify/rag-web-browser") */
    actorFullName: string;
    /** Input to pass to the Actor (payment fields already stripped) */
    input: Record<string, unknown>;
    /** Apify client (may include payment headers) */
    apifyClient: ApifyClient;
    /** Call options (memory, timeout) */
    callOptions: { memory?: number; timeout?: number };
    /** Progress tracker for sending progress notifications */
    progressTracker?: ProgressTracker | null;
    /** Signal for aborting the execution */
    abortSignal?: AbortSignal;
    /** MCP session ID for logging */
    mcpSessionId?: string;
};

/**
 * Result from an ActorExecutor.
 * Returns `null` when the execution was aborted.
 */
export type ActorExecutionResult = {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
} | null;

/**
 * Executor for direct actor tools (`type: 'actor'`).
 * Selected at server construction time based on serverMode.
 * Default mode runs synchronously; apps mode runs async with widget metadata.
 */
export type ActorExecutor = {
    executeActorTool(params: ActorExecutionParams): Promise<ActorExecutionResult>;
};

/**
 * External store for Actor metadata that can be injected by the hosting environment.
 * Provides access to Actor output schemas inferred from historical run data.
 * When not provided, tools use generic output schemas without field-level detail.
 */
export type ActorStore = {
    /**
     * Returns the inferred JSON Schema properties for an Actor's dataset items,
     * based on historical successful runs.
     *
     * The returned object should be a JSON Schema `properties` object, e.g.:
     * `{ url: { type: 'string' }, price: { type: 'number' } }`
     *
     * Returns null if no schema is available (e.g., new Actor with no runs).
     * Internally calls `getActorOutputSchemaAsTypeObject` and converts the result.
     *
     * @param actorFullName - Full Actor name in "username/name" format (e.g., "apify/rag-web-browser")
     */
    getActorOutputSchema(actorFullName: string): Promise<Record<string, unknown> | null>;

    /**
     * Returns the inferred output schema as a simplified type object for an Actor's dataset items,
     * based on historical successful runs.
     *
     * The returned object uses a compact type representation, e.g.:
     * `{ url: "string", price: "number", tags: ["string"], user: { name: "string" } }`
     *
     * This is the core method that performs cache lookup, API resolution, and MongoDB queries.
     * Results are cached with TTL to avoid repeated database queries.
     *
     * Returns null if no schema is available (e.g., new Actor with no runs).
     *
     * @param actorFullName - Full Actor name in "username/name" format (e.g., "apify/rag-web-browser")
     */
    getActorOutputSchemaAsTypeObject(actorFullName: string): Promise<Record<string, unknown> | null>;
};

/**
 * Options for configuring the ActorsMcpServer instance.
 */
export type ActorsMcpServerOptions = {
    /**
     * Task store for long running tasks support.
     */
    taskStore?: TaskStore;
    /**
     * External store for Actor metadata (output schemas).
     * When provided, Actor tools will have enriched output schemas with field-level detail.
     * Only used by the streamable HTTP transport in hosted deployments.
     */
    actorStore?: ActorStore;
    setupSigintHandler?: boolean;
    /**
     * Payment provider for agentic payment modes (e.g., Skyfire, x402).
     * When set, enables payment-gated tool execution.
     */
    paymentProvider?: PaymentProvider;
    /**
     * Allow unauthenticated mode - tools can be called without an Apify API token.
     * This is primarily used for making documentation tools available without authentication.
     * When enabled, Apify token validation is skipped.
     * Default: false
     */
    allowUnauthMode?: boolean;
    initializeRequestData?: InitializeRequest;
    /**
     * Telemetry configuration options.
     */
    telemetry?: {
        /**
         * Enable or disable telemetry tracking for tool calls.
         * Must be explicitly set when telemetry object is provided.
         * When a telemetry object is omitted entirely, defaults to true (via env var or default).
         */
        enabled: boolean;
        /**
         * Telemetry environment when telemetry is enabled.
         * - 'DEV': Use development Segment write key
         * - 'PROD': Use production Segment write key (default)
         */
        env?: TelemetryEnv;
    };
    /**
     * Transport type for telemetry tracking.
     * Important: this is also used for the long-running tasks logic
     *  which is different for local and remote server based on the transport type.
     * - 'stdio': Direct/local stdio connection
     * - 'http': Remote HTTP streamable connection
     * - 'sse': Remote Server-Sent Events (SSE) connection (deprecated, removal on 2026-04-01)
     */
    transportType?: 'stdio' | 'http' | 'sse';
    /**
     * Apify API token for authentication
     * Primarily used by stdio transport when token is read from ~/.apify/auth.json file
     * instead of APIFY_TOKEN environment variable, so it can be passed to the server
     */
    token?: string;
    /**
     * Server mode — controls tool variants and response formats. See {@link ServerMode}.
     * Pass `'auto'` (or omit) to resolve from the client's `initialize` capabilities;
     * pass `'default'` or `'apps'` to force a specific mode and skip auto-detect.
     * Defaults to `'auto'` when unset.
     */
    serverMode?: ServerModeOption;
    /**
     * @deprecated Use `serverMode` instead.
     */
    uiMode?: string;
}

export type StructuredActorCard = {
    title?: string;
    url: string;
    id: string;
    fullName: string;
    pictureUrl?: string;
    developer: {
        username: string;
        isOfficialApify: boolean;
        url: string;
    };
    description: string;
    categories: string[];
    pricing: StructuredPricingInfo;
    stats?: {
        totalUsers: number;
        monthlyUsers: number;
        successRate?: number;
        bookmarks?: number;
    };
    rating?: {
        average: number;
        count: number;
    };
    modifiedAt?: string;
    isDeprecated: boolean;
}

/**
 * Options for controlling which sections to include in an Actor card.
 * All options default to true for backwards compatibility.
 */
export type ActorCardOptions = {
    /** Include description text only */
    includeDescription?: boolean;
    /** Include usage statistics (users, runs, success rate, bookmarks) */
    includeStats?: boolean;
    /** Include pricing information */
    includePricing?: boolean;
    /** Include rating */
    includeRating?: boolean;
    /** Include metadata (developer, categories, last modified date, deprecation warning) */
    includeMetadata?: boolean;
    /** User's plan tier. Defaults to FREE inside the formatters when unset. */
    userTier?: PricingTier;
    /**
     * true → filter `tieredPricing` down to the user's resolved tier (search-actors).
     * false/undefined → keep the full tiered matrix (fetch-actor-details).
     */
    simplifyPricingForUserTier?: boolean;
}

/**
 * MCP request parameters with Apify-specific extensions.
 * Extends the standard MCP params object with Apify custom fields in the _meta object.
 */
export type ApifyRequestParams = {
    /**
     * Metadata object for MCP and Apify-specific fields.
     */
    _meta?: {
        /** Session ID for tracking MCP requests across the Apify server */
        mcpSessionId?: string;
        /** Apify API token for authentication */
        apifyToken?: string;
        /** List of Actor IDs that the user has rented */
        userRentedActorIds?: string[];
        /** Progress token for out-of-band progress notifications (standard MCP) */
        progressToken?: string | number;
        /** Allow other metadata fields */
        [key: string]: unknown;
    };
    /** Allow any other request parameters */
    [key: string]: unknown;
};

/** MCP Server Card per SEP-1649. */
export type ServerCard = {
    $schema: string;
    version: string;
    protocolVersion: string;
    serverInfo: {
        name: string;
        title: string;
        version: string;
    };
    description: string;
    iconUrl: string;
    documentationUrl: string;
    transport: {
        type: string;
        endpoint: string;
    };
    capabilities: {
        tools: { listChanged: boolean };
    };
    authentication: {
        required: boolean;
        schemes: string[];
    };
    tools: string;
};
