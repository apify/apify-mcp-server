/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from '../apify_client.js';
import { DEFAULT_TELEMETRY_ENABLED, DEFAULT_TELEMETRY_ENV, HELPER_TOOLS } from '../const.js';
import { prompts } from '../prompts/index.js';
import { createPromptService } from '../prompts/prompt_service.js';
import { createResourceService } from '../resources/resource_service.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';
import { getTelemetryEnv } from '../telemetry.js';
import type {
    ActorsMcpServerOptions,
    ActorStore,
    ApifyRequestParams,
    Input,
    ServerModeOption,
    TelemetryEnv,
    ToolEntry,
} from '../types.js';
import { SERVER_MODE, TOOL_TYPE } from '../types.js';
import { getRequestOriginForClient, isReportProblemBlockedForClient } from '../utils/mcp_clients.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { parseServerMode, resolveServerMode } from '../utils/server_mode.js';
import { getActors, getToolsForServerMode, toolNamesToInput } from '../utils/tools_loader.js';
import { buildMcpClientContext, isUiSupportedByClient } from './client_context.js';
import type { McpClientContext } from './client_context.js';
import { LegacyMcpServer } from './legacy_server.js';
import type { LegacyMcpServerHost } from './legacy_server.js';
import { parseInputParamsFromUrl } from './utils.js';

/**
 * Create Apify MCP server.
 *
 * The shared-Apify-behavior facade: it owns the tool registry + loaders, server-mode resolution,
 * `actorStore`, telemetry config, widgets, prompt/resource services, and token/client resolution,
 * and constructs exactly one {@link LegacyMcpServer} (the v1 SDK adapter), delegating all v1
 * protocol work to it. It implements {@link LegacyMcpServerHost} so the adapter reads shared state
 * through a narrow contract.
 */
export class ActorsMcpServer implements LegacyMcpServerHost {
    public readonly tools: Map<string, ToolEntry>;
    public readonly options: ActorsMcpServerOptions;
    public readonly actorStore?: ActorStore;
    public clientContext: McpClientContext | undefined;
    /**
     * Resolved server mode. Preliminary value at construction (`'auto'` → `DEFAULT`).
     * Finalized inside the `initialize` request handler (see {@link applyInitialize}) once the
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

    // Telemetry configuration (resolved from options and env vars, see setupTelemetry)
    public readonly telemetryEnabled: boolean;
    public readonly telemetryEnv: TelemetryEnv;

    // Neutral prompt/resource services; the legacy adapter wires SDK handlers to these.
    public readonly promptService: ReturnType<typeof createPromptService>;
    public readonly resourceService: ReturnType<typeof createResourceService>;

    // List of widgets that are ready to be served
    private availableWidgets: Map<string, AvailableWidget> = new Map();

    /** Set in the initialize handler once client capabilities are known. */
    public clientSupportsUi = false;

    // The v1 SDK adapter. Package-private: constructed here and never exposed on the public surface.
    private readonly legacyServer: LegacyMcpServer;

