/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';

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
import type { StatelessMcpServerHost, StatelessRequestSnapshot } from './stateless_server.js';
import { parseInputParamsFromUrl } from './utils.js';

/** An actor-tool fetch retained with the exact input it was fetched for, so it can be re-composed. */
type ToolSource = { input: Input; actorTools: ToolEntry[] };

/**
 * Stable identity of a fetch input, so reloading the same input replaces its retained source rather
 * than adding another (see {@link ActorsMcpServer.toolSources}). Keys are sorted because callers
 * need not agree on property order. The array replacer filters keys at every depth — safe only
 * while `Input` stays flat; a nested object's keys would be silently dropped and inputs collide.
 */
function toolSourceKey(input: Input): string {
    return JSON.stringify(input, Object.keys(input).sort());
}

/**
 * The resolved mode plus client identity a composition or gating decision is made against.
 * Passed as a parameter so a caller can compose against a per-request view without mutating
 * the shared facade.
 */
type ServingContext = {
    readonly serverMode: SERVER_MODE;
    readonly clientContext: McpClientContext | undefined;
};

/**
 * Read the widget registry from disk. Mode-agnostic, so a successful read is resolved once and
 * shared (see {@link ActorsMcpServer.resolveWidgetsForMode}). Rejects on a failed scan so the
 * caller can tell that apart from a successful empty registry.
 */
async function resolveServableWidgets(): Promise<Map<string, AvailableWidget>> {
    const resolved = await resolveAvailableWidgets(dirname(fileURLToPath(import.meta.url)));

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

    return resolved;
}

/**
 * The shared-Apify-behavior facade: owns the tool registry + loaders, server-mode resolution,
 * telemetry config, widgets, prompt/resource services, and token/client resolution. Constructs
 * exactly one {@link LegacyMcpServer} (2025-era adapter) and delegates all v1 protocol work to it.
 * Implements {@link StatelessMcpServerHost} for the 2026-07-28 adapter too, but does not construct
 * it — `createStatelessServer` builds one per request from a snapshot this facade hands out.
 */
export class ActorsMcpServer implements LegacyMcpServerHost, StatelessMcpServerHost {
    /**
     * The resolved tool map the instance's own (stateful) connection serves, composed from
     * `toolSources` once the handshake makes mode and client known. A stateless request never
     * reads it — its snapshot re-composes from the sources ({@link createRequestSnapshot}).
     */
    public readonly tools: Map<string, ToolEntry>;
    public readonly options: ActorsMcpServerOptions;
    public readonly actorStore?: ActorStore;
    private _clientContext: McpClientContext | undefined;
    /**
     * Resolved server mode. Preliminary value at construction (`'auto'` → `DEFAULT`).
     * Finalized inside the `initialize` request handler (see {@link applyInitialize}) once the
     * client's capabilities are known. Effectively set-once per connection.
     */
    private _serverMode: SERVER_MODE;
    /**
     * Raw option captured from `options.serverMode` (or the legacy `uiMode`). Re-resolved
     * inside the initialize handler when set to `'auto'`; explicit `'default'`/`'apps'`
     * values bypass auto-detect.
     */
    private readonly serverModeOption: ServerModeOption;
    /** True once the server mode is final (at construction, or after initialize resolves `'auto'`).
     *  Composition waits for it — composing earlier in `'auto'` mode would produce the wrong tool
     *  variants. Distinct from {@link clientKnown}, which only withholds client-gated tools. */
    private serverModeResolved: boolean;
    /**
     * Tool sources queued until composition is possible (`'auto'` mode before initialize),
     * re-composed by the initialize flush once mode and client are known. Each entry keeps the
     * exact actor-tool slice fetched for its input, so the flush composes it against its own list.
     * Keyed like {@link toolSources}: a stateless-only facade never drains this queue, so a reload
     * replaces its entry instead of appending, keeping the queue bounded by distinct inputs.
     */
    private readonly pendingToolsUntilClientKnown = new Map<string, ToolSource>();
    /**
     * The unresolved inputs `tools` is composed from — not a second tool registry. Retained (never
     * drained) so a stateless request, whose identity arrives per request, can compose its own
     * resolved set from the same inputs without touching `tools`. Keyed by input because nothing
     * drains it: a reload replaces its entry instead of appending, bounding the map by distinct
     * inputs instead of growing per reload for the facade's lifetime.
     */
    private readonly toolSources = new Map<string, ToolSource>();

