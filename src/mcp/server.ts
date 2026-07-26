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
 * The resolved mode plus client identity a composition or gating decision is made against. Passing it
 * as a parameter is what lets a caller compose against a view other than the instance's own (see
 * `servingContext`) — one derived from a single request — without mutating the shared facade.
 */
type ServingContext = {
    readonly serverMode: SERVER_MODE;
    readonly clientContext: McpClientContext | undefined;
};

/**
 * Read the widget registry from disk. Module-level and mode-agnostic: the result depends only on
 * what is on disk, so a successful read can be resolved once and shared (see
 * {@link ActorsMcpServer.resolveWidgetsForMode}). Rejects on a failed scan, so the caller can tell
 * that apart from a successful empty registry.
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
 * Create Apify MCP server.
 *
 * The shared-Apify-behavior facade: it owns the tool registry + loaders, server-mode resolution,
 * `actorStore`, telemetry config, widgets, prompt/resource services, and token/client resolution,
 * and constructs exactly one {@link LegacyMcpServer} (the v1 SDK adapter), delegating all v1
 * protocol work to it. It implements {@link LegacyMcpServerHost} so the adapter reads shared state
 * through a narrow contract, and {@link StatelessMcpServerHost} for the 2026-07-28 adapter — which
 * it does not construct: a stateless serving unit is built per request by `createStatelessServer`,
 * from a snapshot this facade hands out.
 */
export class ActorsMcpServer implements LegacyMcpServerHost, StatelessMcpServerHost {
    /**
     * The resolved tool map the instance's own (sessionful) connection serves, composed from
     * `toolSources` once the legacy handshake makes mode and client known. A stateless request
     * never reads it: its identity arrives with the request, after this map is composed, so its
     * snapshot re-composes from the sources instead ({@link createRequestSnapshot}).
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
    private pendingToolsUntilClientKnown: ToolSource[] = [];
    /**
     * The unresolved inputs `tools` is composed from — not a second tool registry. `tools` holds one
     * resolved output: the instance's own view, fixed once the connection handshake makes the client
     * known. Retaining every source (never drained) lets a caller whose mode and client identity
     * arrive with a single request compose its own resolved set from the same inputs, without
     * touching `tools`. The same objects the pending queue holds; retention also keeps the fetched
     * actor-tool arrays alive for the facade's lifetime.
     */
    private readonly toolSources: ToolSource[] = [];

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

    /** The instance's own view: what a sessionful connection composes and gates against. */
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
     * Instructions for a stateless serving unit. The SDK answers `server/discover` from them at
     * construction time, before any request's envelope is seen, so they are configuration-level: the
     * configured mode (generic guidance while it is `'auto'`, since no client is known yet) and no
     * report-problem mention, because that tool's presence is decided per request long after this
     * string is frozen. Gating itself is unaffected — see {@link createRequestSnapshot}.
     *
     * From `serverModeOption`, never `_serverMode`: a legacy `initialize` rewrites that field in
     * place, and one facade serves both eras, so reading it would let one legacy client's resolved
     * mode decide what every later stateless request is told.
     */
    public getStatelessServerInstructions(): string {
        return getServerInstructions(resolveServerMode(this.serverModeOption, false));
    }

