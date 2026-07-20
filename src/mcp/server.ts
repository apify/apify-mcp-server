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
import type {
    InitializeRequest,
    InitializeResult,
    Notification,
    Request,
    Task,
    TaskStatusNotification,
} from '@modelcontextprotocol/sdk/types.js';
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
    RELATED_TASK_META_KEY,
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
    DEFAULT_TELEMETRY_ENABLED,
    DEFAULT_TELEMETRY_ENV,
    FAILURE_CATEGORY,
    HELPER_TOOLS,
    TOOL_STATUS,
} from '../const.js';
import { prepareToolCallContext } from '../payments/helpers.js';
import { prompts } from '../prompts/index.js';
import { createResourceService } from '../resources/resource_service.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';
import { getServerInfo } from '../server_card.js';
import { buildReportedProblemProperties, getTelemetryEnv, trackReportedProblem, trackToolCall } from '../telemetry.js';
import { decodeDotPropertyNames } from '../tools/actor_input_schema.js';
import { legacyToolNameToNew } from '../tools/actor_tool_naming.js';
import { actorExecutor } from '../tools/actors/actor_executor.js';
import { checkPaymentProviderStandbyConflict } from '../tools/actors/call_actor.js';
import { appendReportProblemNudge } from '../tools/dev/report_problem.js';
import { getActorsAsTools } from '../tools/index.js';
import type { ActorsAsToolsResult } from '../tools/index.js';
import type {
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
import { SERVER_MODE, TOOL_TYPE } from '../types.js';
import { remoteMcpFailureDetail } from '../utils/apify_errors.js';
import { isMcpClientFaultMessage, logHttpError, sanitizeMezmoMessage } from '../utils/logging.js';
import { computeToolResponseBytes, respondErrorNoTelemetry, respondOk } from '../utils/mcp.js';
import { isReportProblemBlockedForClient } from '../utils/mcp_clients.js';
import type { buildPaymentRequiredResponse } from '../utils/payment_errors.js';
import { createProgressTracker } from '../utils/progress.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { parseServerMode, resolveServerMode } from '../utils/server_mode.js';
import {
    applyToolTelemetry,
    classifyFailureCategory,
    deriveResourceIds,
    extractAjvErrorDetails,
    getToolStatusFromError,
} from '../utils/tool_status.js';
import {
    buildActorFields,
    extractActorId,
    extractActorName,
    getToolFullName,
    getToolPublicFieldOnly,
} from '../utils/tools.js';
import { getActors, getToolsForServerMode, toolNamesToInput } from '../utils/tools_loader.js';
import { getUserInfoCached } from '../utils/userid_cache.js';
import { getPackageVersion } from '../utils/version.js';
import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, LOG_LEVEL_MAP } from './const.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from './tool_call_error_mapper.js';
import {
    createTaskCancellationWatcher,
    isTaskCancelled,
    isTaskNotFoundError,
    parseInputParamsFromUrl,
    storeTaskResultOrSkipIfExpired,
} from './utils.js';

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

/** Send notifications/tasks/status for taskId. Routes via session transport (no relatedRequestId).
 *  Swallows errors — notifications are advisory. */
export async function emitTaskStatusNotification(
    taskId: string,
    mcpSessionId: string | undefined,
    taskStore: TaskStore,
    server: Server,
): Promise<void> {
    try {
        const task = await taskStore.getTask(taskId, mcpSessionId);
        if (!task) return;
        // Per spec: notifications/tasks/status MUST NOT carry _meta.related-task (task ID is in params).
        // Called without options so the notification routes through the session transport,
        // not the request-scoped stream (which closes once the initial { task } response is flushed).
        await server.notification({
            method: 'notifications/tasks/status',
            params: {
                taskId: task.taskId,
                status: task.status,
                createdAt: task.createdAt,
                lastUpdatedAt: task.lastUpdatedAt,
                ttl: task.ttl,
                ...(task.statusMessage != null && { statusMessage: task.statusMessage }),
                ...(task.pollInterval != null && { pollInterval: task.pollInterval }),
            },
        } as TaskStatusNotification);
    } catch {
        // Silent fail — notifications are advisory
    }
}

/**
 * Shared diagnostics for a pre-flight failure (standby-provider conflict or missing/invalid payment
 * signature) — a call outcome already known before any Actor runs. Standby rejection wins over the
 * generic payment-required failure so the agent gets the precise reason instead of a generic 402.
 * Pure: callers own their own post-handling (return the result directly, or store + notify + synthesize
 * a terminal task) — call this only once `standbyRejection ?? paymentRequiredResult` is already truthy.
 */