    constructor(options: ActorsMcpServerOptions = {}) {
        this.options = options;
        this.clientContext = buildMcpClientContext(options.initializeRequestData?.params);
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

        const { telemetryEnabled, telemetryEnv } = this.setupTelemetry();
        this.telemetryEnabled = telemetryEnabled;
        this.telemetryEnv = telemetryEnv;
        this.tools = new Map();

        this.promptService = createPromptService(prompts);
        this.resourceService = createResourceService({
            paymentProvider: this.options.paymentProvider,
            getMode: () => this.serverMode,
            getAvailableWidgets: () => this.availableWidgets,
        });

        const { setupSigintHandler = true } = options;
        this.legacyServer = new LegacyMcpServer(this, {
            setupSigintHandler,
            taskStore: options.taskStore,
            transportType: options.transportType,
        });
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
     * Runs the shared initialize steps the legacy adapter delegates to before it returns the
     * `InitializeResult`: refresh the client context from the wire request, capture the raw request
     * for hosted session recovery, resolve `'auto'` server mode against client capabilities, flush
     * pending tool sources, and resolve widgets. The adapter delegates the SDK boilerplate and
     * overwrites `instructions` afterwards (see {@link getServerInstructions}).
     *
     * Ordering is load-bearing: mode before compose, compose before widgets/instructions.
     * `composePendingToolsForClient` runs before the instructions are read so tool presence reflects
     * the final composed set.
     */
    public async applyInitialize(request: InitializeRequest): Promise<void> {
        this.clientContext = buildMcpClientContext(request.params);
        this.options.initializeRequestData = request;
        this.clientSupportsUi = isUiSupportedByClient(this.clientContext);

        if (this.serverModeOption === 'auto') {
            const resolved = resolveServerMode('auto', this.clientSupportsUi);
            if (resolved !== this.serverMode) {
                this.serverMode = resolved;
            }
            this.serverModeResolved = true;
        }

        log.info('Resolved server mode for client capabilities', {
            serverMode: this.serverMode,
            serverModeOption: this.serverModeOption,
            clientSupportsUi: this.clientSupportsUi,
            capabilities: request?.params?.capabilities,
        });

        this.composePendingToolsForClient();

        await this.resolveWidgets();
    }

    /**
     * Server instructions for the current connection: mode plus whether report-problem is loaded.
     * Read by the legacy adapter after `applyInitialize`, when the tool set is final.
     */
    public getServerInstructions(): string {
        return getServerInstructions(this.serverMode, this.tools.has(HELPER_TOOLS.PROBLEM_REPORT));
    }

    /** True once the connecting client is known (set in the initialize handler, or hydrated by a
     *  recovery path). Only client-gated tools wait for this so the per-client blocklist can be
     *  applied; client-agnostic tools compose regardless. */
    private get clientKnown(): boolean {
        return this.clientContext != null;
    }

    /**
     * Compose the tool list for the current connection: resolve mode-specific tools, then drop
     * report-problem unless it is currently servable (see {@link isReportProblemServable}).
     * report-problem is a default-injected tool (via tools_loader) rather than a category member,
     * gated here by servability. Every other tool composes eagerly, so a recovery/rehydration load
     * without an initialize still restores them. report-problem is withheld until the client is known
     * and re-added by the initialize flush. Used by every input-driven load path and the flush.
     * (Actor tools are never gated, so they need no filtering.)
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
        return this.telemetryEnabled && this.clientKnown && !isReportProblemBlockedForClient(this.clientContext);
    }

    private composePendingToolsForClient(): void {
        if (this.pendingToolsUntilClientKnown.length === 0) return;

        const tools = this.pendingToolsUntilClientKnown.flatMap(({ input, actorTools }) =>
            this.composeToolsForClient(input, actorTools),
        );

        this.pendingToolsUntilClientKnown = [];

        // Load paths already upserted the client-agnostic tools pre-init; re-upserting is
        // idempotent, and this pass adds the client-gated tools (e.g. report-problem) now that the
        // client is known.
        if (tools.length > 0) this.upsertTools(tools);
    }

    /**
     * Returns an array of tool names.
     */
    public listToolNames(): string[] {
        return Array.from(this.tools.keys());
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
     * (if non-empty) upsert the mode-agnostic actor tools immediately.
     * Once the mode is resolved, compose the client-specific set via `composeToolsForClient` (which
     * withholds report-problem until the client is known) and upsert it; if the client still isn't
     * known, queue the source so the initialize flush re-composes and adds the client-gated tools.
     */
    private registerFetchedActorTools(input: Input, actorTools: ToolEntry[]): void {
        if (!this.serverModeResolved) {
            this.pendingToolsUntilClientKnown.push({ input, actorTools });
            if (actorTools.length > 0) this.upsertTools(actorTools);
            return;
        }
        const tools = this.composeToolsForClient(input, actorTools);
        if (tools.length > 0) this.upsertTools(tools);
        if (!this.clientKnown) this.pendingToolsUntilClientKnown.push({ input, actorTools });
    }

    /**
     * Loads missing toolNames from a provided list of tool names.
     * Skips toolNames that are already loaded and loads only the missing ones.
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

        this.registerFetchedActorTools(restoreInput, actorTools);
    }

    /** Load tools from URL params. Used by SSE and HTTP entry points. */
    public async loadToolsFromUrl(url: string, apifyClient: ApifyClient) {
        const input = parseInputParamsFromUrl(url);
        const actorTools = await getActors(input, apifyClient, {
            actorStore: this.actorStore,
            paymentProvider: this.options.paymentProvider,
        });

        log.debug('Loading tools from query parameters');
        this.registerFetchedActorTools(input, actorTools);
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
        this.registerFetchedActorTools(input, actorTools);
    }

    /** Delete tools from the server. */
    public removeToolsByName(toolNames: string[]): string[] {
        const removedTools: string[] = [];
        for (const toolName of toolNames) {
            if (this.removeToolByName(toolName)) {
                removedTools.push(toolName);
            }
        }
        return removedTools;
    }

    /**
     * Upsert new tools.
     * @param tools - Array of tool wrappers to add or update
     * @returns Array of added/updated tool wrappers
     */
    public upsertTools(tools: ToolEntry[]) {
        // Client gating (e.g. hiding report-problem from Anthropic surfaces) is applied earlier, in
        // composeToolsForClient — the single compose choke point where the client is known. Do not
        // filter here: this is a low-level commit point reached before the client is known too.
        for (const tool of tools) {
            const stored = this.options.paymentProvider ? this.options.paymentProvider.decorateToolSchema(tool) : tool;
            this.tools.set(stored.name, stored);
        }
        return tools;
    }

    private removeToolByName(toolName: string): boolean {
        if (this.tools.has(toolName)) {
            this.tools.delete(toolName);
            log.debug('Deleted tool', { toolName });
            return true;
        }
        return false;
    }

    /**
     * Token sources in order: per-request `_meta.apifyToken` (stdio inline) > server-instance
     * option (set by the transport from `Authorization` header or stdio env). No env fallback:
     * dev_server / production must extract the token from request headers so payment
     * mode (no token) behaves identically to production.
     */
    public resolveApifyToken(meta?: ApifyRequestParams['_meta']): string | undefined {
        return meta?.apifyToken || this.options.token;
    }

    /**
     * Token-scoped client for resources/read (the API proxy needs auth). Deliberately token-only:
     * unlike the CallTool path it does NOT forward provider/payment headers, so a payment-only
     * session (x402/Skyfire, no Apify token) has no client and every read fails by design.
     * Still carries the request-origin tag from the client context captured by this point.
     */
    public resolveApifyClient(params: ApifyRequestParams): ApifyClient | undefined {
        const token = this.resolveApifyToken(params._meta);
        return token
            ? new ApifyClient({ token, requestOrigin: getRequestOriginForClient(this.clientContext) })
            : undefined;
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
        await this.legacyServer.connect(transport);
    }

    async close(): Promise<void> {
        // Reverse-of-connect (LIFO) teardown: take the transport/server down first (SIGINT removal +
        // server close are the adapter's transport-lifecycle responsibility), then clear the shared
        // tool map. This intentionally reverses the pre-refactor tools-then-server order; it is
        // unobservable because `close()` only runs on a quiesced serving unit.
        await this.legacyServer.close();
        this.clearTools();
    }

    /** Clear all tools and null their compiled schemas. */
    private clearTools(): void {
        for (const tool of this.tools.values()) {
            if (tool.ajvValidate && typeof tool.ajvValidate === 'function') {
                (tool as { ajvValidate: ValidateFunction<unknown> | null }).ajvValidate = null;
            }
        }
        this.tools.clear();
    }
}
