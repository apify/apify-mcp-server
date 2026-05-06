/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { randomUUID } from 'node:crypto';

// The ext-apps package exposes `./server` via conditional exports only (no `./server/index.js`
// wildcard), so we can't satisfy the `import/extensions` rule on this subpath.
// eslint-disable-next-line import/extensions
import { getUiCapability, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest, InitializeResult, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelTaskRequestSchema,
    ErrorCode,
    GetPromptRequestSchema,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    InitializeRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListTasksRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
    ServerNotificationSchema,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import dedent from 'dedent';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from '../apify_client.js';
import {
    ALLOWED_TASK_TOOL_EXECUTION_MODES,
    APIFY_MCP_URL,
    DEFAULT_TELEMETRY_ENABLED,
    DEFAULT_TELEMETRY_ENV,
    FAILURE_CATEGORY,
    HelperTools,
    HTTP_PAYMENT_REQUIRED,
    SERVER_NAME,
    TOOL_STATUS,
} from '../const.js';
import { prepareToolCallContext } from '../payments/helpers.js';
import { prompts } from '../prompts/index.js';
import { createResourceService } from '../resources/resource_service.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';
import { getTelemetryEnv, trackToolCall } from '../telemetry.js';
import { appsActorExecutor } from '../tools/apps/actor_executor.js';
import { buildPermissionApprovalResponse, isPermissionApprovalError } from '../tools/core/call_actor_common.js';
import { defaultActorExecutor } from '../tools/default/actor_executor.js';
import { getActorsAsTools } from '../tools/index.js';
import { decodeDotPropertyNames, legacyToolNameToNew } from '../tools/utils.js';
import type {
    ActorExecutor,
    ActorsMcpServerOptions,
    ActorStore,
    ApifyRequestParams,
    CallDiagnostics,
    Input,
    ServerModeOption,
    TelemetryEnv,
    ToolCallTelemetryProperties,
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { ServerMode } from '../types.js';
import { getHttpStatusCode, logHttpError } from '../utils/logging.js';
import { buildMCPResponse, getToolCallErrorUserText } from '../utils/mcp.js';
import { buildPaymentRequiredResponse } from '../utils/payment_errors.js';
import { createProgressTracker } from '../utils/progress.js';
import { parseServerMode, resolveServerMode } from '../utils/server_mode.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { classifyFailureCategory, extractAjvErrorDetails, extractToolTelemetry, getToolStatusFromError } from '../utils/tool_status.js';
import { buildActorFields, extractActorId, extractActorName, getToolFullName, getToolPublicFieldOnly } from '../utils/tools.js';
import {
    getActors,
    getToolsForServerMode,
    toolNamesToInput,
} from '../utils/tools_loader.js';
import { getUserInfoCached } from '../utils/userid_cache.js';
import { getPackageVersion } from '../utils/version.js';
import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, LOG_LEVEL_MAP } from './const.js';
import { isTaskCancelled, parseInputParamsFromUrl } from './utils.js';

/** Mode → actor executor. Add new modes here. */
const actorExecutorsByMode: Record<ServerMode, ActorExecutor> = {
    [ServerMode.DEFAULT]: defaultActorExecutor,
    [ServerMode.APPS]: appsActorExecutor,
};

/**
 * Returns true when the initialize request advertises the MCP Apps UI extension
 * with the widget MIME type. Used to resolve `'auto'` server mode.
 *
 * Uses {@link getUiCapability} from `@modelcontextprotocol/ext-apps/server` to
 * read the `io.modelcontextprotocol/ui` extension from client capabilities — the
 * canonical way per the MCP Apps spec.
 */
function isUiSupportedByClient(request: InitializeRequest | undefined): boolean {
    const uiCap = getUiCapability(request?.params?.capabilities);
    return uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

type ToolsChangedHandler = (toolNames: string[]) => void;

/**
 * Create Apify MCP server
 */
export class ActorsMcpServer {
    public readonly server: Server;
    public readonly tools: Map<string, ToolEntry>;
    private toolsChangedHandler: ToolsChangedHandler | undefined;
    private sigintHandler: (() => Promise<void>) | undefined;
    private currentLogLevel = 'info';
    public readonly options: ActorsMcpServerOptions;
    public readonly taskStore: TaskStore;
    public readonly actorStore?: ActorStore;
    /**
     * Resolved server mode. Preliminary value at construction (`'auto'` → `DEFAULT`).
     * Finalized inside the `initialize` request handler (see constructor) once the
     * client's capabilities are known. Effectively set-once per connection.
     */
    public serverMode: ServerMode;
    /** Mode-specific executor for direct actor tools (`type: 'actor'`). Finalized with `serverMode`. */
    private actorExecutor: ActorExecutor;
    /**
     * Raw option captured from `options.serverMode` (or the legacy `uiMode`). Re-resolved
     * inside the initialize handler when set to `'auto'`; explicit `'default'`/`'apps'`
     * values bypass auto-detect.
     */
    private readonly serverModeOption: ServerModeOption;
    /** True once mode is final. False for `'auto'` until the initialize handler resolves client capabilities. */
    private serverModeResolved: boolean;
    /**
     * Tool requests queued before mode is final. Actor tools are upserted immediately
     * (mode-agnostic); we also capture the exact actor-tool slice fetched for each
     * request so the flush composes every entry against *its own* actor list rather
     * than the accumulated union across unrelated requests.
     */
    private pendingToolsAfterModeResolved: { input: Input; actorTools: ToolEntry[] }[] = [];

    // Telemetry configuration (resolved from options and env vars in setupTelemetry)
    private telemetryEnabled: boolean | null = null;
    private telemetryEnv: TelemetryEnv = DEFAULT_TELEMETRY_ENV;

    // List of widgets that are ready to be served
    private availableWidgets: Map<string, AvailableWidget> = new Map();

    /** Set in the initialize handler once client capabilities are known. */
    public clientSupportsUi = false;

    constructor(options: ActorsMcpServerOptions = {}) {
        this.options = options;

        // for stdio use in memory task store if not provided, otherwise use provided task store
        if (this.options.transportType === 'stdio' && !this.options.taskStore) {
            this.taskStore = new InMemoryTaskStore();
        } else if (this.options.taskStore) {
            this.taskStore = this.options.taskStore;
        } else {
            throw new Error('Task store must be provided for non-stdio transport types');
        }
        this.actorStore = options.actorStore;
        // Constructor is an ingestion boundary for programmatic callers. Normalize via
        // parseServerMode so that runtime-invalid values ('openai' alias, stray strings)
        // and the legacy `uiMode` field name are accepted gracefully during the transition
        // to the canonical `serverMode` API. Remove the `uiMode` fallback once internal
        // consumers have migrated (see apify-mcp-server-internal#454).
        const legacyUiMode = (options as { uiMode?: string }).uiMode;
        const rawServerMode = options.serverMode as string | undefined;
        this.serverModeOption = rawServerMode !== undefined
            ? parseServerMode(rawServerMode)
            : parseServerMode(legacyUiMode);
        // Preliminary resolution — re-resolved inside the initialize handler once
        // client capabilities are known (only for 'auto').
        this.serverMode = resolveServerMode(this.serverModeOption, false);
        this.serverModeResolved = this.serverModeOption !== 'auto';
        this.actorExecutor = actorExecutorsByMode[this.serverMode];

        const { setupSigintHandler = true } = options;
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: getPackageVersion()!,
                websiteUrl: APIFY_MCP_URL,
            },
            {
                capabilities: {
                    tools: {
                        listChanged: true,
                    },
                    // Declare long-running task support
                    tasks: {
                        list: {},
                        cancel: {},
                        requests: {
                            tools: {
                                call: {},
                            },
                        },
                    },
                    /**
                     * Declaring resources even though we are not using them
                     * to prevent clients like Claude desktop from failing.
                     */
                    resources: { },
                    prompts: { },
                    logging: {},
                },
                instructions: getServerInstructions(),
            },
        );
        this.setupTelemetry();
        this.setupInitializeHandler();
        this.setupLoggingProxy();
        this.tools = new Map();
        this.setupErrorHandling(setupSigintHandler);
        this.setupLoggingHandlers();
        this.setupToolHandlers();
        this.setupPromptHandlers();
        /**
         * We need to handle resource requests to prevent clients like Claude desktop from failing.
         */
        this.setupResourceHandlers();
        this.setupTaskHandlers();
    }

    /**
     * Telemetry configuration with precedence: explicit options > env vars > defaults
     */
    private setupTelemetry() {
        const explicitEnabled = parseBooleanOrNull(this.options.telemetry?.enabled);
        if (explicitEnabled !== null) {
            this.telemetryEnabled = explicitEnabled;
        } else {
            const envEnabled = parseBooleanOrNull(process.env.TELEMETRY_ENABLED);
            this.telemetryEnabled = envEnabled ?? DEFAULT_TELEMETRY_ENABLED;
        }

        // Configure telemetryEnv: explicit option > env var > default ('PROD')
        if (this.telemetryEnabled) {
            this.telemetryEnv = getTelemetryEnv(this.options.telemetry?.env ?? process.env.TELEMETRY_ENV);
        }
    }

    /**
     * Override the SDK's `initialize` request handler to run mode resolution and
     * pending-source flush before `InitializeResult` is sent. Delegates boilerplate
     * (protocolVersion, capabilities, instructions) to the SDK's captured `_oninitialize`.
     *
     * Not using `server.oninitialized`: the SDK dispatches notification handlers
     * fire-and-forget (separate microtask), so a follow-up `tools/list` can race past them.
     * The request handler guarantees tools are final before the response and the first `tools/list`.
     */
    private setupInitializeHandler() {
        // Capture the SDK's default initialize handler installed in its constructor.
        // Private-field access on the SDK Server — verified against
        // @modelcontextprotocol/sdk ^1.25.x (see package.json). On SDK bumps, re-check
        // `@modelcontextprotocol/sdk/shared/protocol.js` for a still-named `_oninitialize`;
        // if renamed or made non-delegable, rebuild the InitializeResult shape here
        // (protocolVersion, serverInfo, capabilities, instructions) instead of delegating.
        // The capability-gating unit tests construct a server and act as a canary.
        // eslint-disable-next-line no-underscore-dangle
        const sdkInitHandler = (this.server as unknown as {
            _oninitialize(req: InitializeRequest): Promise<InitializeResult>;
        })._oninitialize.bind(this.server);

        this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
            this.clientSupportsUi = isUiSupportedByClient(request);

            if (this.serverModeOption === 'auto') {
                const resolved = resolveServerMode('auto', this.clientSupportsUi);
                if (resolved !== this.serverMode) {
                    this.serverMode = resolved;
                    this.actorExecutor = actorExecutorsByMode[this.serverMode];
                }
                this.serverModeResolved = true;
            }

            (this.options as Record<string, unknown>).initializeRequestData = request;

            log.info('Resolved server mode for connection', {
                serverMode: this.serverMode,
                serverModeOption: this.serverModeOption,
                clientSupportsUi: this.clientSupportsUi,
            });

            this.updateToolsAfterServerModeResolved();

            await this.resolveWidgets();

            const result = await sdkInitHandler(request);
            result.instructions = getServerInstructions(this.serverMode);
            return result;
        });
    }

    private updateToolsAfterServerModeResolved(): void {
        if (this.pendingToolsAfterModeResolved.length === 0) return;

        const tools = this.pendingToolsAfterModeResolved.flatMap(
            ({ input, actorTools }) => getToolsForServerMode(input, actorTools, this.serverMode),
        );

        this.pendingToolsAfterModeResolved = [];

        // Notify after the flush so shared-state handlers (e.g. Redis recovery) see
        // the final tool set, including mode-specific helpers added here. Pre-init,
        // `loadToolsByName` may have fired `upsertTools(actorTools, true)` with actor
        // tools only (helpers still queued), and `loadToolsFromUrl` / `loadToolsFromInput`
        // don't notify at all — this call reconciles both paths to the complete set.
        if (tools.length > 0) this.upsertTools(tools, true);
    }

    /**
     * Returns an array of tool names.
     * @returns {string[]} - An array of tool names.
     */
    public listToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
    * Register handler to get notified when tools change.
    * The handler receives an array of tool names that the server has after the change.
    * This is primarily used to store the tools in shared state (e.g., Redis) for recovery
    * when the server loses local state.
    * @throws {Error} - If a handler is already registered.
    * @param handler - The handler function to be called when tools change.
    */
    public registerToolsChangedHandler(handler: (toolNames: string[]) => void) {
        if (this.toolsChangedHandler) {
            throw new Error('Tools changed handler is already registered.');
        }
        this.toolsChangedHandler = handler;
    }

    /**
    * Unregister the handler for tools changed event.
    * @throws {Error} - If no handler is currently registered.
    */
    public unregisterToolsChangedHandler() {
        if (!this.toolsChangedHandler) {
            throw new Error('Tools changed handler is not registered.');
        }
        this.toolsChangedHandler = undefined;
    }

    /**
     * Returns the list of all internal tool names
     * @returns {string[]} - Array of loaded tool IDs (e.g., 'apify/rag-web-browser')
     */
    private listInternalToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === 'internal')
            .map((tool) => tool.name);
    }

    /**
     * Returns the list of all currently loaded Actor tool IDs.
     * @returns {string[]} - Array of loaded Actor tool IDs (e.g., 'apify/rag-web-browser')
     */
    public listActorToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === 'actor')
            .map((tool) => tool.actorFullName);
    }

    /**
     * Returns a list of Actor IDs that are registered as MCP servers.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    private listActorMcpServerToolIds(): string[] {
        const ids = Array.from(this.tools.values())
            .filter((tool: ToolEntry) => tool.type === 'actor-mcp')
            .map((tool) => tool.actorId);
        // Ensure uniqueness
        return Array.from(new Set(ids));
    }

    /**
     * Returns a list of Actor name and MCP server tool IDs.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    public listAllToolNames(): string[] {
        return [...this.listInternalToolNames(), ...this.listActorToolNames(), ...this.listActorMcpServerToolIds()];
    }

    /**
    * Loads missing toolNames from a provided list of tool names.
    * Skips toolNames that are already loaded and loads only the missing ones.
    * @param toolNames - Array of tool names to ensure are loaded
    * @param apifyClient
    */
    public async loadToolsByName(toolNames: string[], apifyClient: ApifyClient) {
        const loadedTools = new Set(this.listAllToolNames());
        const missingToolNames = toolNames.filter((toolName) => !loadedTools.has(toolName));
        if (missingToolNames.length === 0) return;

        const restoreInput = toolNamesToInput(missingToolNames);
        const actorTools = await getActors(restoreInput, apifyClient, this.actorStore);

        if (!this.serverModeResolved) {
            this.pendingToolsAfterModeResolved.push({ input: restoreInput, actorTools });
            if (actorTools.length > 0) this.upsertTools(actorTools, true);
            return;
        }

        const toolsToLoad = getToolsForServerMode(restoreInput, actorTools, this.serverMode);
        if (toolsToLoad.length > 0) {
            this.upsertTools(toolsToLoad, actorTools.length > 0);
        }
    }

    /**
     * Load actors as tools, upsert them to the server, and return the tool entries.
     * This is a public method that wraps getActorsAsTools and handles the upsert operation.
     * @param actorIdsOrNames - Array of actor IDs or names to load as tools
     * @param apifyClient
     * @returns Promise<ToolEntry[]> - Array of loaded tool entries
     */
    public async loadActorsAsTools(actorIdsOrNames: string[], apifyClient: ApifyClient): Promise<ToolEntry[]> {
        const actorTools = await getActorsAsTools(actorIdsOrNames, apifyClient, { actorStore: this.actorStore });
        if (actorTools.length > 0) {
            this.upsertTools(actorTools, true);
        }
        return actorTools;
    }

    /** Load tools from URL params. Used by SSE and HTTP entry points. */
    public async loadToolsFromUrl(url: string, apifyClient: ApifyClient) {
        const input = parseInputParamsFromUrl(url);
        const actorTools = await getActors(input, apifyClient, this.actorStore);

        if (!this.serverModeResolved) {
            this.pendingToolsAfterModeResolved.push({ input, actorTools });
            if (actorTools.length > 0) {
                log.debug('Loading actor tools from query parameters before mode resolution');
                this.upsertTools(actorTools, false);
            }
            return;
        }

        const tools = getToolsForServerMode(input, actorTools, this.serverMode);
        if (tools.length > 0) {
            log.debug('Loading tools from query parameters');
            this.upsertTools(tools, false);
        }
    }

    /**
     * Two-phase: getActors (async, mode-agnostic Apify fetch) then getToolsForServerMode
     * (sync, mode-dependent compose). When mode is unresolved, queue actorTools and let
     * the initialize handler compose them later.
     *
     * Don't move the getActors await into the initialize handler — clients time out
     * waiting for InitializeResult. The queue buffers already-fetched data, not network
     * work. See #721.
     */
    public async loadToolsFromInput(input: Input, apifyClient: ApifyClient): Promise<void> {
        const actorTools = await getActors(input, apifyClient, this.actorStore);
        if (!this.serverModeResolved) {
            this.pendingToolsAfterModeResolved.push({ input, actorTools });
            if (actorTools.length > 0) this.upsertTools(actorTools);
            return;
        }
        const tools = getToolsForServerMode(input, actorTools, this.serverMode);
        if (tools.length > 0) this.upsertTools(tools);
    }

    /** Delete tools from the server and notify the handler.
     */
    public removeToolsByName(toolNames: string[], shouldNotifyToolsChangedHandler = false): string[] {
        const removedTools: string[] = [];
        for (const toolName of toolNames) {
            if (this.removeToolByName(toolName)) {
                removedTools.push(toolName);
            }
        }
        if (removedTools.length > 0) {
            if (shouldNotifyToolsChangedHandler) this.notifyToolsChangedHandler();
        }
        return removedTools;
    }

    /**
     * Upsert new tools.
     * @param tools - Array of tool wrappers to add or update
     * @param shouldNotifyToolsChangedHandler - Whether to notify the tools changed handler
     * @returns Array of added/updated tool wrappers
     */
    public upsertTools(tools: ToolEntry[], shouldNotifyToolsChangedHandler = false) {
        for (const tool of tools) {
            const stored = this.options.paymentProvider ? this.options.paymentProvider.decorateToolSchema(tool) : tool;
            this.tools.set(stored.name, stored);
        }
        if (shouldNotifyToolsChangedHandler) this.notifyToolsChangedHandler();
        return tools;
    }

    private notifyToolsChangedHandler() {
        // If no handler is registered, do nothing
        if (!this.toolsChangedHandler) return;

        // Get the list of tool names
        this.toolsChangedHandler(this.listAllToolNames());
    }

    private removeToolByName(toolName: string): boolean {
        if (this.tools.has(toolName)) {
            this.tools.delete(toolName);
            log.debug('Deleted tool', { toolName });
            return true;
        }
        return false;
    }

    private setupErrorHandling(setupSIGINTHandler = true): void {
        this.server.onerror = (error) => {
            // Client-disconnect noise from the MCP SDK. Messages we see in prod:
            //   - "No connection established" (sendRequest before transport attached)
            //   - "Failed to send response: Error: Not connected" (client vanished mid-flight)
            //   - "Conflict: Only one SSE stream is allowed per session" (duplicate GET on the
            //     streamable-http transport, e.g. tab refresh before the old SSE controller is GC'd)
            //   - "Invalid state: Controller is already closed" (ERR_INVALID_STATE from
            //     WebStandardStreamableHTTPServerTransport.writeSSEEvent when the SSE ReadableStream
            //     controller was closed by client cancellation before a queued event was flushed)
            // All are expected; log as softFail so they don't flood Mezmo error alerts.
            if (/Not connected|No connection established|Only one SSE stream|Controller is already closed/i.test(error.message ?? '')) {
                // Mezmo (logDNA) promotes log entries to errors when the message contains "error".
                // Use errMessage key and sanitize the string to preserve the soft-fail log level.
                const errMessage = (error.message ?? '').replace(/ error:/gi, ' failure:');
                log.softFail('MCP client disconnected before response could be sent', { errMessage });
            } else {
                log.error('[MCP Error]', { error });
            }
        };
        if (setupSIGINTHandler) {
            const handler = async () => {
                await this.server.close();
                process.exit(0);
            };
            process.once('SIGINT', handler);
            this.sigintHandler = handler; // Store the actual handler
        }
    }

    private setupLoggingProxy(): void {
        // Store original sendLoggingMessage
        const originalSendLoggingMessage = this.server.sendLoggingMessage.bind(this.server);

        // Proxy sendLoggingMessage to filter logs
        this.server.sendLoggingMessage = async (params: { level: string; data?: unknown; [key: string]: unknown }) => {
            const messageLevelValue = LOG_LEVEL_MAP[params.level] ?? -1; // Unknown levels get -1, discard
            const currentLevelValue = LOG_LEVEL_MAP[this.currentLogLevel] ?? LOG_LEVEL_MAP.info; // Default to info if invalid
            if (messageLevelValue >= currentLevelValue) {
                await originalSendLoggingMessage(params as Parameters<typeof originalSendLoggingMessage>[0]);
            }
        };
    }

    private setupLoggingHandlers(): void {
        this.server.setRequestHandler(SetLevelRequestSchema, (request) => {
            const { level } = request.params;
            if (LOG_LEVEL_MAP[level] !== undefined) {
                this.currentLogLevel = level;
            }
            // Sending empty result based on MCP spec
            return {};
        });
    }

    private setupResourceHandlers(): void {
        const resourceService = createResourceService({
            paymentProvider: this.options.paymentProvider,
            getMode: () => this.serverMode,
            getAvailableWidgets: () => this.availableWidgets,
        });

        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return await resourceService.listResources();
        });

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return await resourceService.readResource(request.params.uri);
        });

        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
            return await resourceService.listResourceTemplates();
        });
    }

    /**
     * Sets up MCP request handlers for prompts.
     */
    private setupPromptHandlers(): void {
        /**
         * Handles the prompts/list request.
         */
        this.server.setRequestHandler(ListPromptsRequestSchema, () => {
            return { prompts };
        });

        /**
         * Handles the prompts/get request.
         */
        this.server.setRequestHandler(GetPromptRequestSchema, (request) => {
            const { name, arguments: args } = request.params;
            const prompt = prompts.find((p) => p.name === name);
            if (!prompt) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Prompt ${name} not found. Available prompts: ${prompts.map((p) => p.name).join(', ')}`,
                );
            }
            if (!prompt.ajvValidate(args)) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Invalid arguments for prompt ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(prompt.ajvValidate.errors)}`,
                );
            }
            return {
                description: prompt.description,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: prompt.render(args || {}),
                        },
                    },
                ],
            };
        });
    }

    /**
      * Sets up MCP request handlers for long-running tasks.
      */
    private setupTaskHandlers(): void {
        // List tasks
        this.server.setRequestHandler(ListTasksRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { cursor?: string };
            const { cursor } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[ListTasksRequestSchema] Listing tasks', { mcpSessionId });
            const result = await this.taskStore.listTasks(cursor, mcpSessionId);
            return { tasks: result.tasks, nextCursor: result.nextCursor };
        });

        // Get task status
        this.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskRequestSchema] Getting task status', { taskId, mcpSessionId });
            const task = await this.taskStore.getTask(taskId, mcpSessionId);
            if (task) return task;

            // Client error (invalid/unknown taskId) — softFail to avoid polluting error logs.
            log.softFail('[GetTaskRequestSchema] Task not found', { taskId, mcpSessionId, statusCode: 404 });
            throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found`);
        });

        // Get task result payload
        this.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskPayloadRequestSchema] Getting task result', { taskId, mcpSessionId });
            const task = await this.taskStore.getTask(taskId, mcpSessionId);
            if (!task) {
                // Client error (invalid/unknown taskId) — softFail to avoid polluting error logs.
                log.softFail('[GetTaskPayloadRequestSchema] Task not found', { taskId, mcpSessionId, statusCode: 404 });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" not found`,
                );
            }
            if (task.status !== 'completed' && task.status !== 'failed') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" is not completed yet. Current status: ${task.status}`,
                );
            }
            return await this.taskStore.getTaskResult(taskId, mcpSessionId);
        });

        // Cancel task
        this.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[CancelTaskRequestSchema] Cancelling task', { taskId, mcpSessionId });

            const task = await this.taskStore.getTask(taskId, mcpSessionId);
            if (!task) {
                // Client error (invalid/unknown taskId) — softFail to avoid polluting error logs.
                log.softFail('[CancelTaskRequestSchema] Task not found', { taskId, mcpSessionId, statusCode: 404 });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" not found`,
                );
            }
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
                // Client error (cancel on terminal task) — softFail to avoid polluting error logs.
                log.softFail('[CancelTaskRequestSchema] Task already in terminal state', {
                    taskId,
                    mcpSessionId,
                    status: task.status,
                    statusCode: 409,
                });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Cannot cancel task "${taskId}" with status "${task.status}"`,
                );
            }
            await this.taskStore.updateTaskStatus(taskId, 'cancelled', 'Cancelled by client', mcpSessionId);
            const updatedTask = await this.taskStore.getTask(taskId, mcpSessionId);
            log.debug('[CancelTaskRequestSchema] Task cancelled successfully', { taskId, mcpSessionId });
            return updatedTask!;
        });
    }

    private setupToolHandlers(): void {
        /**
         * Handles the request to list tools.
         * @param {object} request - The request object.
         * @returns {object} - The response object containing the tools.
         */
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = Array.from(this.tools.values()).map((tool) => getToolPublicFieldOnly(tool, {
                mode: this.serverMode,
                filterWidgetMeta: true,
            }));
            return { tools };
        });

        /**
         * Handles the request to call a tool.
         * @param {object} request - The request object containing tool name and arguments.
         * @param {object} extra - Extra data given to the request handler, such as sendNotification function.
         * @throws {McpError} - based on the McpServer class code from the typescript MCP SDK
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const params = request.params as ApifyRequestParams & { name: string; arguments?: Record<string, unknown> };
            // eslint-disable-next-line prefer-const
            let { name, arguments: args, _meta: meta } = params;
            const progressToken = meta?.progressToken;
            const metaApifyToken = meta?.apifyToken;
            const apifyToken = (metaApifyToken || this.options.token || process.env.APIFY_TOKEN) as string;
            const userRentedActorIds = meta?.userRentedActorIds;
            // mcpSessionId was injected upstream it is important and required for long running tasks as the store uses it and there is not other way to pass it
            const mcpSessionId = meta?.mcpSessionId;
            if (!mcpSessionId) {
                log.error('MCP Session ID is missing in tool call request. This should never happen.');
                throw new Error('MCP Session ID is required for tool calls');
            }
            const startTime = Date.now();
            let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
            let callDiagnostics: CallDiagnostics = {};
            let shouldTrackTelemetry = true;
            let resolvedToolName = name;
            const failInvalidParams = async (
                message: string,
                details: CallDiagnostics,
                logFields?: Record<string, unknown>,
            ): Promise<never> => {
                toolStatus = TOOL_STATUS.SOFT_FAIL;
                callDiagnostics = details;
                log.softFail(message, {
                    mcpSessionId,
                    failureCategory: details.failure_category,
                    actorName: details.actor_name,
                    validationKeyword: details.validation_keyword,
                    validationPath: details.validation_path,
                    validationMissingProperty: details.validation_missing_property,
                    validationAdditionalProperty: details.validation_additional_property,
                    ...logFields,
                });
                await this.server.sendLoggingMessage({ level: 'error', data: message });
                throw new McpError(ErrorCode.InvalidParams, message);
            };

            // Initialize telemetry with raw tool name — updated below once the tool is resolved.
            // This ensures telemetry is available even for early failures (missing token, tool not found).
            const { telemetryData, userId } = await this.prepareTelemetryData(name, mcpSessionId, apifyToken);

            // actorName/actorId are declared here so they're available in the catch block for telemetry.
            // Set after tool resolution (inside the try block).
            let actorName: string | undefined;
            let actorId: string | undefined;

            try {
                // Validate token
                if (!apifyToken && !this.options.paymentProvider?.allowsUnauthenticated && !this.options.allowUnauthMode) {
                    await failInvalidParams(dedent`
                    Apify API token is required but was not provided.
                    Please set the APIFY_TOKEN environment variable or pass it as a parameter in the request header as Authorization Bearer <token>.
                    You can get your Apify token from https://console.apify.com/account/integrations.
                `, {
                        failure_category: FAILURE_CATEGORY.AUTH,
                    });
                }

                // TODO - if connection is /mcp client will not receive notification on tool change
                // Find tool by name, actor full name, or legacy tool name (e.g. apify-slash-rag-web-browser → apify--rag-web-browser)
                const newName = legacyToolNameToNew(name) ?? name;
                const toolEntry = Array.from(this.tools.values())
                    .find((t) => t.name === newName || getToolFullName(t) === newName);

                if (!toolEntry) {
                    const availableTools = this.listToolNames();
                    await failInvalidParams(dedent`
                    Tool "${name}" was not found.
                    Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
                    Please verify the tool name is correct. You can list all available tools using the tools/list request.
                `, {
                        failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                    });
                }

                const tool = toolEntry!;
                resolvedToolName = getToolFullName(tool);
                // Update telemetry tool name now that we resolved the tool (uses actorFullName for actor tools).
                if (telemetryData) {
                    telemetryData.tool_name = resolvedToolName;
                }

                // Extract actor name/id for telemetry — available even when validation fails later.
                actorName = extractActorName(tool, args as Record<string, unknown>);
                actorId = extractActorId(tool);

                // Always populate actor fields so they're tracked on both success and failure paths.
                callDiagnostics = { ...callDiagnostics, ...buildActorFields(actorName, actorId) };

                if (!args) {
                    await failInvalidParams(dedent`
                    Missing arguments for tool "${name}".
                    Please provide the required arguments for this tool. Check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool to see what parameters are required.
                `, {
                        failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                        ...buildActorFields(actorName, actorId),
                    });
                }

                // Decode dot property names in arguments before validation,
                // since validation expects the original, non-encoded property names.
                args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;

                // Centralize all payment processing: validate, strip payment fields, create client.
                // Must run before AJV validation so toolArgsWithoutPayment doesn't contain provider-specific fields.
                const { toolArgsWithoutPayment: toolArgs, toolArgsRedacted: logSafeArgs, apifyClient, paymentRequiredResult } = prepareToolCallContext({
                    provider: this.options.paymentProvider,
                    tool,
                    args: args as Record<string, unknown>,
                    apifyToken,
                    meta,
                    requestHeaders: extra.requestInfo?.headers,
                });

                log.debug('Validate arguments for tool', { toolName: tool.name, mcpSessionId, input: logSafeArgs });
                if (!tool.ajvValidate(toolArgs)) {
                    const errors = tool.ajvValidate.errors || [];
                    const ajvErrorDetails = extractAjvErrorDetails(errors);
                    const errorMessages = errors.map((e: { message?: string; instancePath?: string }) => `${e.instancePath || 'root'}: ${e.message || 'validation error'}`).join('; ');
                    await failInvalidParams(dedent`
                    Invalid arguments for tool "${tool.name}".
                    Validation errors: ${errorMessages}.
                    Please check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool and ensure all required parameters are provided with correct types and values.
                `, {
                        failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                        ...ajvErrorDetails,
                        ...buildActorFields(actorName, actorId),
                    });
                }

                // Check if tool call is a long-running task and the tool supports that
                // Cast to allowed task mode types ('optional' | 'required') for type-safe includes() check
                const taskSupport = tool.execution?.taskSupport as typeof ALLOWED_TASK_TOOL_EXECUTION_MODES[number];
                if (request.params.task && !ALLOWED_TASK_TOOL_EXECUTION_MODES.includes(taskSupport)) {
                    await failInvalidParams(dedent`
                    Tool "${tool.name}" does not support long running task calls.
                    Please remove the "task" parameter from the tool call request or use a different tool that supports long running tasks.
                `, {
                        failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                        ...buildActorFields(actorName, actorId),
                    });
                }

                // TODO: we should split this huge method into smaller parts as it is slowly getting out of hand
                // Handle long-running task request
                if (request.params.task) {
                    const task = await this.taskStore.createTask(
                        {
                            ttl: request.params.task.ttl,
                        },
                        `call-tool-${name}-${randomUUID()}`,
                        request,
                    );
                    log.debug('Created task for tool execution', { taskId: task.taskId, toolName: tool.name, mcpSessionId });

                    // Execute the tool asynchronously and update task status
                    setImmediate(async () => {
                        await this.executeToolAndUpdateTask({
                            taskId: task.taskId,
                            tool,
                            toolArgs: toolArgs!,
                            logSafeArgs,
                            paymentRequiredResult,
                            apifyClient: apifyClient!,
                            apifyToken,
                            progressToken,
                            extra,
                            mcpSessionId,
                            actorName,
                            actorId,
                            userRentedActorIds,
                        });
                    });

                    // Return the task immediately; execution continues asynchronously
                    shouldTrackTelemetry = false;
                    return { task };
                }

                // Check payment validation (already computed by prepareToolCallContext)
                if (paymentRequiredResult) {
                    toolStatus = TOOL_STATUS.SOFT_FAIL;
                    callDiagnostics = {
                        failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                        failure_http_status: 402,
                        ...buildActorFields(actorName, actorId),
                    };
                    return paymentRequiredResult;
                }

                // Handle internal tool
                if (tool.type === 'internal') {
                    // Only create a progress tracker for call-actor tool
                    const progressTracker = tool.name === 'call-actor'
                        ? createProgressTracker(progressToken, extra.sendNotification)
                        : null;

                    try {
                        log.info('Calling internal tool', { toolName: tool.name, mcpSessionId, input: logSafeArgs });
                        const res = await tool.call({
                            args: toolArgs!,
                            extra,
                            apifyMcpServer: this,
                            mcpServer: this.server,
                            apifyToken,
                            apifyClient: apifyClient!,
                            userRentedActorIds,
                            progressTracker,
                            mcpSessionId,
                        }) as Record<string, unknown>;

                        // Extract diagnostics and strip internal fields from res before returning to client.
                        const diag = extractToolTelemetry(res, actorName, actorId);
                        toolStatus = diag.toolStatus;
                        callDiagnostics = { ...callDiagnostics, ...diag.callDiagnostics };
                        return res;
                    } finally {
                        progressTracker?.stop();
                    }
                }

                if (tool.type === 'actor-mcp') {
                    let client: Client | null = null;
                    try {
                        client = await connectMCPClient(tool.serverUrl, apifyToken, mcpSessionId);
                        if (!client) {
                            const msg = dedent`
                                Failed to connect to MCP server at "${tool.serverUrl}".
                                Please verify the server URL is correct and accessible, and ensure you have a valid Apify token with appropriate permissions.
                            `;
                            log.softFail(msg, { mcpSessionId, failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR });
                            await this.server.sendLoggingMessage({ level: 'error', data: msg });
                            toolStatus = TOOL_STATUS.SOFT_FAIL;
                            callDiagnostics = { ...callDiagnostics, failure_category: FAILURE_CATEGORY.INTERNAL_ERROR };
                            return buildMCPResponse({ texts: [msg], isError: true });
                        }

                        // Only set up notification handlers if progressToken is provided by the client
                        if (progressToken !== undefined && progressToken !== null) {
                            // Set up notification handlers for the client
                            for (const schema of ServerNotificationSchema.options) {
                                const method = schema.shape.method.value;
                                // Forward notifications from the proxy client to the server
                                client.setNotificationHandler(schema, async (notification) => {
                                    log.debug('Sending MCP notification', {
                                        method,
                                        mcpSessionId,
                                        notification,
                                    });
                                    await extra.sendNotification(notification);
                                });
                            }
                        }

                        log.info('Calling Actor-MCP', {
                            toolName: tool.name,
                            actorMcpToolName: tool.originToolName,
                            actorId: tool.actorId,
                            mcpSessionId,
                            input: logSafeArgs,
                        });
                        const res = await client.callTool({
                            name: tool.originToolName,
                            arguments: toolArgs!,
                            _meta: { progressToken },
                        }, CallToolResultSchema, {
                            timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
                        });

                        // TODO: actor-mcp responses are opaque — isError could be a user input problem
                        // (e.g. invalid query) or a genuine server failure. We can't distinguish without
                        // parsing the error text. Defaulting to INTERNAL_ERROR for now; revisit when
                        // actor-mcp gets deeper telemetry treatment.
                        if ('isError' in res && res.isError) {
                            toolStatus = TOOL_STATUS.SOFT_FAIL;
                            callDiagnostics = { failure_category: FAILURE_CATEGORY.INTERNAL_ERROR, ...buildActorFields(actorName, actorId) };
                        }

                        return { ...res };
                    } catch (error) {
                        toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
                        const failureDetail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
                        callDiagnostics = {
                            failure_category: classifyFailureCategory(error),
                            failure_detail: failureDetail,
                            ...buildActorFields(actorName, actorId),
                        };
                        logHttpError(error, `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}'`, {
                            actorId: tool.actorId,
                            toolName: tool.originToolName,
                            failureCategory: callDiagnostics.failure_category,
                        });
                        return buildMCPResponse({
                            texts: [`Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}': ${error instanceof Error ? error.message : String(error)}. The MCP server may be temporarily unavailable.`],
                            isError: true,
                        });
                    } finally {
                        if (client) await client.close();
                    }
                }

                // Handle actor tool
                if (tool.type === 'actor') {
                    const progressTracker = createProgressTracker(progressToken, extra.sendNotification);

                    try {
                        log.info('Calling Actor', { toolName: tool.name, actorName: tool.actorFullName, mcpSessionId, input: logSafeArgs });
                        const executorResult = await this.actorExecutor.executeActorTool({
                            actorFullName: tool.actorFullName,
                            input: toolArgs!,
                            apifyClient: apifyClient!,
                            callOptions: { memory: tool.memoryMbytes },
                            progressTracker,
                            abortSignal: extra.signal,
                            mcpSessionId,
                        });

                        if (!executorResult) {
                            toolStatus = TOOL_STATUS.ABORTED;
                            // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                            // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                            return {};
                        }

                        return executorResult;
                    } finally {
                        if (progressTracker) {
                            progressTracker.stop();
                        }
                    }
                }
                // If we reached here without returning, it means the tool type was not recognized (user error)
                toolStatus = TOOL_STATUS.SOFT_FAIL;
            } catch (error) {
                const httpStatus = getHttpStatusCode(error);

                // Propagate 402 Payment Required as a tool result per x402 MCP transport spec:
                // content[0].text (JSON) + isError: true
                if (httpStatus === HTTP_PAYMENT_REQUIRED) {
                    toolStatus = TOOL_STATUS.SOFT_FAIL;
                    callDiagnostics = {
                        failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                        failure_http_status: 402,
                        ...buildActorFields(actorName, actorId),
                    };
                    return buildPaymentRequiredResponse(error);
                }

                if (isPermissionApprovalError(error)) {
                    toolStatus = TOOL_STATUS.SOFT_FAIL;
                    callDiagnostics = {
                        failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
                        failure_http_status: error.statusCode,
                        ...buildActorFields(actorName, actorId),
                    };
                    logHttpError(error, 'Permission approval required while calling tool', { toolName: name, mcpSessionId });
                    return buildPermissionApprovalResponse(error);
                }

                // Re-throw MCP protocol errors (e.g. from failInvalidParams) so the SDK
                // returns them as JSON-RPC errors. failInvalidParams already set callDiagnostics
                // with the correct semantic category (e.g. AUTH), so we must not overwrite it.
                if (error instanceof McpError) {
                    throw error;
                }

                toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
                const failureDetail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
                callDiagnostics = {
                    // Spread existing diagnostics first (e.g. validation_keyword from failInvalidParams),
                    // then overwrite with freshly computed fields so they take precedence.
                    ...callDiagnostics,
                    failure_category: classifyFailureCategory(error),
                    ...(httpStatus !== undefined ? { failure_http_status: httpStatus } : {}),
                    failure_detail: failureDetail,
                    ...buildActorFields(actorName, actorId),
                };

                logHttpError(error, 'Error occurred while calling tool', {
                    toolName: name,
                    toolStatus,
                    mcpSessionId,
                    failureCategory: callDiagnostics.failure_category,
                    failureHttpStatus: callDiagnostics.failure_http_status,
                    actorName: callDiagnostics.actor_name,
                    validationKeyword: callDiagnostics.validation_keyword,
                    validationPath: callDiagnostics.validation_path,
                    validationMissingProperty: callDiagnostics.validation_missing_property,
                    validationAdditionalProperty: callDiagnostics.validation_additional_property,
                });
                return buildMCPResponse({
                    texts: [getToolCallErrorUserText(name, error)],
                    isError: true,
                    telemetry: { toolStatus },
                });
            } finally {
                if (shouldTrackTelemetry) {
                    this.logToolCallAndTelemetry({
                        toolName: resolvedToolName,
                        mcpSessionId,
                        toolStatus,
                        startTime,
                        telemetryData,
                        userId,
                        callDiagnostics,
                    });
                }
            }

            const availableTools = this.listToolNames();
            const msg = dedent`
                Unknown tool type for "${name}".
                Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
                Please verify the tool name and ensure the tool is properly registered.
            `;
            log.softFail(msg, { mcpSessionId, statusCode: 404 });
            await this.server.sendLoggingMessage({
                level: 'error',
                data: msg,
            });
            throw new McpError(
                ErrorCode.InvalidParams,
                msg,
            );
        });
    }

    /**
     * Logs tool call completion at INFO level and tracks telemetry.
     * Computes duration once so both the log line and telemetry event use the same value.
     */
    private logToolCallAndTelemetry(params: {
        toolName: string;
        mcpSessionId: string | undefined;
        toolStatus: ToolStatus;
        startTime: number;
        taskId?: string;
        telemetryData: ToolCallTelemetryProperties | null;
        userId: string | null;
        callDiagnostics?: CallDiagnostics;
    }): void {
        const durationMs = Date.now() - params.startTime;

        log.info('Tool call completed', {
            toolName: params.toolName,
            mcpSessionId: params.mcpSessionId,
            toolStatus: params.toolStatus,
            durationMs,
            ...(params.taskId !== undefined && { taskId: params.taskId }),
        });

        if (params.telemetryData) {
            const finalizedTelemetryData: ToolCallTelemetryProperties = {
                ...params.telemetryData,
                tool_status: params.toolStatus,
                tool_exec_time_ms: durationMs,
                // Always include actor_name/actor_id; failure-specific fields are only present when callDiagnostics has them.
                ...params.callDiagnostics,
            };
            trackToolCall(params.userId, this.telemetryEnv, finalizedTelemetryData);
        }
    }

    // TODO: this function quite duplicates the main tool call login the CallToolRequestSchema handler, we should refactor
    /**
     * Executes a tool asynchronously for a long-running task and updates task status.
     *
     * @param params - Tool execution parameters
     * @param params.taskId - The task identifier
     * @param params.tool - The tool to execute
     * @param params.args - Tool arguments
     * @param params.apifyToken - Apify API token
     * @param params.progressToken - Progress token for notifications
     * @param params.extra - Extra request handler context
     * @param params.mcpSessionId - MCP session ID for telemetry
     */

    private async executeToolAndUpdateTask(params: {
        taskId: string;
        tool: ToolEntry;
        toolArgs: Record<string, unknown>;
        logSafeArgs: unknown;
        paymentRequiredResult?: Record<string, unknown>;
        apifyClient: ApifyClient;
        apifyToken: string;
        progressToken: string | number | undefined;
        extra: RequestHandlerExtra<Request, Notification>;
        mcpSessionId: string | undefined;
        actorName?: string;
        actorId?: string;
        userRentedActorIds?: string[];
    }): Promise<void> {
        const {
            taskId, tool, toolArgs, logSafeArgs, paymentRequiredResult,
            apifyClient, apifyToken, progressToken, extra, mcpSessionId, actorName, actorId, userRentedActorIds,
        } = params;
        let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
        // Always populate actor fields so they're tracked on both success and failure paths.
        let callDiagnostics: CallDiagnostics = { ...buildActorFields(actorName, actorId) };
        const startTime = Date.now();

        log.debug('[executeToolAndUpdateTask] Starting task execution', {
            taskId,
            toolName: tool.name,
            mcpSessionId,
        });

        // Prepare telemetry before try-catch so it's accessible to both paths.
        // This avoids re-fetching user data in the error handler.
        const { telemetryData, userId } = await this.prepareTelemetryData(getToolFullName(tool), mcpSessionId, apifyToken);

        const finishTaskTracking = (status: ToolStatus, diagnostics?: CallDiagnostics) => {
            this.logToolCallAndTelemetry({
                toolName: tool.name,
                mcpSessionId,
                toolStatus: status,
                startTime,
                taskId,
                telemetryData,
                userId,
                callDiagnostics: diagnostics,
            });
        };

        try {
            // Check if task was already cancelled before we start execution.
            // Critical: if a client cancels the task immediately after creation (race condition),
            // attempting to transition from 'cancelled' (terminal state) to 'working' will fail in the SDK
            // because terminal states cannot transition to other states. We must check before calling updateTaskStatus.
            if (await isTaskCancelled(taskId, mcpSessionId, this.taskStore)) {
                log.debug('[executeToolAndUpdateTask] Task was cancelled before execution started, skipping', {
                    taskId,
                    mcpSessionId,
                });
                finishTaskTracking(TOOL_STATUS.ABORTED, {
                    ...buildActorFields(actorName, actorId),
                });
                return;
            }

            log.debug('[executeToolAndUpdateTask] Updating task status to working', {
                taskId,
                mcpSessionId,
            });
            await this.taskStore.updateTaskStatus(taskId, 'working', undefined, mcpSessionId);

            // Execute the tool and get the result
            let result: Record<string, unknown> = {};

            // Check payment validation (already computed by prepareToolCallContext in the caller)
            if (paymentRequiredResult) {
                toolStatus = TOOL_STATUS.SOFT_FAIL;
                callDiagnostics = {
                    failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                    failure_http_status: 402,
                    ...buildActorFields(actorName, actorId),
                };
                result = paymentRequiredResult;
            }

            // Callback to propagate Actor run statusMessage into the task store.
            // Clients retrieve it via tasks/get and tasks/list polling.
            // TODO: Also send notifications/tasks/status so clients get real-time push updates
            const onStatusMessage = async (message: string) => {
                await this.taskStore.updateTaskStatus(taskId, 'working', message, mcpSessionId);
            };

            // Handle internal tool execution in task mode
            if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === 'internal') {
                const progressTracker = createProgressTracker(progressToken, extra.sendNotification, taskId, onStatusMessage);

                try {
                    log.info('Calling internal tool for task', { taskId, toolName: tool.name, mcpSessionId, input: logSafeArgs });
                    const res = await tool.call({
                        args: toolArgs,
                        extra,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                        apifyToken,
                        apifyClient,
                        userRentedActorIds,
                        progressTracker,
                        mcpSessionId,
                    }) as Record<string, unknown>;

                    const diag = extractToolTelemetry(res, actorName, actorId);
                    toolStatus = diag.toolStatus;
                    callDiagnostics = { ...callDiagnostics, ...diag.callDiagnostics };
                    result = res;
                } finally {
                    if (progressTracker) {
                        progressTracker.stop();
                    }
                }
            }

            // Handle actor tool execution in task mode
            if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === 'actor') {
                const progressTracker = createProgressTracker(progressToken, extra.sendNotification, taskId, onStatusMessage);

                try {
                    log.info('Calling Actor for task', { taskId, toolName: tool.name, actorName: tool.actorFullName, mcpSessionId, input: logSafeArgs });
                    const executorResult = await this.actorExecutor.executeActorTool({
                        actorFullName: tool.actorFullName,
                        input: toolArgs,
                        apifyClient,
                        callOptions: { memory: tool.memoryMbytes },
                        progressTracker,
                        abortSignal: extra.signal,
                        mcpSessionId,
                    });

                    if (!executorResult) {
                        toolStatus = TOOL_STATUS.ABORTED;
                        // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                        // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                        result = {};
                    } else {
                        result = executorResult;
                    }
                } finally {
                    if (progressTracker) {
                        progressTracker.stop();
                    }
                }
            }

            // Check if task was cancelled before storing result
            if (await isTaskCancelled(taskId, mcpSessionId, this.taskStore)) {
                log.debug('[executeToolAndUpdateTask] Task was cancelled, skipping result storage', {
                    taskId,
                    mcpSessionId,
                });
                finishTaskTracking(toolStatus);
                return;
            }

            // Store the result in the task store
            log.debug('[executeToolAndUpdateTask] Storing completed result', {
                taskId,
                mcpSessionId,
            });
            await this.taskStore.storeTaskResult(taskId, 'completed', result, mcpSessionId);
            log.debug('Task completed successfully', { taskId, toolName: tool.name, mcpSessionId });

            finishTaskTracking(toolStatus, callDiagnostics);
        } catch (error) {
            // Handle 402 Payment Required — return structured x402 result so clients can auto-pay
            const httpStatus = getHttpStatusCode(error);
            if (httpStatus === HTTP_PAYMENT_REQUIRED) {
                logHttpError(error, 'Payment required while calling tool (task mode)', { toolName: tool.name });
                await this.taskStore.storeTaskResult(taskId, 'completed', buildPaymentRequiredResponse(error), mcpSessionId);
                finishTaskTracking(TOOL_STATUS.SOFT_FAIL, {
                    failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                    failure_http_status: 402,
                    ...buildActorFields(actorName, actorId),
                });
                return;
            }

            if (isPermissionApprovalError(error)) {
                logHttpError(error, 'Permission approval required while calling tool (task mode)', { toolName: tool.name });
                await this.taskStore.storeTaskResult(taskId, 'completed', buildPermissionApprovalResponse(error), mcpSessionId);
                finishTaskTracking(TOOL_STATUS.SOFT_FAIL, {
                    failure_category: FAILURE_CATEGORY.PERMISSION_APPROVAL_REQUIRED,
                    failure_http_status: error.statusCode,
                    ...buildActorFields(actorName, actorId),
                });
                return;
            }

            toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
            const failureDetail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
            callDiagnostics = {
                failure_category: classifyFailureCategory(error),
                ...(httpStatus !== undefined ? { failure_http_status: httpStatus } : {}),
                failure_detail: failureDetail,
                ...buildActorFields(actorName, actorId),
            };
            // Log level follows the already-classified toolStatus:
            //   SOFT_FAIL (e.g. 402/403 user quota, client-side issues) → softFail
            //   FAILED/ABORTED/other                                    → error
            if (toolStatus === TOOL_STATUS.SOFT_FAIL) {
                // Mezmo promotes on "error" in message/keys — use errMessage key, sanitized.
                const errMessage = (error instanceof Error ? error.message : String(error))
                    .replace(/ error:/gi, ' failure:');
                log.softFail('Tool execution soft-failed for task', {
                    taskId,
                    toolName: tool.name,
                    toolStatus,
                    mcpSessionId,
                    failureCategory: callDiagnostics.failure_category,
                    failureHttpStatus: callDiagnostics.failure_http_status,
                    actorName: callDiagnostics.actor_name,
                    errMessage,
                });
            } else {
                log.error('Error executing tool for task', {
                    taskId,
                    toolName: tool.name,
                    toolStatus,
                    mcpSessionId,
                    failureCategory: callDiagnostics.failure_category,
                    failureHttpStatus: callDiagnostics.failure_http_status,
                    actorName: callDiagnostics.actor_name,
                    error,
                });
            }
            const userText = getToolCallErrorUserText(tool.name, error);

            // Check if task was cancelled before storing result
            // TODO: In future, we should actually stop execution via AbortController,
            // but coordinating cancellation across distributed nodes would be complex
            if (await isTaskCancelled(taskId, mcpSessionId, this.taskStore)) {
                log.debug('[executeToolAndUpdateTask] Task was cancelled, skipping result storage', {
                    taskId,
                    mcpSessionId,
                });
                finishTaskTracking(toolStatus, callDiagnostics);
                return;
            }

            log.debug('[executeToolAndUpdateTask] Storing failed result', {
                taskId,
                mcpSessionId,
            });
            await this.taskStore.storeTaskResult(taskId, 'failed', {
                content: [{
                    type: 'text' as const,
                    text: userText,
                }],
                isError: true,
                internalToolStatus: toolStatus,
            }, mcpSessionId);

            finishTaskTracking(toolStatus, callDiagnostics);
        }
    }

    /*
     * Creates telemetry data for a tool call.
    */
    private async prepareTelemetryData(
        toolName: string, mcpSessionId: string | undefined, apifyToken: string,
    ): Promise<{ telemetryData: ToolCallTelemetryProperties | null; userId: string | null }> {
        if (!this.telemetryEnabled) {
            return { telemetryData: null, userId: null };
        }

        // Get userId from cache or fetch from API
        let userId: string | null = null;
        if (apifyToken) {
            const apifyClient = new ApifyClient({ token: apifyToken });
            ({ userId } = await getUserInfoCached(apifyToken, apifyClient));
            log.debug('Telemetry: fetched userId', { userId, mcpSessionId });
        }
        const capabilities = this.options.initializeRequestData?.params?.capabilities;
        const params = this.options.initializeRequestData?.params as InitializeRequest['params'];
        const telemetryData: ToolCallTelemetryProperties = {
            app: 'mcp',
            app_version: getPackageVersion() || '',
            mcp_client_name: params?.clientInfo?.name || '',
            mcp_client_version: params?.clientInfo?.version || '',
            mcp_protocol_version: params?.protocolVersion || '',
            mcp_client_capabilities: capabilities || null,
            mcp_session_id: mcpSessionId || '',
            transport_type: this.options.transportType || '',
            tool_name: toolName,
            tool_status: TOOL_STATUS.SUCCEEDED, // Will be updated in finally
            tool_exec_time_ms: 0, // Will be calculated in finally
        };

        return { telemetryData, userId };
    }

    /**
     * Resolves widgets and determines which ones are ready to be served.
     */
    private async resolveWidgets(): Promise<void> {
        if (this.serverMode !== ServerMode.APPS) {
            return;
        }

        try {
            const { fileURLToPath } = await import('node:url');
            const path = await import('node:path');

            const filename = fileURLToPath(import.meta.url);
            const dirName = path.dirname(filename);

            const resolved = await resolveAvailableWidgets(dirName);
            this.availableWidgets = resolved;

            const readyWidgets: string[] = [];
            const missingWidgets: string[] = [];

            for (const [uri, widget] of resolved.entries()) {
                if (widget.exists) {
                    readyWidgets.push(widget.name);
                } else {
                    missingWidgets.push(widget.name);
                    log.softFail(`Widget file not found: ${widget.jsPath} (widget: ${uri})`);
                }
            }

            if (readyWidgets.length > 0) {
                log.debug('Ready widgets', { widgets: readyWidgets });
            }

            if (missingWidgets.length > 0) {
                log.softFail('Some widgets are not ready', {
                    widgets: missingWidgets,
                    note: 'These widgets will not be available. Ensure web/dist files are built and included in deployment.',
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.softFail(`Failed to resolve widgets: ${errorMessage}`);
            // Continue without widgets
        }
    }

    async connect(transport: Transport): Promise<void> {
        await this.resolveWidgets();
        await this.server.connect(transport);
    }

    async close(): Promise<void> {
        // Remove SIGINT handler
        if (this.sigintHandler) {
            process.removeListener('SIGINT', this.sigintHandler);
            this.sigintHandler = undefined;
        }
        // Clear all tools and their compiled schemas
        for (const tool of this.tools.values()) {
            if (tool.ajvValidate && typeof tool.ajvValidate === 'function') {
                (tool as { ajvValidate: ValidateFunction<unknown> | null }).ajvValidate = null;
            }
        }
        this.tools.clear();
        // Unregister tools changed handler
        if (this.toolsChangedHandler) {
            this.unregisterToolsChangedHandler();
        }
        // Close server (which should also remove its event handlers)
        await this.server.close();
    }
}