function buildPreflightFailureOutcome(
    standbyRejection: Record<string, unknown> | null,
    paymentRequiredResult: ReturnType<typeof buildPaymentRequiredResponse> | undefined,
    actorName: string | undefined,
    actorId: string | undefined,
): {
    toolStatus: ToolStatus;
    callDiagnostics: CallDiagnostics;
    result: Record<string, unknown> | ReturnType<typeof buildPaymentRequiredResponse>;
} {
    return {
        toolStatus: TOOL_STATUS.SOFT_FAIL,
        callDiagnostics: {
            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
            ...(standbyRejection ? {} : { failure_http_status: 402 }),
            ...buildActorFields(actorName, actorId),
        },
        result: (standbyRejection ?? paymentRequiredResult)!,
    };
}

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
    public serverMode: SERVER_MODE;
    /**
     * Raw option captured from `options.serverMode` (or the legacy `uiMode`). Re-resolved
     * inside the initialize handler when set to `'auto'`; explicit `'default'`/`'apps'`
     * values bypass auto-detect.
     */
    private readonly serverModeOption: ServerModeOption;
    /** True once the server mode is final: at construction for explicit `default`/`apps`, or after
     *  the initialize handler resolves `'auto'`. Composing before this in `'auto'` mode would use
     *  the preliminary DEFAULT mode and produce the wrong (non-widget) tool variants, so composition
     *  waits for it. Distinct from {@link clientKnown}, which only withholds client-gated tools. */
    private serverModeResolved: boolean;
    /**
     * Tool sources queued until composition is possible. Enqueued when the mode is not yet resolved
     * (`'auto'` before initialize), and re-composed by the initialize flush — which is also when the
     * client becomes known, so any client-gated tools withheld by an eager compose are added then.
     * We capture the exact actor-tool slice fetched for each request so the flush composes every
     * entry against *its own* actor list rather than the accumulated union across unrelated requests.
     */
    private pendingToolsUntilClientKnown: { input: Input; actorTools: ToolEntry[] }[] = [];

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
        this.serverModeOption =
            rawServerMode !== undefined ? parseServerMode(rawServerMode) : parseServerMode(legacyUiMode);
        // Preliminary resolution — re-resolved inside the initialize handler once
        // client capabilities are known (only for 'auto').
        this.serverMode = resolveServerMode(this.serverModeOption, false);
        this.serverModeResolved = this.serverModeOption !== 'auto';

        const { setupSigintHandler = true } = options;
        this.server = new Server(getServerInfo(), {
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
                resources: {},
                prompts: {},
                logging: {},
            },
            instructions: getServerInstructions(),
        });
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
        const sdkInitHandler = (
            this.server as unknown as {
                _oninitialize(req: InitializeRequest): Promise<InitializeResult>;
            }
        )._oninitialize.bind(this.server);

        this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
            this.clientSupportsUi = isUiSupportedByClient(request);

            if (this.serverModeOption === 'auto') {
                const resolved = resolveServerMode('auto', this.clientSupportsUi);
                if (resolved !== this.serverMode) {
                    this.serverMode = resolved;
                }
                this.serverModeResolved = true;
            }

            // Setting this makes `clientKnown` true, so the queued compose below (and any later
            // load) resolves the tool set for this client and applies the per-client blocklist.
            (this.options as Record<string, unknown>).initializeRequestData = request;

            log.info('Resolved server mode for client capabilities', {
                serverMode: this.serverMode,
                serverModeOption: this.serverModeOption,
                clientSupportsUi: this.clientSupportsUi,
                capabilities: request?.params?.capabilities,
            });

            this.composePendingToolsForClient();

            await this.resolveWidgets();

            const result = await sdkInitHandler(request);
            // Tools are final here (composePendingToolsForClient ran above, applying the per-client
            // blocklist), so tool presence is the ground truth for whether to advertise
            // report-problem in the instructions.
            result.instructions = getServerInstructions(this.serverMode, this.tools.has(HELPER_TOOLS.PROBLEM_REPORT));
            return result;
        });
    }

    /** True once the connecting client is known (set in the initialize handler, or hydrated by a
     *  recovery path). Only client-gated tools wait for this so the per-client blocklist can be
     *  applied; client-agnostic tools compose regardless. */
    private get clientKnown(): boolean {
        return this.options.initializeRequestData != null;
    }

    /**
     * Compose the tool list for the current connection: resolve mode-specific tools, then drop
     * report-problem unless it is currently servable (see {@link isReportProblemServable}).
     * report-problem is a default-injected tool (via tools_loader) rather than a category member,
     * gated here by servability. Every other tool composes eagerly, so a recovery/rehydration load
     * without an initialize still restores them. report-problem is withheld until the client is known
     * and re-added by the initialize flush. Used by every input-driven load path and the flush.
     * (loadActorsAsTools upserts actor tools directly; actor tools are never gated, so they need no
     * filtering.)
     */
    private composeToolsForClient(input: Input, actorTools: ToolEntry[]): ToolEntry[] {
        const tools = getToolsForServerMode(input, actorTools, this.serverMode);
        if (this.isReportProblemServable()) return tools;
        return tools.filter((tool) => tool.name !== HELPER_TOOLS.PROBLEM_REPORT);
    }

    /**
     * Whether report-problem may be served on this connection right now:
     * - Its only function is forwarding submissions via telemetry, so it is never servable when
     *   telemetry is disabled (it would just fake an acknowledgement into the void).
     * - It cannot be judged until the connecting client is known, so it is withheld until then;
     *   the initialize flush re-composes and adds it if the client allows.
     * Every other tool is unconditionally servable, so recovery loads compose them eagerly and they
     * survive a load that never sees an initialize.
     */
    private isReportProblemServable(): boolean {
        return (
            !!this.telemetryEnabled &&
            this.clientKnown &&
            !isReportProblemBlockedForClient(this.options.initializeRequestData)
        );
    }

    /**
     * Append the report-problem nudge to a failed tool result. Thin wrapper over
     * {@link appendReportProblemNudge} that fills in whether report-problem is served on this
     * connection; suppression by category/402 is handled inside the helper.
     */
    private withReportProblemNudge<T>(
        result: T,
        failingToolName: string | undefined,
        failureCategory?: string,
        failureHttpStatus?: number,
    ): T {
        return appendReportProblemNudge(result, {
            failingToolName,
            available: this.tools.has(HELPER_TOOLS.PROBLEM_REPORT),
            failureCategory,
            failureHttpStatus,
        });
    }

    private composePendingToolsForClient(): void {
        if (this.pendingToolsUntilClientKnown.length === 0) return;

        const tools = this.pendingToolsUntilClientKnown.flatMap(({ input, actorTools }) =>
            this.composeToolsForClient(input, actorTools),
        );

        this.pendingToolsUntilClientKnown = [];

        // Notify after the flush so shared-state handlers (e.g. Redis recovery) see the final tool
        // set. Load paths already upserted the client-agnostic tools pre-init; re-upserting is
        // idempotent, and this pass adds the client-gated tools (e.g. report-problem) now that the
        // client is known, reconciling shared state to the complete set.
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
            .filter((tool) => tool.type === TOOL_TYPE.INTERNAL)
            .map((tool) => tool.name);
    }

    /**
     * Returns the list of all currently loaded Actor tool IDs.
     * @returns {string[]} - Array of loaded Actor tool IDs (e.g., 'apify/rag-web-browser')
     */
    public listActorToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === TOOL_TYPE.ACTOR)
            .map((tool) => tool.actorFullName);
    }

    /**
     * Returns a list of Actor IDs that are registered as MCP servers.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    private listActorMcpServerToolIds(): string[] {
        const ids = Array.from(this.tools.values())
            .filter((tool: ToolEntry) => tool.type === TOOL_TYPE.ACTOR_MCP)
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
     * Buffer-or-compose gate shared by the actor-tools loaders. If the server mode isn't resolved
     * yet ('auto' before initialize), queue the whole source for `composePendingToolsForClient` and
     * (if non-empty) upsert the mode-agnostic actor tools immediately with the given `shouldNotify`.
     * Once the mode is resolved, compose the client-specific set via `composeToolsForClient` (which
     * withholds report-problem until the client is known) and upsert it; if the client still isn't
     * known, queue the source so the initialize flush re-composes and adds the client-gated tools.
     *
     * Callers pass different `shouldNotify` values: `loadToolsByName` forwards `actorTools.length > 0`
     * (notify only when actor tools were fetched), while `loadToolsFromUrl` and `loadToolsFromInput`
     * pass `false` and defer to the post-initialize reconcile. See `composePendingToolsForClient`.
     */
    private registerFetchedActorTools(input: Input, actorTools: ToolEntry[], shouldNotify: boolean): void {
        if (!this.serverModeResolved) {
            this.pendingToolsUntilClientKnown.push({ input, actorTools });
            if (actorTools.length > 0) this.upsertTools(actorTools, shouldNotify);
            return;
        }
        const tools = this.composeToolsForClient(input, actorTools);
        if (tools.length > 0) this.upsertTools(tools, shouldNotify);
        if (!this.clientKnown) this.pendingToolsUntilClientKnown.push({ input, actorTools });
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
        const actorTools = await getActors(restoreInput, apifyClient, {
            actorStore: this.actorStore,
            paymentProvider: this.options.paymentProvider,
        });

        this.registerFetchedActorTools(restoreInput, actorTools, actorTools.length > 0);
    }

    /**
     * Load Actors as tools, upsert successes into the server, and return both the tool
     * entries and any per-name {@link ActorLoadError}s. Bulk callers read `tools`; the
     * `add-actor` tool reads `errors[0]` to forward a precise reason to the agent
     * (not-found / load-failed / standby-payment-not-supported).
     */
    public async loadActorsAsTools(actorIdsOrNames: string[], apifyClient: ApifyClient): Promise<ActorsAsToolsResult> {
        const result = await getActorsAsTools(actorIdsOrNames, apifyClient, {
            actorStore: this.actorStore,
            paymentProvider: this.options.paymentProvider,
        });
        if (result.tools.length > 0) {
            this.upsertTools(result.tools, true);
        }
        return result;
    }

    /** Load tools from URL params. Used by SSE and HTTP entry points. */
    public async loadToolsFromUrl(url: string, apifyClient: ApifyClient) {
        const input = parseInputParamsFromUrl(url);
        const actorTools = await getActors(input, apifyClient, {
            actorStore: this.actorStore,
            paymentProvider: this.options.paymentProvider,
        });

        log.debug('Loading tools from query parameters');
        this.registerFetchedActorTools(input, actorTools, false);
    }

    /**
     * Two-phase: getActors (async, client-agnostic Apify fetch) then composeToolsForClient
     * (sync compose + servability filter). If the mode isn't resolved yet ('auto' before initialize)
     * the whole source is queued for the flush. Otherwise tools compose immediately; client-gated
     * tools are withheld until the client is known, and the source is queued so the flush adds them.
     *
     * Don't move the getActors await into the initialize handler — clients time out
     * waiting for InitializeResult. The queue buffers already-fetched data, not network
     * work. See #721.
     */
    public async loadToolsFromInput(input: Input, apifyClient: ApifyClient): Promise<void> {
        const actorTools = await getActors(input, apifyClient, {
            actorStore: this.actorStore,
            paymentProvider: this.options.paymentProvider,
        });
        this.registerFetchedActorTools(input, actorTools, false);
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
        // Client gating (e.g. hiding report-problem from Anthropic surfaces) is applied earlier, in
        // composeToolsForClient — the single compose choke point where the client is known. Do not
        // filter here: this is a low-level commit point reached before the client is known too.
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
            // Known client faults are expected noise, not server bugs — softFail so they don't
            // flood Mezmo error alerts. The fault patterns live in utils/logging.ts.
            const message = error.message ?? '';
            if (isMcpClientFaultMessage(message)) {
                // Sanitize the errMessage value to preserve the soft-fail level (Mezmo promotes
                // entries whose message contains "error").
                log.softFail('MCP client fault, request could not be handled', {
                    errMessage: sanitizeMezmoMessage(message),
                });
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

    /**
     * Token sources in order: per-request `_meta.apifyToken` (stdio inline) > server-instance
     * option (set by the transport from `Authorization` header or stdio env). No env fallback:
     * dev_server / production must extract the token from request headers so payment
     * mode (no token) behaves identically to production.
     */
    private resolveApifyToken(meta?: ApifyRequestParams['_meta']): string | undefined {
        return meta?.apifyToken || this.options.token;
    }

    /**
     * Token-scoped client for resources/read (the API proxy needs auth). Deliberately token-only:
     * unlike the CallTool path it does NOT forward provider/payment headers, so a payment-only
     * session (x402/Skyfire, no Apify token) has no client and every read fails by design.
     */
    private resolveApifyClient(params: ApifyRequestParams): ApifyClient | undefined {
        const token = this.resolveApifyToken(params._meta);
        return token ? new ApifyClient({ token }) : undefined;
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
            return await resourceService.readResource(
                request.params.uri,
                this.resolveApifyClient(request.params as ApifyRequestParams),
            );
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
     * Fetches a task by ID, softFail-logging and throwing a client-facing McpError if it doesn't exist.
     */
    private async getTaskOrThrow(taskId: string, mcpSessionId: string | undefined, logTag: string): Promise<Task> {
        const task = await this.taskStore.getTask(taskId, mcpSessionId);
        if (!task) {
            // Client error (invalid/unknown taskId) — softFail to avoid polluting error logs.
            log.softFail(`[${logTag}] Task not found`, { taskId, mcpSessionId, statusCode: 404 });
            throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found`);
        }
        return task;
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
            return await this.getTaskOrThrow(taskId, mcpSessionId, 'GetTaskRequestSchema');
        });

        // Get task result payload
        this.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskPayloadRequestSchema] Getting task result', { taskId, mcpSessionId });
            const task = await this.getTaskOrThrow(taskId, mcpSessionId, 'GetTaskPayloadRequestSchema');
            if (task.status !== 'completed' && task.status !== 'failed') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" is not completed yet. Current status: ${task.status}`,
                );
            }
            const result = await this.taskStore.getTaskResult(taskId, mcpSessionId);
            // taskId is not in the result body — _meta.related-task lets clients correlate them
            return {
                ...result,
                _meta: {
                    ...(result._meta as Record<string, unknown>),
                    [RELATED_TASK_META_KEY]: { taskId },
                },
            };
        });

        // Cancel task
        this.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[CancelTaskRequestSchema] Cancelling task', { taskId, mcpSessionId });

            const task = await this.getTaskOrThrow(taskId, mcpSessionId, 'CancelTaskRequestSchema');
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
            await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);
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
            const tools = Array.from(this.tools.values()).map((tool) =>
                getToolPublicFieldOnly(tool, {
                    mode: this.serverMode,
                    filterWidgetMeta: true,
                }),
            );
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
            const apifyToken = this.resolveApifyToken(meta) as string;
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
            // Set only on the pre-flight task path — the one task-mode flow whose telemetry rides
            // this handler's `finally` — so its `Tool call completed` log line keeps the taskId the
            // async path logs via finishTaskTracking.
            let preflightTaskId: string | undefined;
            // Captured by `captureResult` so the `finally` block can measure response size for telemetry.
            let toolResult: unknown = null;
            const captureResult = <T>(r: T): T => {
                // On a failed result, nudge the agent to report the blocker via report-problem at the
                // moment it decides what to do next. Gated on the tool actually being served (see
                // isReportProblemServable), so clients where it is blocklisted or telemetry is off never see it.
                const augmented = this.withReportProblemNudge(
                    r,
                    resolvedToolName,
                    callDiagnostics.failure_category,
                    callDiagnostics.failure_http_status,
                );
                toolResult = augmented;
                return augmented;
            };
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
                if (
                    !apifyToken &&
                    !this.options.paymentProvider?.allowsUnauthenticated &&
                    !this.options.allowUnauthMode
                ) {
                    await failInvalidParams(
                        dedent`
                    Apify API token is required but was not provided.
                    Please set the APIFY_TOKEN environment variable or pass it as a parameter in the request header as Authorization Bearer <token>.
                    You can get your Apify token from https://console.apify.com/account/integrations.
                `,
                        {
                            failure_category: FAILURE_CATEGORY.AUTH,
                        },
                    );
                }

                // TODO - if connection is /mcp client will not receive notification on tool change
                // Find tool by name, actor full name, or legacy tool name (e.g. apify-slash-rag-web-browser → apify--rag-web-browser)
                const newName = legacyToolNameToNew(name) ?? name;
                const toolEntry = Array.from(this.tools.values()).find(
                    (t) => t.name === newName || getToolFullName(t) === newName,
                );

                if (!toolEntry) {
                    const availableTools = this.listToolNames();
                    await failInvalidParams(
                        dedent`
                    Tool "${name}" was not found.
                    Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
                    Please verify the tool name is correct. You can list all available tools using the tools/list request.
                `,
                        {
                            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                        },
                    );
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
                    await failInvalidParams(
                        dedent`
                    Missing arguments for tool "${name}".
                    Please provide the required arguments for this tool. Check the tool's input schema using ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool to see what parameters are required.
                `,
                        {
                            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                            ...buildActorFields(actorName, actorId),
                        },
                    );
                }

                // Decode dot property names in arguments before validation,
                // since validation expects the original, non-encoded property names.
                args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;

                // Centralize all payment processing: validate, strip payment fields, create client.
                // Must run before AJV validation so toolArgsWithoutPayment doesn't contain provider-specific fields.
                const {
                    toolArgsWithoutPayment: toolArgs,
                    toolArgsRedacted: logSafeArgs,
                    apifyClient,
                    paymentRequiredResult,
                } = prepareToolCallContext({
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
                    const errorMessages = errors
                        .map(
                            (e: { message?: string; instancePath?: string }) =>
                                `${e.instancePath || 'root'}: ${e.message || 'validation error'}`,
                        )
                        .join('; ');
                    await failInvalidParams(
                        dedent`
                    Invalid arguments for tool "${tool.name}".
                    Validation errors: ${errorMessages}.
                    Please check the tool's input schema using ${HELPER_TOOLS.ACTOR_GET_DETAILS} tool and ensure all required parameters are provided with correct types and values.
                `,
                        {
                            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                            ...ajvErrorDetails,
                            ...buildActorFields(actorName, actorId),
                        },
                    );
                }

                // Check if tool call is a long-running task and the tool supports that
                // Cast to allowed task mode types ('optional' | 'required') for type-safe includes() check
                const taskSupport = tool.execution?.taskSupport as (typeof ALLOWED_TASK_TOOL_EXECUTION_MODES)[number];
                if (request.params.task && !ALLOWED_TASK_TOOL_EXECUTION_MODES.includes(taskSupport)) {
                    await failInvalidParams(
                        dedent`
                    Tool "${tool.name}" does not support long running task calls.
                    Please remove the "task" parameter from the tool call request or use a different tool that supports long running tasks.
                `,
                        {
                            failure_category: FAILURE_CATEGORY.INVALID_INPUT,
                            ...buildActorFields(actorName, actorId),
                        },
                    );
                }

                // Standby / MCP-server Actors are never payable via a third-party provider —
                // compute the rejection here so both the sync short-circuit and the task path
                // can use it. In task-mode we still create the task and store this rejection
                // as its result (instead of a generic 402), so the agent gets the precise reason
                // when fetching the task result. Task-mode `call-actor` declares
                // `taskSupport: 'optional'`, so without this both paths would 402 by default.
                const { paymentProvider } = this.options;
                const isCallActorTool =
                    tool.name === HELPER_TOOLS.ACTOR_CALL || tool.name === HELPER_TOOLS.ACTOR_CALL_WIDGET;
                const actorArg = (toolArgs as { actor?: unknown } | undefined)?.actor;

                const standbyRejection =
                    paymentProvider && isCallActorTool && typeof actorArg === 'string' && actorArg.length > 0
                        ? await checkPaymentProviderStandbyConflict({
                              actorName: actorArg,
                              paymentProvider,
                              apifyToken,
                              mcpSessionId,
                          })
                        : null;

                // TODO: we should split this huge method into smaller parts as it is slowly getting out of hand
                // Handle long-running task request
                if (request.params.task) {
                    const task = await this.taskStore.createTask(
                        {
                            ttl: request.params.task.ttl,
                        },
                        `call-tool-${name}-${randomUUID()}`,
                        request,
                        mcpSessionId,
                    );
                    log.debug('Created task for tool execution', {
                        taskId: task.taskId,
                        toolName: tool.name,
                        mcpSessionId,
                    });

                    // Pre-flight failure is already known — the outcome needs no work. Resolve the
                    // task synchronously: store the failure as the terminal `completed` result and emit
                    // exactly one `completed` status notification (no `updateTaskStatus('working')`, so no
                    // `working` notification). Standby rejection wins over the generic payment-required
                    // short-circuit, matching the sync path's precedence. Telemetry rides the handler's
                    // outer `finally` (shouldTrackTelemetry stays true), firing once with the sync-path
                    // properties plus the taskId on the log line.
                    const preflightResult = standbyRejection ?? paymentRequiredResult;
                    if (preflightResult) {
                        const outcome = buildPreflightFailureOutcome(
                            standbyRejection,
                            paymentRequiredResult,
                            actorName,
                            actorId,
                        );
                        toolStatus = outcome.toolStatus;
                        callDiagnostics = outcome.callDiagnostics;
                        preflightTaskId = task.taskId;
                        try {
                            await storeTaskResultOrSkipIfExpired(
                                this.taskStore,
                                tool.name,
                                task.taskId,
                                'completed',
                                outcome.result,
                                mcpSessionId,
                            );
                        } catch (error) {
                            // A store failure (not expiry) would otherwise fall through to the generic
                            // catch and return a task-less tool result the client rejects as a
                            // CreateTaskResult parse error; surface it as a protocol error instead.
                            // The pre-flight outcome left toolStatus=SOFT_FAIL, but a genuine store
                            // outage is a hard failure — correct it before throwing so the handler
                            // `finally` logs FAILED/INTERNAL_ERROR (the outer McpError re-throw preserves
                            // these), not the stale pre-flight SOFT_FAIL.
                            toolStatus = TOOL_STATUS.FAILED;
                            callDiagnostics = {
                                failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
                                ...buildActorFields(actorName, actorId),
                            };
                            throw new McpError(
                                ErrorCode.InternalError,
                                `Failed to store the pre-flight result for task "${task.taskId}": ${
                                    error instanceof Error ? error.message : String(error)
                                }`,
                            );
                        }
                        // Defer so the client sees the CreateTaskResult (and learns the taskId) before
                        // the terminal status notification — the async path's post-response ordering.
                        // emitTaskStatusNotification never throws and no-ops if the task expired.
                        setImmediate(() => {
                            void emitTaskStatusNotification(task.taskId, mcpSessionId, this.taskStore, this.server);
                        });
                        captureResult(outcome.result);
                        // createTask returned status `working`; synthesize the terminal status instead of
                        // re-fetching — if the task expired before the result store (the one case
                        // storeTaskResultOrSkipIfExpired tolerates), a re-fetch would come back empty and a
                        // `working` fallback would contradict the tasks/get 404 the client sees next.
                        return { task: { ...task, status: 'completed' as const } };
                    }

                    // Execute the tool asynchronously and update task status
                    setImmediate(() => {
                        this.executeToolAndUpdateTask({
                            taskId: task.taskId,
                            tool,
                            toolArgs: toolArgs!,
                            logSafeArgs,
                            apifyClient: apifyClient!,
                            apifyToken,
                            progressToken,
                            extra,
                            mcpSessionId,
                            actorName,
                            actorId,
                        }).catch((error) =>
                            // Benign task-expiry is handled in-method (see the catch block and
                            // storeTaskResultOrSkipIfExpired); anything reaching here is genuinely unexpected.
                            log.error('executeToolAndUpdateTask failed unexpectedly', { taskId: task.taskId, error }),
                        );
                    });

                    // Return the task immediately; execution continues asynchronously
                    shouldTrackTelemetry = false;
                    return { task };
                }

                // Sync path: short-circuit on either pre-flight failure. buildPreflightFailureOutcome
                // encodes the precedence — standby rejection wins over the generic payment-required
                // 402, so the agent gets the precise reason.
                if (standbyRejection || paymentRequiredResult) {
                    const outcome = buildPreflightFailureOutcome(
                        standbyRejection,
                        paymentRequiredResult,
                        actorName,
                        actorId,
                    );
                    toolStatus = outcome.toolStatus;
                    callDiagnostics = outcome.callDiagnostics;
                    return captureResult(outcome.result);
                }

                // Handle internal tool
                if (tool.type === TOOL_TYPE.INTERNAL) {
                    // Tools that may emit notifications/progress during a sync wait must be opted in here.
                    // call-actor: emits during start+waitForFinish. get-actor-run: emits when waitSecs > 0.
                    const progressTrackerOptIn =
                        tool.name === HELPER_TOOLS.ACTOR_CALL || tool.name === HELPER_TOOLS.ACTOR_RUNS_GET;
                    const progressTracker = progressTrackerOptIn
                        ? createProgressTracker(progressToken, extra.sendNotification)
                        : null;

                    try {
                        log.info('Calling internal tool', { toolName: tool.name, mcpSessionId, input: logSafeArgs });
                        const res = (await tool.call({
                            args: toolArgs!,
                            extra,
                            apifyMcpServer: this,
                            mcpServer: this.server,
                            apifyToken,
                            apifyClient: apifyClient!,
                            progressTracker,
                            mcpSessionId,
                        })) as Record<string, unknown>;

                        // Extract diagnostics and strip internal fields from res before returning to client.
                        ({ toolStatus, callDiagnostics } = applyToolTelemetry(
                            res,
                            actorName,
                            actorId,
                            callDiagnostics,
                        ));
                        return captureResult(res);
                    } finally {
                        progressTracker?.stop();
                    }
                }

                if (tool.type === TOOL_TYPE.ACTOR_MCP) {
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
                            return captureResult(respondErrorNoTelemetry(msg));
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
                        const res = await client.callTool(
                            {
                                name: tool.originToolName,
                                arguments: toolArgs!,
                                _meta: { progressToken },
                            },
                            CallToolResultSchema,
                            {
                                timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
                            },
                        );

                        // TODO: actor-mcp responses are opaque — isError could be a user input problem
                        // (e.g. invalid query) or a genuine server failure. We can't distinguish without
                        // parsing the error text. Defaulting to INTERNAL_ERROR for now; revisit when
                        // actor-mcp gets deeper telemetry treatment.
                        if ('isError' in res && res.isError) {
                            toolStatus = TOOL_STATUS.SOFT_FAIL;
                            callDiagnostics = {
                                failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
                                ...buildActorFields(actorName, actorId),
                            };
                        }

                        return captureResult({ ...res });
                    } catch (error) {
                        toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
                        const failureDetail =
                            error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
                        callDiagnostics = {
                            failure_category: classifyFailureCategory(error),
                            failure_detail: failureDetail,
                            ...buildActorFields(actorName, actorId),
                        };
                        logHttpError(
                            error,
                            `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}'`,
                            {
                                actorId: tool.actorId,
                                toolName: tool.originToolName,
                                failureCategory: callDiagnostics.failure_category,
                            },
                        );
                        return captureResult(
                            respondErrorNoTelemetry(
                                `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}': ${remoteMcpFailureDetail(error)}`,
                            ),
                        );
                    } finally {
                        if (client) await client.close();
                    }
                }

                // Handle actor tool
                if (tool.type === TOOL_TYPE.ACTOR) {
                    const progressTracker = createProgressTracker(progressToken, extra.sendNotification);

                    try {
                        log.info('Calling Actor', {
                            toolName: tool.name,
                            actorName: tool.actorFullName,
                            mcpSessionId,
                            input: logSafeArgs,
                        });
                        const executorResult = await actorExecutor.executeActorTool({
                            actorFullName: tool.actorFullName,
                            input: toolArgs!,
                            apifyClient: apifyClient!,
                            callOptions: { memory: tool.memoryMbytes },
                            progressTracker,
                            abortSignal: extra.signal,
                            mcpSessionId,
                            datasetItemsSchema: tool.datasetItemsSchema,
                        });

                        if (!executorResult) {
                            toolStatus = TOOL_STATUS.ABORTED;
                            // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                            // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                            return captureResult({});
                        }

                        // Mirror the INTERNAL branch: read the telemetry the executor embedded on error
                        // results (e.g. respondUserError → SOFT_FAIL/INVALID_INPUT), strip it from the wire,
                        // and set failure_category so the report-problem nudge picks the softer variant.
                        ({ toolStatus, callDiagnostics } = applyToolTelemetry(
                            executorResult as Record<string, unknown>,
                            actorName,
                            actorId,
                            callDiagnostics,
                        ));
                        return captureResult(executorResult);
                    } finally {
                        if (progressTracker) {
                            progressTracker.stop();
                        }
                    }
                }
                // If we reached here without returning, it means the tool type was not recognized (user error)
                toolStatus = TOOL_STATUS.SOFT_FAIL;
            } catch (error) {
                // Re-throw MCP protocol errors (e.g. from failInvalidParams) so the SDK
                // returns them as JSON-RPC errors. failInvalidParams already set callDiagnostics
                // with the correct semantic category (e.g. AUTH), so we must not overwrite it.
                // Re-throwing first is order-equivalent only because no McpError with an HTTP-range
                // code reaches this catch: an McpError(402) WOULD satisfy the x402 predicate
                // (getHttpStatusCode falls through to `.code`), but every remote-McpError route is
                // sealed by its own inner catch before reaching here, and all in-repo McpErrors use
                // negative ErrorCode.* values.
                if (error instanceof McpError) {
                    throw error;
                }

                const errorResult = buildToolCallErrorResult(error, {
                    toolName: name,
                    actorName,
                    actorId,
                    isAborted: Boolean(extra.signal?.aborted),
                });
                toolStatus = errorResult.toolStatus;

                // Propagate 402 Payment Required as a tool result per x402 MCP transport spec:
                // content[0].text (JSON) + isError: true. No log here (unlike the task path). The
                // concurrent-run limit also surfaces as 402 but is excluded by the predicate and
                // falls through to the generic run-limit handling below.
                if (errorResult.kind === TOOL_CALL_ERROR_KIND.PAYMENT) {
                    callDiagnostics = errorResult.callDiagnostics;
                    return captureResult(errorResult.response);
                }

                if (errorResult.kind === TOOL_CALL_ERROR_KIND.APPROVAL) {
                    callDiagnostics = errorResult.callDiagnostics;
                    logHttpError(error, 'Permission approval required while calling tool', {
                        toolName: name,
                        mcpSessionId,
                    });
                    return captureResult(errorResult.response);
                }

                callDiagnostics = {
                    // Spread existing diagnostics first (e.g. validation_keyword from failInvalidParams),
                    // then overwrite with the mapper's freshly computed fields so they take precedence.
                    ...callDiagnostics,
                    ...errorResult.callDiagnostics,
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
                // This framework outer-catch path bypasses extractToolTelemetry (returned via
                // captureResult), so preserve the pre-existing wire shape { toolStatus } exactly:
                // reuse the local ABORTED-aware toolStatus, do NOT re-derive from the error (which
                // would drop ABORTED and leak failureCategory/failureHttpStatus onto the wire).
                return captureResult({
                    ...respondOk(errorResult.userText),
                    isError: true,
                    toolTelemetry: { toolStatus },
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
                        args,
                        result: toolResult,
                        taskId: preflightTaskId,
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
            throw new McpError(ErrorCode.InvalidParams, msg);
        });
    }

    /**
     * Logs tool call completion at INFO level and tracks telemetry.
     * Computes duration once so both the log line and telemetry event use the same value.
     * Response bytes and resource ids are derived here from the raw `result` (+ `args`) so every
     * call site stays a plain hand-off — no path can forget to compute or strip them.
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
        args?: Record<string, unknown>;
        result?: unknown;
    }): void {
        const durationMs = Date.now() - params.startTime;
        // `result` is undefined only on short-circuit paths that never produced a payload (e.g. a
        // cancelled task); skip byte accounting there. `null`/`{}` still measure as zero bytes.
        const responseBytes = params.result === undefined ? undefined : computeToolResponseBytes(params.result);

        log.info('Tool call completed', {
            toolName: params.toolName,
            mcpSessionId: params.mcpSessionId,
            toolStatus: params.toolStatus,
            durationMs,
            ...(responseBytes !== undefined && {
                responseContentBytes: responseBytes.contentBytes,
                responseStructuredContentBytes: responseBytes.structuredContentBytes,
                responseFileBytes: responseBytes.fileBytes,
            }),
            ...(params.taskId !== undefined && { taskId: params.taskId }),
        });

        if (params.telemetryData) {
            const finalizedTelemetryData: ToolCallTelemetryProperties = {
                ...params.telemetryData,
                tool_status: params.toolStatus,
                tool_exec_time_ms: durationMs,
                ...(responseBytes && {
                    tool_response_content_bytes: responseBytes.contentBytes,
                    tool_response_structured_content_bytes: responseBytes.structuredContentBytes,
                    tool_response_file_bytes: responseBytes.fileBytes,
                }),
                // Always include actor_name/actor_id; failure-specific fields are only present when callDiagnostics has them.
                ...params.callDiagnostics,
                // Resource ids are read once here from the args + the tool's public output; no tool
                // threads them back. Applied uniformly, last. See deriveResourceIds.
                ...deriveResourceIds(params.args, params.result),
            };
            trackToolCall(params.userId, this.telemetryEnv, finalizedTelemetryData);

            // A successful report-problem call also emits a dedicated feedback event carrying the
            // submission. A downstream Segment destination fans it out to Slack/GitHub.
            if (
                params.toolName === HELPER_TOOLS.PROBLEM_REPORT &&
                params.toolStatus === TOOL_STATUS.SUCCEEDED &&
                params.args
            ) {
                trackReportedProblem(
                    params.userId,
                    this.telemetryEnv,
                    buildReportedProblemProperties(finalizedTelemetryData, params.args),
                );
            }
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
        apifyClient: ApifyClient;
        apifyToken: string;
        progressToken: string | number | undefined;
        extra: RequestHandlerExtra<Request, Notification>;
        mcpSessionId: string | undefined;
        actorName?: string;
        actorId?: string;
    }): Promise<void> {
        const {
            taskId,
            tool,
            toolArgs,
            logSafeArgs,
            apifyClient,
            apifyToken,
            progressToken,
            extra,
            mcpSessionId,
            actorName,
            actorId,
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
        const { telemetryData, userId } = await this.prepareTelemetryData(
            getToolFullName(tool),
            mcpSessionId,
            apifyToken,
        );

        const finishTaskTracking = (status: ToolStatus, diagnostics?: CallDiagnostics, result?: unknown) => {
            this.logToolCallAndTelemetry({
                toolName: tool.name,
                mcpSessionId,
                toolStatus: status,
                startTime,
                taskId,
                telemetryData,
                userId,
                callDiagnostics: diagnostics,
                args: toolArgs,
                result,
            });
        };

        // Once a task is cancelled the spec forbids writing a result; every storage path
        // must short-circuit here. `logSuffix` is concatenated after "Task was cancelled"
        // so we keep the existing log format and the existing telemetry status per path.
        const skipIfTaskCancelled = async (
            logSuffix: string,
            status: ToolStatus,
            diagnostics?: CallDiagnostics,
        ): Promise<boolean> => {
            if (!(await isTaskCancelled(taskId, mcpSessionId, this.taskStore))) return false;
            log.debug(`[executeToolAndUpdateTask] Task was cancelled${logSuffix}`, { taskId, mcpSessionId });
            finishTaskTracking(status, diagnostics);
            return true;
        };

        // Bridges MCP `tasks/cancel` to the running handler: when the client
        // explicitly cancels the task, this signal aborts so the underlying
        // Actor run stops instead of consuming compute until natural completion.
        // Per MCP tasks spec, request-level aborts (client disconnect,
        // notifications/cancelled for the original request ID) MUST NOT cancel
        // the task — `extra.signal` is intentionally not chained here.
        const cancelWatcher = createTaskCancellationWatcher({
            taskId,
            mcpSessionId,
            taskStore: this.taskStore,
        });
        const taskExtra = { ...extra, signal: cancelWatcher.signal };

        try {
            log.debug('[executeToolAndUpdateTask] Updating task status to working', {
                taskId,
                mcpSessionId,
            });
            // The store rejects terminal → 'working' transitions. If `tasks/cancel` raced
            // with us (between handler dispatch and the first watcher tick at ~500 ms),
            // updateTaskStatus throws — re-check the store to tell a clean cancel-race
            // apart from a genuine store error.
            // noinspection ExceptionCaughtLocallyJS
            try {
                await this.taskStore.updateTaskStatus(taskId, 'working', undefined, mcpSessionId);
            } catch (err) {
                if (
                    await skipIfTaskCancelled(' before execution started, skipping', TOOL_STATUS.ABORTED, {
                        ...buildActorFields(actorName, actorId),
                    })
                )
                    return;
                throw err;
            }
            await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);

            // Execute the tool and get the result
            let result: Record<string, unknown> = {};

            // Callback to propagate Actor run statusMessage into the task store and emit a push notification.
            // TODO(TC-3): cancel arriving while this is scheduled throws cancelled → working;
            // currently swallowed by progress.ts's tick catch — guard or catch explicitly.
            const onStatusMessage = async (message: string) => {
                await this.taskStore.updateTaskStatus(taskId, 'working', message, mcpSessionId);
                await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);
            };

            // Handle internal tool execution in task mode
            if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === TOOL_TYPE.INTERNAL) {
                const progressTracker = createProgressTracker(
                    progressToken,
                    extra.sendNotification,
                    taskId,
                    onStatusMessage,
                );

                try {
                    log.info('Calling internal tool for task', {
                        taskId,
                        toolName: tool.name,
                        mcpSessionId,
                        input: logSafeArgs,
                    });
                    const res = (await tool.call({
                        args: toolArgs,
                        extra: taskExtra,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                        apifyToken,
                        apifyClient,
                        progressTracker,
                        mcpSessionId,
                        taskMode: true,
                    })) as Record<string, unknown>;

                    ({ toolStatus, callDiagnostics } = applyToolTelemetry(res, actorName, actorId, callDiagnostics));
                    result = res;
                } finally {
                    if (progressTracker) {
                        progressTracker.stop();
                    }
                }
            }

            // Handle actor tool execution in task mode
            if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === TOOL_TYPE.ACTOR) {
                const progressTracker = createProgressTracker(
                    progressToken,
                    extra.sendNotification,
                    taskId,
                    onStatusMessage,
                );

                try {
                    log.info('Calling Actor for task', {
                        taskId,
                        toolName: tool.name,
                        actorName: tool.actorFullName,
                        mcpSessionId,
                        input: logSafeArgs,
                    });
                    const executorResult = await actorExecutor.executeActorTool({
                        actorFullName: tool.actorFullName,
                        input: toolArgs,
                        apifyClient,
                        callOptions: { memory: tool.memoryMbytes },
                        progressTracker,
                        abortSignal: cancelWatcher.signal,
                        mcpSessionId,
                        datasetItemsSchema: tool.datasetItemsSchema,
                        taskMode: true,
                    });

                    if (!executorResult) {
                        toolStatus = TOOL_STATUS.ABORTED;
                        // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                        // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                        result = {};
                    } else {
                        // Mirror the INTERNAL task branch: extract embedded telemetry so failure_category
                        // drives the success-path nudge below and toolTelemetry is stripped from the wire.
                        ({ toolStatus, callDiagnostics } = applyToolTelemetry(
                            executorResult as Record<string, unknown>,
                            actorName,
                            actorId,
                            callDiagnostics,
                        ));
                        result = executorResult;
                    }
                } finally {
                    if (progressTracker) {
                        progressTracker.stop();
                    }
                }
            }

            // Check if task was cancelled before storing result
            if (await skipIfTaskCancelled(', skipping result storage', toolStatus)) return;

            // On a failed result, nudge the agent to report the blocker via report-problem (mirrors the
            // synchronous CallTool path, which task-mode calls like call-actor bypass).
            result = this.withReportProblemNudge(
                result,
                tool.name,
                callDiagnostics.failure_category,
                callDiagnostics.failure_http_status,
            );

            // Store the result in the task store
            log.debug('[executeToolAndUpdateTask] Storing completed result', {
                taskId,
                mcpSessionId,
            });
            await storeTaskResultOrSkipIfExpired(this.taskStore, tool.name, taskId, 'completed', result, mcpSessionId);
            log.debug('Task completed successfully', { taskId, toolName: tool.name, mcpSessionId });
            await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);

            finishTaskTracking(toolStatus, callDiagnostics, result);
        } catch (error) {
            // Reached only when the task expired before the `working` transition (updateTaskStatus
            // above rethrows the store's unknown-taskId error). The tool never ran and the task is
            // gone, so soft-fail, record telemetry, and stop. Every result store (success and error
            // paths) tolerates expiry via storeTaskResultOrSkipIfExpired, so they don't reach here.
            if (isTaskNotFoundError(error)) {
                log.softFail('Task expired before execution started', {
                    taskId,
                    toolName: tool.name,
                    mcpSessionId,
                });
                finishTaskTracking(TOOL_STATUS.SOFT_FAIL, {
                    failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
                    ...buildActorFields(actorName, actorId),
                });
                return;
            }

            const errorResult = buildToolCallErrorResult(error, {
                toolName: tool.name,
                actorName,
                actorId,
                isAborted: Boolean(cancelWatcher.signal.aborted),
            });

            // Handle 402 Payment Required — return structured x402 result so clients can auto-pay
            if (errorResult.kind === TOOL_CALL_ERROR_KIND.PAYMENT) {
                logHttpError(error, 'Payment required while calling tool (task mode)', { toolName: tool.name });
                // Per MCP tasks spec: once a task is cancelled it MUST remain cancelled,
                // so guard storeTaskResult against a cancel that raced with this 402.
                if (
                    await skipIfTaskCancelled(', skipping 402 result storage', TOOL_STATUS.ABORTED, {
                        ...buildActorFields(actorName, actorId),
                    })
                )
                    return;
                await storeTaskResultOrSkipIfExpired(
                    this.taskStore,
                    tool.name,
                    taskId,
                    'completed',
                    errorResult.response,
                    mcpSessionId,
                );
                await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);
                finishTaskTracking(errorResult.toolStatus, errorResult.callDiagnostics, errorResult.response);
                return;
            }

            if (errorResult.kind === TOOL_CALL_ERROR_KIND.APPROVAL) {
                logHttpError(error, 'Permission approval required while calling tool (task mode)', {
                    toolName: tool.name,
                });
                // Per MCP tasks spec: once a task is cancelled it MUST remain cancelled,
                // so guard storeTaskResult against a cancel that raced with this approval error.
                if (
                    await skipIfTaskCancelled(', skipping permission-approval result storage', TOOL_STATUS.ABORTED, {
                        ...buildActorFields(actorName, actorId),
                    })
                )
                    return;
                await storeTaskResultOrSkipIfExpired(
                    this.taskStore,
                    tool.name,
                    taskId,
                    'completed',
                    errorResult.response,
                    mcpSessionId,
                );
                await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);
                finishTaskTracking(errorResult.toolStatus, errorResult.callDiagnostics, errorResult.response);
                return;
            }

            toolStatus = errorResult.toolStatus;
            callDiagnostics = errorResult.callDiagnostics;
            // Log level follows the already-classified toolStatus:
            //   SOFT_FAIL (e.g. 402/403 user quota, client-side issues) → softFail
            //   FAILED/ABORTED/other                                    → error
            if (toolStatus === TOOL_STATUS.SOFT_FAIL) {
                // Mezmo promotes on "error" in message/keys — use errMessage key, sanitized.
                const errMessage = sanitizeMezmoMessage(error instanceof Error ? error.message : String(error));
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
            const { userText } = errorResult;

            // Check if task was cancelled before storing result
            if (await skipIfTaskCancelled(', skipping result storage', toolStatus, callDiagnostics)) return;

            log.debug('[executeToolAndUpdateTask] Storing failed result', {
                taskId,
                mcpSessionId,
            });
            // Nudge on a genuinely-failed task result. INTERNAL_ERROR and an unknown category get the
            // full nudge; a genuine INVALID_INPUT gets the softer nudge; payment (402) is suppressed via
            // the HTTP status and AUTH / PERMISSION_APPROVAL_REQUIRED via NON_NUDGE_FAILURE_CATEGORIES.
            // The 402 branch above returns before reaching here, so this only sees non-payment failures.
            const failedResult = this.withReportProblemNudge(
                {
                    content: [
                        {
                            type: 'text' as const,
                            text: userText,
                        },
                    ],
                    isError: true,
                    internalToolStatus: toolStatus,
                },
                tool.name,
                callDiagnostics.failure_category,
                callDiagnostics.failure_http_status,
            );
            await storeTaskResultOrSkipIfExpired(
                this.taskStore,
                tool.name,
                taskId,
                'failed',
                failedResult,
                mcpSessionId,
            );
            await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);

            finishTaskTracking(toolStatus, callDiagnostics, failedResult);
        } finally {
            cancelWatcher.dispose();
        }
    }

    /*
     * Creates telemetry data for a tool call.
     */
    private async prepareTelemetryData(
        toolName: string,
        mcpSessionId: string | undefined,
        apifyToken: string,
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
        if (this.serverMode !== SERVER_MODE.APPS) {
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
