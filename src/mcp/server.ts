/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { randomUUID } from 'node:crypto';

// The ext-apps package exposes `./server` via conditional exports only (no `./server/index.js`
// wildcard), so we can't satisfy the `import/extensions` rule on this subpath.
// eslint-disable-next-line import/extensions
import { getUiCapability, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest, InitializeResult, Task } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
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
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from '../apify_client.js';
import {
    DEFAULT_TELEMETRY_ENABLED,
    DEFAULT_TELEMETRY_ENV,
    FAILURE_CATEGORY,
    HELPER_TOOLS,
    TOOL_STATUS,
} from '../const.js';
import { prompts } from '../prompts/index.js';
import { createResourceService } from '../resources/resource_service.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';
import { getServerInfo } from '../server_card.js';
import { getTelemetryEnv } from '../telemetry.js';
import { withReportProblemNudge } from '../tools/dev/report_problem.js';
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
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { SERVER_MODE, TOOL_TYPE } from '../types.js';
import { isMcpClientFaultMessage, sanitizeMezmoMessage } from '../utils/logging.js';
import { getRequestOriginForClient, isReportProblemBlockedForClient } from '../utils/mcp_clients.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { parseServerMode, resolveServerMode } from '../utils/server_mode.js';
import { buildActorFields, getToolFullName, getToolPublicFieldOnly } from '../utils/tools.js';
import { getActors, getToolsForServerMode, toolNamesToInput } from '../utils/tools_loader.js';
import { LOG_LEVEL_MAP } from './const.js';
import { emitTaskStatusNotification, executeToolAndUpdateTask } from './task_execution.js';
import {
    buildPreflightFailureOutcome,
    classifyToolCallError,
    executeSyncToolCall,
    prepareToolCall,
} from './tool_call_engine.js';
import { logToolCallAndTelemetry, prepareTelemetryData } from './tool_call_telemetry.js';
import { parseInputParamsFromUrl, storeTaskResultOrSkipIfExpired } from './utils.js';

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
    private pendingToolsUntilClientKnown: { input: Input; actorTools: ToolEntry[]; isSessionRestore: boolean }[] = [];

    // Telemetry configuration (resolved from options and env vars, see setupTelemetry)
    public readonly telemetryEnabled: boolean;
    public readonly telemetryEnv: TelemetryEnv;

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
                // Declared but unused — some clients (e.g. Claude Desktop) fail without it.
                resources: {},
                prompts: {},
                logging: {},
            },
            instructions: getServerInstructions(),
        });
        const { telemetryEnabled, telemetryEnv } = this.setupTelemetry();
        this.telemetryEnabled = telemetryEnabled;
        this.telemetryEnv = telemetryEnv;
        this.setupInitializeHandler();
        this.setupLoggingProxy();
        this.tools = new Map();
        this.setupErrorHandling(setupSigintHandler);
        this.setupLoggingHandlers();
        this.setupToolHandlers();
        this.setupPromptHandlers();
        // Handle resource requests so clients like Claude Desktop don't fail.
        this.setupResourceHandlers();
        this.setupTaskHandlers();
    }

    /**
     * Telemetry configuration with precedence: explicit options > env vars > defaults
     */
    private setupTelemetry(): { telemetryEnabled: boolean; telemetryEnv: TelemetryEnv } {
        let telemetryEnabled: boolean;
        const explicitEnabled = parseBooleanOrNull(this.options.telemetry?.enabled);
        if (explicitEnabled !== null) {
            telemetryEnabled = explicitEnabled;
        } else {
            const envEnabled = parseBooleanOrNull(process.env.TELEMETRY_ENABLED);
            telemetryEnabled = envEnabled ?? DEFAULT_TELEMETRY_ENABLED;
        }

        // Configure telemetryEnv: explicit option > env var > default ('PROD')
        let telemetryEnv: TelemetryEnv = DEFAULT_TELEMETRY_ENV;
        if (telemetryEnabled) {
            telemetryEnv = getTelemetryEnv(this.options.telemetry?.env ?? process.env.TELEMETRY_ENV);
        }

        return { telemetryEnabled, telemetryEnv };
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
    private composeToolsForClient(input: Input, actorTools: ToolEntry[], isSessionRestore = false): ToolEntry[] {
        const tools = getToolsForServerMode(input, actorTools, this.serverMode, isSessionRestore);
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
        return this.isReportProblemServableForClient(this.options.initializeRequestData);
    }

    /**
     * Per-client variant of {@link isReportProblemServable} for stateless requests.
     */
    public isReportProblemServableForClient(initializeRequestData: InitializeRequest | undefined): boolean {
        return (
            this.telemetryEnabled &&
            initializeRequestData != null &&
            !isReportProblemBlockedForClient(initializeRequestData)
        );
    }

    /**
     * Resolve the effective server mode for a client described by an initialize-shaped request.
     */
    public resolveServerModeForClient(initializeRequestData: InitializeRequest | undefined): SERVER_MODE {
        if (this.serverModeOption !== 'auto') return this.serverMode;
        return resolveServerMode('auto', isUiSupportedByClient(initializeRequestData));
    }

    /** Widgets resolved by {@link prepare}; consumed by the resource service (both eras). */
    public getAvailableWidgets(): Map<string, AvailableWidget> {
        return this.availableWidgets;
    }

    private composePendingToolsForClient(): void {
        if (this.pendingToolsUntilClientKnown.length === 0) return;

        const tools = this.pendingToolsUntilClientKnown.flatMap(({ input, actorTools, isSessionRestore }) =>
            this.composeToolsForClient(input, actorTools, isSessionRestore),
        );

        this.pendingToolsUntilClientKnown = [];

        // Notify after the flush so shared-state handlers (e.g. Redis recovery) see the final tool
        // set. Load paths already upserted the client-agnostic tools pre-init; re-upserting is
        // idempotent, and this pass adds the client-gated tools (e.g. report-problem) now that the
        // client is known, reconciling shared state to the complete set.
        if (tools.length > 0) this.upsertTools(tools, true);
    }

    /** Compose stateless tools for the request's resolved mode. */
    public composeStatelessClientGatedTools(mode: SERVER_MODE): Map<string, ToolEntry> {
        const tools = new Map(this.tools);
        for (const { input, actorTools, isSessionRestore } of this.pendingToolsUntilClientKnown) {
            for (const tool of getToolsForServerMode(input, actorTools, mode, isSessionRestore)) {
                tools.set(tool.name, tool);
            }
        }
        if (!this.telemetryEnabled) tools.delete(HELPER_TOOLS.PROBLEM_REPORT);
        return tools;
    }

    /**
     * Returns an array of tool names.
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
     * Returns the list of all internal tool names (e.g., 'call-actor', 'search-actors').
     */
    private listInternalToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === TOOL_TYPE.INTERNAL)
            .map((tool) => tool.name);
    }

    /**
     * Returns the currently loaded Actor tool full names (e.g., 'apify/rag-web-browser').
     */
    public listActorToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === TOOL_TYPE.ACTOR)
            .map((tool) => tool.actorFullName);
    }

    /**
     * Returns the unique Actor IDs registered as MCP servers (e.g., 'apify/actors-mcp-server').
     */
    private listActorMcpServerToolIds(): string[] {
        const ids = Array.from(this.tools.values())
            .filter((tool: ToolEntry) => tool.type === TOOL_TYPE.ACTOR_MCP)
            .map((tool) => tool.actorId);
        return Array.from(new Set(ids));
    }

    /**
     * Returns the combined internal tool names, Actor full names, and Actor-MCP server Actor IDs
     * currently loaded.
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
    private registerFetchedActorTools(
        input: Input,
        actorTools: ToolEntry[],
        shouldNotify: boolean,
        isSessionRestore = false,
    ): void {
        if (!this.serverModeResolved) {
            this.pendingToolsUntilClientKnown.push({ input, actorTools, isSessionRestore });
            if (actorTools.length > 0) this.upsertTools(actorTools, shouldNotify);
            return;
        }
        const tools = this.composeToolsForClient(input, actorTools, isSessionRestore);
        if (tools.length > 0) this.upsertTools(tools, shouldNotify);
        if (!this.clientKnown) this.pendingToolsUntilClientKnown.push({ input, actorTools, isSessionRestore });
    }

    /**
     * Loads missing toolNames from a provided list of tool names.
     * Skips toolNames that are already loaded and loads only the missing ones.
     * @param toolNames - Array of tool names to ensure are loaded
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

        // isSessionRestore: true. This replays the tool names a session already had (stored via
        // listAllToolNames), so the add-actor cutoff must NOT rewrite them — a stored 'add-actor'
        // resolves to itself. The live paths (loadToolsFromInput/loadToolsFromUrl, flag omitted)
        // instead substitute call-actor for a fresh selection. Both the flag and this exception go
        // away in PR 2, when add-actor is deleted and there is nothing left to preserve.
        this.registerFetchedActorTools(restoreInput, actorTools, actorTools.length > 0, true);
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
        for (const tool of tools) {
            const stored = this.options.paymentProvider ? this.options.paymentProvider.decorateToolSchema(tool) : tool;
            this.tools.set(stored.name, stored);
        }
        if (shouldNotifyToolsChangedHandler) this.notifyToolsChangedHandler();
        return tools;
    }

    private notifyToolsChangedHandler() {
        if (!this.toolsChangedHandler) return;
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
            this.sigintHandler = handler;
        }
    }

    private setupLoggingProxy(): void {
        const originalSendLoggingMessage = this.server.sendLoggingMessage.bind(this.server);

        // Filter outgoing log messages below the client's requested level.
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
     * Still carries the request-origin tag — `initializeRequestData` is already set by this point.
     */
    private resolveApifyClient(params: ApifyRequestParams): ApifyClient | undefined {
        const token = this.resolveApifyToken(params._meta);
        return token
            ? new ApifyClient({ token, requestOrigin: getRequestOriginForClient(this.options.initializeRequestData) })
            : undefined;
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
     * Returns the prompts/list result.
     */
    private listPrompts(): { prompts: typeof prompts } {
        return { prompts };
    }

    /**
     * Builds the prompts/get result: find → not-found → validate → render.
     * Throws {@link McpError} for an unknown prompt name or invalid arguments (v1 behavior).
     */
    private getPrompt(name: string, args: Record<string, string> | undefined) {
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
    }

    /**
     * Sets up MCP request handlers for prompts.
     */
    private setupPromptHandlers(): void {
        this.server.setRequestHandler(ListPromptsRequestSchema, () => this.listPrompts());
        this.server.setRequestHandler(GetPromptRequestSchema, (request) =>
            this.getPrompt(request.params.name, request.params.arguments),
        );
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
     * Each handler reads `_meta.mcpSessionId` (injected at the transport layer) to isolate
     * per-session task stores.
     */
    private setupTaskHandlers(): void {
        // List tasks
        this.server.setRequestHandler(ListTasksRequestSchema, async (request) => {
            const params = (request.params || {}) as ApifyRequestParams & { cursor?: string };
            const { cursor } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[ListTasksRequestSchema] Listing tasks', { mcpSessionId });
            const result = await this.taskStore.listTasks(cursor, mcpSessionId);
            return { tasks: result.tasks, nextCursor: result.nextCursor };
        });

        // Get task status
        this.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskRequestSchema] Getting task status', { taskId, mcpSessionId });
            return await this.getTaskOrThrow(taskId, mcpSessionId, 'GetTaskRequestSchema');
        });

        // Get task result payload
        this.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
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
        // Handles the request to list tools.
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
         * Handles the request to call a tool. `extra` carries request-scoped helpers such as
         * `sendNotification`. Throws {@link McpError} to mirror the MCP SDK's McpServer error codes.
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const params = request.params as ApifyRequestParams & { name: string; arguments?: Record<string, unknown> };
            // Keep telemetry on the decoded arguments.
            // eslint-disable-next-line prefer-const
            let { name, arguments: args, _meta: meta } = params;
            const progressToken = meta?.progressToken;
            const apifyToken = this.resolveApifyToken(meta) as string;
            // Injected upstream; required for long-running tasks — the task store keys on it and
            // there is no other channel to pass it.
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
            // The nudge must be included in the measured result.
            let toolResult: unknown = null;
            // Keep actor context available to the outer catch.
            let actorName: string | undefined;
            let actorId: string | undefined;

            // Start with the raw name so early failures still have telemetry.
            const { telemetryData, userId } = await prepareTelemetryData({
                toolName: name,
                mcpSessionId,
                apifyToken,
                apifyMcpServer: this,
            });

            try {
                const prepared = await prepareToolCall({
                    apifyMcpServer: this,
                    apifyToken,
                    name,
                    args,
                    meta,
                    requestHeaders: extra.requestInfo?.headers,
                    isTaskRequest: Boolean(request.params.task),
                    mcpSessionId,
                    telemetryData,
                    extra,
                });

                if ('result' in prepared) {
                    // The engine already classified this post-resolution failure.
                    resolvedToolName = prepared.resolvedToolName;
                    args = prepared.decodedArgs;
                    toolStatus = prepared.toolStatus;
                    callDiagnostics = prepared.callDiagnostics;
                    toolResult = prepared.result;
                    return prepared.result;
                }

                if ('message' in prepared) {
                    // Reproduce v1's invalid-params tail and preserve telemetry fields.
                    resolvedToolName = prepared.resolvedToolName ?? resolvedToolName;
                    if (prepared.decodedArgs) args = prepared.decodedArgs;
                    toolStatus = prepared.toolStatus;
                    callDiagnostics = prepared.callDiagnostics;
                    log.softFail(prepared.message, {
                        mcpSessionId,
                        failureCategory: prepared.callDiagnostics.failure_category,
                        actorName: prepared.callDiagnostics.actor_name,
                        validationKeyword: prepared.callDiagnostics.validation_keyword,
                        validationPath: prepared.callDiagnostics.validation_path,
                        validationMissingProperty: prepared.callDiagnostics.validation_missing_property,
                        validationAdditionalProperty: prepared.callDiagnostics.validation_additional_property,
                        ...prepared.logFields,
                    });
                    await this.server.sendLoggingMessage({ level: 'error', data: prepared.message });
                    throw new McpError(ErrorCode.InvalidParams, prepared.message);
                }

                const { tool, toolArgs, logSafeArgs, apifyClient, standbyRejection, paymentRequiredResult } = prepared;
                actorName = prepared.actorName;
                actorId = prepared.actorId;
                resolvedToolName = getToolFullName(tool);
                // Telemetry uses the decoded arguments.
                args = prepared.decodedArgs;

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
                            // `finally` logs FAILED/INTERNAL_ERROR, not the stale pre-flight SOFT_FAIL.
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
                        // Measure the nudged result without changing the stored result.
                        toolResult = withReportProblemNudge({
                            result: outcome.result,
                            tools: this.tools,
                            failingToolName: resolvedToolName,
                            failureCategory: callDiagnostics.failure_category,
                            failureHttpStatus: callDiagnostics.failure_http_status,
                        });
                        // createTask returned status `working`; synthesize the terminal status instead of
                        // re-fetching — if the task expired before the result store (the one case
                        // storeTaskResultOrSkipIfExpired tolerates), a re-fetch would come back empty and a
                        // `working` fallback would contradict the tasks/get 404 the client sees next.
                        return { task: { ...task, status: 'completed' as const } };
                    }

                    // Execute the tool asynchronously and update task status
                    setImmediate(() => {
                        executeToolAndUpdateTask({
                            taskId: task.taskId,
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
                            apifyMcpServer: this,
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

                // Sync path: run the shared dispatch tail and project its neutral outcome by identity.
                const outcome = await executeSyncToolCall(prepared, {
                    apifyMcpServer: this,
                    apifyToken,
                    toolName: name,
                    mcpSessionId,
                    progressToken,
                    extra,
                });
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                toolResult = outcome.result;
                return outcome.result;
            } catch (error) {
                // Match v1: classify task-creation failures, but re-throw protocol errors as JSON-RPC.
                if (error instanceof McpError) {
                    throw error;
                }
                const outcome = classifyToolCallError(error, {
                    apifyMcpServer: this,
                    toolName: name,
                    failingToolName: resolvedToolName,
                    actorName,
                    actorId,
                    isAborted: Boolean(extra.signal?.aborted),
                    mcpSessionId,
                });
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                toolResult = outcome.result;
                return outcome.result;
            } finally {
                if (shouldTrackTelemetry) {
                    logToolCallAndTelemetry({
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
                        apifyMcpServer: this,
                    });
                }
            }
        });
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

    /**
     * Pre-connect setup for callers that do not use {@link connect}.
     */
    async prepare(): Promise<void> {
        await this.resolveWidgets();
    }

    async connect(transport: Transport): Promise<void> {
        await this.prepare();
        await this.server.connect(transport);
    }

    async close(): Promise<void> {
        if (this.sigintHandler) {
            process.removeListener('SIGINT', this.sigintHandler);
            this.sigintHandler = undefined;
        }
        // Clear all tools and null their compiled schemas.
        for (const tool of this.tools.values()) {
            if (tool.ajvValidate && typeof tool.ajvValidate === 'function') {
                (tool as { ajvValidate: ValidateFunction<unknown> | null }).ajvValidate = null;
            }
        }
        this.tools.clear();
        if (this.toolsChangedHandler) {
            this.unregisterToolsChangedHandler();
        }
        // Closing the server also removes its event handlers.
        await this.server.close();
    }
}