    // Telemetry configuration (resolved from options and env vars, see setupTelemetry)
    public readonly telemetryEnabled: boolean;
    public readonly telemetryEnv: TelemetryEnv;

    // Neutral prompt/resource services; the legacy adapter wires SDK handlers to these.
    public readonly promptService: ReturnType<typeof createPromptService>;
    public readonly resourceService: ReturnType<typeof createResourceService>;

    // List of widgets that are ready to be served
    private availableWidgets: Map<string, AvailableWidget> = new Map();

    /**
     * In-flight or successfully settled widget resolution, memoized so the disk scan runs once. A
     * failed attempt is dropped rather than kept (see {@link resolveWidgetsForMode}).
     */
    private widgetsResolution: Promise<Map<string, AvailableWidget>> | undefined;

    /** Set in the initialize handler once client capabilities are known. */
    public clientSupportsUi = false;

    // The v1 SDK adapter. Package-private: constructed here and never exposed on the public surface.
    private readonly legacyServer: LegacyMcpServer;

    public get clientContext(): McpClientContext | undefined {
        return this._clientContext;
    }

    public get serverMode(): SERVER_MODE {
        return this._serverMode;
    }

    /** The instance's own view: what a stateful connection composes and gates against. */
    private get servingContext(): ServingContext {
        return { serverMode: this._serverMode, clientContext: this._clientContext };
    }