    /**
     * Build the read-only view one stateless (2026-07-28) request is served from: mode resolved
     * against *that request's* declared UI capability, the tool set composed against that same
     * identity (so report-problem gating is applied per request), and a resource service bound to
     * both. Nothing request-specific is written back to the facade — the only instance field this
     * touches is the identity-independent widget-resolution memo — so two concurrent requests
     * declaring different identities cannot contaminate each other.
     */
    public async createRequestSnapshot(clientContext: McpClientContext | undefined): Promise<StatelessRequestSnapshot> {
        // From the configured option, not `_serverMode` — same reason as
        // {@link getStatelessServerInstructions}.
        const serverMode = resolveServerMode(this.serverModeOption, isUiSupportedByClient(clientContext));
        const view: ServingContext = { serverMode, clientContext };

        // Re-compose from the retained sources, not the live `tools` map: that map was composed for
        // the instance's own view. Directly upserted tools are deliberately left out — carrying them
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
     * report-problem unless it is servable for that view (see {@link isReportProblemServable}). It is
     * a default-injected tool rather than a category member, so servability is gated here; every
     * other tool composes eagerly, so a recovery load without an initialize still restores it.
     *
     * Three callers. The input-driven load paths and the initialize flush pass the instance's own
     * {@link servingContext}, where report-problem is withheld until the client is known and re-added
     * by the flush; {@link createRequestSnapshot} passes a view derived from one stateless request.
     */
    private composeToolsForClient(source: ToolSource, view: ServingContext): ToolEntry[] {
        const tools = getToolsForServerMode(source.input, source.actorTools, view.serverMode);
        if (this.isReportProblemServable(view)) return tools;
        return tools.filter((tool) => tool.name !== HELPER_TOOLS.PROBLEM_REPORT);
    }

    /**
     * Whether report-problem may be served against `view`:
     * - Its only function is forwarding submissions via telemetry, so it is never servable when
     *   telemetry is disabled (it would just fake an acknowledgement into the void).
     * - It cannot be judged until the client is known, so it is withheld while `view` has none. On a
     *   sessionful connection the initialize flush re-composes and adds it if the client allows; a
     *   stateless request's view always names its client, so the answer is final on the spot.
     * Every other tool is unconditionally servable, so recovery loads compose them eagerly and they
     * survive a load that never sees an initialize.
     */
    private isReportProblemServable(view: ServingContext): boolean {
        return (
            this.telemetryEnabled && view.clientContext != null && !isReportProblemBlockedForClient(view.clientContext)
        );
    }

    private composePendingToolsForClient(): void {
        if (this.pendingToolsUntilClientKnown.length === 0) return;

        const tools = this.pendingToolsUntilClientKnown.flatMap((source) =>
            this.composeToolsForClient(source, this.servingContext),
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
        const source: ToolSource = { input, actorTools };
        this.toolSources.push(source);
        if (!this.serverModeResolved) {
            this.pendingToolsUntilClientKnown.push(source);
            if (actorTools.length > 0) this.upsertTools(actorTools);
            return;
        }
        const tools = this.composeToolsForClient(source, this.servingContext);
        if (tools.length > 0) this.upsertTools(tools);
        if (!this.clientKnown) this.pendingToolsUntilClientKnown.push(source);
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

    /**
     * Delete tools from the server.
     *
     * Deletes from the shared tool map only, leaving the retained load sources in place, so a tool
     * removed this way still appears in every stateless snapshot ({@link createRequestSnapshot}) —
     * the more dangerous direction of the {@link upsertTools} divergence. No callers today; one that
     * needs a tool gone on both protocol eras has to drop its source too.
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
     * Upsert new tools.
     *
     * Writes the shared tool map directly, bypassing the retained load sources, so a tool added only
     * this way reaches no stateless snapshot ({@link createRequestSnapshot}). Load through
     * `loadToolsFrom*` / `loadToolsByName` instead to serve a tool on both protocol eras.
     *
     * @param tools - Array of tool wrappers to add or update
     * @returns Array of added/updated tool wrappers
     */
    public upsertTools(tools: ToolEntry[]) {
        // Client gating (e.g. hiding report-problem from Anthropic surfaces) is applied earlier, in
        // composeToolsForClient — the single compose choke point where the client is known. Do not
        // filter here: this is a low-level commit point reached before the client is known too.
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
     * scan is resolved once per facade and shared; a failed one is dropped so the next caller retries
     * it (widget files not written yet must stay recoverable) and serves an empty registry. Touches no
     * per-connection state, so a per-request caller cannot disturb a concurrent one.
     *
     * Memoizing a success is a deliberate behavior change, not behavior-preserving restructuring: an
     * explicitly-`apps` facade used to scan disk — and log "Ready widgets" / "Some widgets are not
     * ready" — twice, from `connect()` and again from `applyInitialize()`, and now scans once; and a
     * widget file appearing after a successful scan is no longer picked up.
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
     * Resolve the instance's own widget map — what the instance `resourceService` reads through its
     * getter — for this connection's mode. The only writer of that field: a caller resolving widgets
     * for another view takes the map `resolveWidgetsForMode` returns and leaves the instance alone.
     */
    private async resolveInstanceWidgets(): Promise<void> {
        this.availableWidgets = await this.resolveWidgetsForMode(this.serverMode);
    }

    async connect(transport: Transport): Promise<void> {
        await this.resolveInstanceWidgets();
        await this.legacyServer.connect(transport);
    }

    async close(): Promise<void> {
        // Reverse-of-connect (LIFO) teardown: take the transport/server down first (SIGINT removal +
        // server close are the adapter's transport-lifecycle responsibility), then clear the shared
        // tool map. The order is unobservable because `close()` only runs on a quiesced serving unit.
        // Clearing `tools` leaves the retained sources in place, so a stateless snapshot taken after
        // this still lists every loaded tool, re-composed from those sources — the third face of the
        // `upsertTools` / `removeToolsByName` divergence. Latent: nothing closes a facade mid-traffic.
        await this.legacyServer.close();
        this.tools.clear();
    }
}