    constructor(options: ActorsMcpServerOptions = {}) {
        this.options = options;
        this._clientContext = buildMcpClientContext(options.initializeRequestData?.params);
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
        this._serverMode = resolveServerMode(this.serverModeOption, false);
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

        this.legacyServer = new LegacyMcpServer(this);
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
     * The shared initialize steps the legacy adapter delegates to before returning
     * `InitializeResult`: refresh client context, capture the raw request for session recovery,
     * resolve `'auto'` mode against client capabilities, flush pending tool sources, resolve
     * widgets. Ordering is load-bearing: mode before compose, compose before instructions, so tool
     * presence reflects the final composed set.
     */
    public async applyInitialize(request: InitializeRequest): Promise<void> {
        this._clientContext = buildMcpClientContext(request.params);
        this.options.initializeRequestData = request;
        this.clientSupportsUi = isUiSupportedByClient(this.clientContext);

        if (this.serverModeOption === 'auto') {
            const resolved = resolveServerMode('auto', this.clientSupportsUi);
            if (resolved !== this._serverMode) {
                this._serverMode = resolved;
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

        await this.resolveInstanceWidgets();
    }

    /**
     * Server instructions for the current connection: mode plus whether report-problem is loaded.
     * Read by the legacy adapter after `applyInitialize`, when the tool set is final.
     */
    public getServerInstructions(): string {
        return getServerInstructions(this.serverMode, this.tools.has(HELPER_TOOLS.PROBLEM_REPORT));
    }

    /**
     * Instructions for a stateless serving unit. The SDK answers `server/discover` from them before
     * any request's envelope is seen, so they are configuration-level: no report-problem mention
     * (that tool's presence is decided per request) and the configured mode only. Reads
     * `serverModeOption`, never `_serverMode` — one facade serves both eras, and a legacy
     * `initialize` rewrites `_serverMode`, which must not leak into later stateless requests.
     */
    public getStatelessServerInstructions(): string {
        return getServerInstructions(resolveServerMode(this.serverModeOption, false));
    }

    /**
     * Build the read-only view one stateless (2026-07-28) request is served from: mode and tool set
     * resolved against *that request's* declared identity, and a resource service bound to both.
     * Nothing request-specific is written back to the facade, so concurrent requests with different
     * identities cannot contaminate each other.
     */
    public async createRequestSnapshot(clientContext: McpClientContext | undefined): Promise<StatelessRequestSnapshot> {
        // From the configured option, not `_serverMode` — same reason as
        // {@link getStatelessServerInstructions}.
        const serverMode = resolveServerMode(this.serverModeOption, isUiSupportedByClient(clientContext));
        const view: ServingContext = { serverMode, clientContext };

        // Re-compose from the retained sources, not the live `tools` map (composed for the
        // instance's own view). Directly upserted tools are deliberately left out — carrying them
        // over would re-add tools this view's gating just withheld.
        const tools = new Map<string, ToolEntry>();
        for (const source of this.toolSources) {
            for (const tool of this.composeToolsForClient(source, view)) {
                const stored = this.toStoredTool(tool);
                tools.set(stored.name, stored);
            }
        }

        const availableWidgets = await this.resolveWidgetsForMode(serverMode);
        return {
            serverMode,
            clientContext,
            tools,
            resourceService: createResourceService({
                paymentProvider: this.options.paymentProvider,
                getMode: () => serverMode,
                getAvailableWidgets: () => availableWidgets,
            }),
            createApifyClient: (token) => this.createApifyClient(token, clientContext),
        };
    }

    /** True once the connecting client is known (set in the initialize handler, or hydrated by a
     *  recovery path). Only client-gated tools wait for this so the per-client blocklist can be
     *  applied; client-agnostic tools compose regardless. */
    private get clientKnown(): boolean {
        return this.clientContext != null;
    }

    /**
     * Compose one source's tool list against `view`: resolve mode-specific tools, then drop
     * report-problem unless servable for that view ({@link isReportProblemServable}). Load paths
     * and the initialize flush pass the instance's own {@link servingContext};
     * {@link createRequestSnapshot} passes a view derived from one stateless request.
     */
    private composeToolsForClient(source: ToolSource, view: ServingContext): ToolEntry[] {
        const tools = getToolsForServerMode(source.input, source.actorTools, view.serverMode);
        if (this.isReportProblemServable(view)) return tools;
        return tools.filter((tool) => tool.name !== HELPER_TOOLS.PROBLEM_REPORT);
    }

    /**
     * Whether report-problem may be served against `view`. Never without telemetry (submissions
     * would vanish into the void) and never before the client is known — on a stateful connection
     * the initialize flush re-adds it if the client allows; a stateless view always names its
     * client, so the answer is final on the spot.
     */
    private isReportProblemServable(view: ServingContext): boolean {
        return (
            this.telemetryEnabled && view.clientContext != null && !isReportProblemBlockedForClient(view.clientContext)
        );
    }

    private composePendingToolsForClient(): void {
        if (this.pendingToolsUntilClientKnown.size === 0) return;

        const tools = [...this.pendingToolsUntilClientKnown.values()].flatMap((source) =>
            this.composeToolsForClient(source, this.servingContext),
        );

        this.pendingToolsUntilClientKnown.clear();

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
     * Buffer-or-compose gate shared by the actor-tools loaders. Mode not resolved yet: queue the
     * source for the initialize flush, upserting the mode-agnostic actor tools immediately. Mode
     * resolved: compose and upsert now; if the client is still unknown, also queue the source so
     * the flush adds the client-gated tools.
     */
    private registerFetchedActorTools(input: Input, actorTools: ToolEntry[]): void {
        const source: ToolSource = { input, actorTools };
        const key = toolSourceKey(input);
        this.toolSources.set(key, source);
        if (!this.serverModeResolved) {
            this.pendingToolsUntilClientKnown.set(key, source);
            if (actorTools.length > 0) this.upsertTools(actorTools);
            return;
        }
        const tools = this.composeToolsForClient(source, this.servingContext);
        if (tools.length > 0) this.upsertTools(tools);
        if (!this.clientKnown) this.pendingToolsUntilClientKnown.set(key, source);
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
     * Two-phase: getActors (async, client-agnostic fetch) then the buffer-or-compose gate.
     * Don't move the getActors await into the initialize handler — clients time out waiting for
     * InitializeResult; the queue buffers already-fetched data, not network work. See #721.
     */
    public async loadToolsFromInput(input: Input, apifyClient: ApifyClient): Promise<void> {
        const actorTools = await getActors(input, apifyClient, {
            actorStore: this.actorStore,
            paymentProvider: this.options.paymentProvider,
        });
        this.registerFetchedActorTools(input, actorTools);
    }

    /**
     * Delete tools from the shared tool map only — the retained load sources stay, so a tool
     * removed this way still appears in every stateless snapshot. No callers today; one that needs
     * a tool gone on both protocol eras has to drop its source too.
     */
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
     * Upsert new tools. Writes the shared tool map directly, bypassing the retained load sources,
     * so a tool added only this way reaches no stateless snapshot. Load through `loadToolsFrom*` /
     * `loadToolsByName` instead to serve a tool on both protocol eras.
     */
    public upsertTools(tools: ToolEntry[]) {
        // Client gating happens earlier, in composeToolsForClient. Do not filter here: this is a
        // low-level commit point reached before the client is known too.
        for (const tool of tools) {
            const stored = this.toStoredTool(tool);
            this.tools.set(stored.name, stored);
        }
        return tools;
    }

    private toStoredTool(tool: ToolEntry): ToolEntry {
        return this.options.paymentProvider ? this.options.paymentProvider.decorateToolSchema(tool) : tool;
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
        return this.createApifyClient(this.resolveApifyToken(params._meta), this.clientContext);
    }

    /** The one place a request-scoped Apify client is constructed, on either protocol era. */
    private createApifyClient(
        token: string | undefined,
        clientContext: McpClientContext | undefined,
    ): ApifyClient | undefined {
        return token ? new ApifyClient({ token, requestOrigin: getRequestOriginForClient(clientContext) }) : undefined;
    }

    /**
     * Widgets servable in `mode`: none outside apps mode, otherwise the disk registry. A successful
     * scan is memoized per facade (a widget file appearing later is not picked up); a failed one is
     * dropped so the next caller retries. Touches no per-connection state, so a per-request caller
     * cannot disturb a concurrent one.
     */
    private async resolveWidgetsForMode(mode: SERVER_MODE): Promise<Map<string, AvailableWidget>> {
        if (mode !== SERVER_MODE.APPS) {
            return new Map();
        }

        // Catch on the shared attempt, not per awaiter: N callers awaiting one rejected scan would
        // otherwise report one root cause N times. Dropping the memo lets the next caller re-run it.
        const resolution = (this.widgetsResolution ??= resolveServableWidgets().catch((error: unknown) => {
            this.widgetsResolution = undefined;
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.softFail(`Failed to resolve widgets: ${errorMessage}`);
            // Continue without widgets
            return new Map<string, AvailableWidget>();
        }));
        return await resolution;
    }

    /**
     * Resolve the instance's own widget map for this connection's mode. The only writer of that
     * field — per-request callers take the map `resolveWidgetsForMode` returns instead.
     */
    private async resolveInstanceWidgets(): Promise<void> {
        this.availableWidgets = await this.resolveWidgetsForMode(this.serverMode);
    }

    async connect(transport: Transport): Promise<void> {
        await this.resolveInstanceWidgets();
        await this.legacyServer.connect(transport);
    }

    async close(): Promise<void> {
        // Transport/server down first, then the tool map. Clearing `tools` leaves the retained
        // sources in place, so a stateless snapshot taken after close still lists every loaded
        // tool. Latent: nothing closes a facade mid-traffic.
        await this.legacyServer.close();
        this.tools.clear();
    }
}
