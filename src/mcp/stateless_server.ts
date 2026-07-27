/**
 * The 2026-07-28 SDK adapter and the package's public registration surface for it:
 * {@link createStatelessServer} (re-exported from `src/index.ts`) builds one v2 SDK `Server` per
 * request, with its handlers and its error/notification projection, reading shared Apify state
 * through {@link StatelessMcpServerHost}. The class behind the factory is module-private — unlike
 * `legacy_server.ts`, whose adapter is exported for the facade to construct.
 *
 * Sibling of `legacy_server.ts`, not a layer on top of it. There is no handshake on this protocol
 * revision: every request carries its own `_meta` envelope (protocol version, client info, client
 * capabilities), so client identity — and with it `'auto'` mode resolution and report-problem
 * visibility — is resolved per request from that envelope instead of from remembered session state.
 */

import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ListToolsResult, Notification, ServerContext } from '@modelcontextprotocol/server';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from '@modelcontextprotocol/server';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { TOOL_STATUS } from '../const.js';
import type { createPromptService } from '../prompts/prompt_service.js';
import type { createResourceService } from '../resources/resource_service.js';
import { getServerInfo } from '../server_card.js';
import type {
    ActorsMcpServerOptions,
    ActorStore,
    ApifyRequestParams,
    CallDiagnostics,
    SERVER_MODE,
    TelemetryEnv,
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { isMcpError } from '../utils/tool_status.js';
import { getToolFullName, getToolPublicFieldOnly } from '../utils/tools.js';
import { buildMcpClientContext } from './client_context.js';
import type { McpClientContext } from './client_context.js';
import { InternalError, InvalidParamsError } from './errors.js';
import { classifyToolCallError, executeSyncToolCall, prepareToolCall, resolveToolEntry } from './tool_call_engine.js';
import { logToolCallAndTelemetry, prepareTelemetryData } from './tool_call_telemetry.js';

/**
 * Everything one 2026-07-28 request is served from, derived once from the shared facade and never
 * mutated afterwards. Two concurrent requests declaring different identities get two snapshots, so
 * neither can see the other's resolved mode or tool set.
 */
export type StatelessRequestSnapshot = {
    readonly serverMode: SERVER_MODE;
    readonly clientContext: McpClientContext | undefined;
    readonly tools: Map<string, ToolEntry>;
    readonly resourceService: ReturnType<typeof createResourceService>;
    /**
     * Token-scoped Apify client for `resources/read`, tagged with this request's own origin;
     * `undefined` without a token. Bound by the facade, which owns client construction, so the
     * adapter stays off the Apify API-client layer.
     */
    readonly createApifyClient: (token: string | undefined) => ApifyClient | undefined;
};

/**
 * Read-facing view of the shared `ActorsMcpServer` facade that the stateless adapter depends on.
 * The sibling of `LegacyMcpServerHost`: same one-directional coupling, and the adapter never sees
 * the concrete facade class. Everything request-scoped arrives through `createRequestSnapshot`;
 * the rest is construction-time configuration that is safe to share across requests.
 */
export interface StatelessMcpServerHost {
    readonly actorStore?: ActorStore;
    readonly telemetryEnabled: boolean;
    readonly telemetryEnv: TelemetryEnv;
    readonly options: ActorsMcpServerOptions;
    readonly promptService: ReturnType<typeof createPromptService>;
    resolveApifyToken(meta?: ApifyRequestParams['_meta']): string | undefined;
    getStatelessServerInstructions(): string;
    createRequestSnapshot(clientContext: McpClientContext | undefined): Promise<StatelessRequestSnapshot>;
}

/**
 * Stateless protocol boundary: project a service's domain error to its v2 `ProtocolError`, copying
 * `message` and `data` unchanged. A v1 `McpError` raised by the shared tool-call engine (which still
 * speaks v1 protocol errors) is re-coded onto the v2 wire with its JSON-RPC code intact. Any other
 * error is returned unchanged, for the caller to rethrow — the SDK renders it as a JSON-RPC error.
 */
function toStatelessProtocolError(error: unknown): unknown {
    if (error instanceof InvalidParamsError) {
        return new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, error.data);
    }
    if (error instanceof InternalError) {
        return new ProtocolError(ProtocolErrorCode.InternalError, error.message, error.data);
    }
    if (isMcpError(error)) {
        return new ProtocolError(error.code, error.message, error.data);
    }
    return error;
}

/** Whether an error must stay a JSON-RPC error response instead of becoming a tool result. */
function isProtocolLevelError(error: unknown): boolean {
    return error instanceof ProtocolError || isMcpError(error);
}

/**
 * Client identity declared by one request, read from the validated `_meta` envelope the SDK lifted
 * out of `params._meta`. Absent only when a request carries no envelope at all, which the serving
 * entry does not let onto this path.
 */
function buildClientContextFromEnvelope(envelope: Record<string, unknown> | undefined): McpClientContext | undefined {
    if (!envelope) return undefined;
    // The envelope's client info/capabilities are the same runtime objects `initialize` carries;
    // this cast only crosses the v2/v1 type boundary of two identical wire shapes.
    return buildMcpClientContext({
        protocolVersion: envelope[PROTOCOL_VERSION_META_KEY],
        clientInfo: envelope[CLIENT_INFO_META_KEY],
        capabilities: envelope[CLIENT_CAPABILITIES_META_KEY],
    } as Parameters<typeof buildMcpClientContext>[0]);
}

/**
 * v2 SDK adapter. One per request: `createMcpHandler` calls its factory for every incoming request
 * and discards the instance afterwards.
 */
class StatelessMcpServer {
    public readonly server: Server;
    private readonly host: StatelessMcpServerHost;
    /**
     * The single request's snapshot, memoized as a promise so every handler awaits the same
     * composition. There is no `initialize` to hook on this revision, so the snapshot is built
     * lazily by whichever handler runs first — and no other handler can race ahead of it.
     */
    private snapshot: Promise<StatelessRequestSnapshot> | undefined;

    constructor(host: StatelessMcpServerHost) {
        this.host = host;
        this.server = new Server(getServerInfo(), {
            capabilities: {
                // No `tasks` (so `tasks/*` falls through to the SDK's method-not-found), no
                // `logging` (deprecated by SEP-2577, and declaring it is what would let
                // `notifications/message` be sent), and no `tools.listChanged` — a per-request
                // instance can never push one.
                // TODO: `subscriptions/listen` is out of scope here, but registering no handler does
                // not refuse it — the SDK's serving entry answers that method upstream of our
                // handlers and opens a subscription stream honoring none of the capabilities below,
                // so it can never emit. The dev server closes it in its per-request `finally`; a
                // long-lived host (internal #676) has nothing that does. Refusing the method
                // outright is a follow-up.
                tools: {},
                resources: {},
                prompts: {},
            },
            instructions: this.host.getStatelessServerInstructions(),
        });
        this.setupToolHandlers();
        this.setupResourceHandlers();
        this.setupPromptHandlers();
    }

    /** Snapshot for this request, resolved from the identity the request itself declared. */
    private async resolveSnapshot(ctx: ServerContext): Promise<StatelessRequestSnapshot> {
        this.snapshot ??= this.host.createRequestSnapshot(
            buildClientContextFromEnvelope(ctx.mcpReq.envelope as Record<string, unknown> | undefined),
        );
        return await this.snapshot;
    }

    /**
     * Token sources in order: the auth info the serving entry received from its caller (validated
     * server-side, so it outranks anything the client wrote), then the shared facade's own chain
     * (`_meta.apifyToken` > `options.token`).
     */
    private resolveRequestToken(ctx: ServerContext, meta?: ApifyRequestParams['_meta']): string | undefined {
        return ctx.http?.authInfo?.token || this.host.resolveApifyToken(meta);
    }

    private setupToolHandlers(): void {
        this.server.setRequestHandler('tools/list', async (_request, ctx) => {
            const snapshot = await this.resolveSnapshot(ctx);
            const tools = Array.from(snapshot.tools.values()).map((tool) =>
                getToolPublicFieldOnly(tool, { mode: snapshot.serverMode, filterWidgetMeta: true }),
            );
            // Our tool entries carry the same public fields as the SDK's `Tool`; the cast only
            // crosses the boundary between the two descriptions of one wire shape.
            return { tools } as unknown as ListToolsResult;
        });

        this.server.setRequestHandler('tools/call', async (request, ctx) => {
            const params = request.params as ApifyRequestParams & { name: string; arguments?: Record<string, unknown> };
            // Keep telemetry on the decoded arguments.
            // eslint-disable-next-line prefer-const
            let { name, arguments: args, _meta: meta } = params;
            const progressToken = meta?.progressToken;
            const snapshot = await this.resolveSnapshot(ctx);
            const apifyToken = this.resolveRequestToken(ctx, meta) as string;
            // No session exists on this path, so there is no session id to thread anywhere: log
            // lines and telemetry take `undefined` and report it empty.
            const mcpSessionId = undefined;
            const startTime = Date.now();
            let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
            let callDiagnostics: CallDiagnostics = {};
            let resolvedToolName = name;
            let toolResult: unknown = null;
            let actorName: string | undefined;
            let actorId: string | undefined;
            // Resolved up front, by the same rule `prepareToolCall` resolves the tool by, so every
            // return path passes the schema this request advertised for the named tool — including
            // the pre-dispatch failures that return before the engine hands the tool back. This is
            // the only `tools/call` shell that projects; the legacy one returns engine results raw.
            // Inert today either way: the 2026-07-28 codec discards the argument, and the v2 codec
            // that does read it only re-wraps a non-object `structuredContent`, which no tool emits.
            const outputSchema = resolveToolEntry(name, snapshot.tools)?.outputSchema;
            const { clientContext } = snapshot;
            const { paymentProvider, allowUnauthMode } = this.host.options;
            const { signal } = ctx.mcpReq;

            // Start with the raw name so early failures still have telemetry.
            const { telemetryData, userId } = await prepareTelemetryData({
                toolName: name,
                mcpSessionId,
                apifyToken,
                clientContext,
                telemetryEnabled: this.host.telemetryEnabled,
                transportType: this.host.options.transportType,
            });

            try {
                const prepared = await prepareToolCall({
                    apifyToken,
                    name,
                    args,
                    meta,
                    requestHeaders: Object.fromEntries(ctx.http?.req?.headers ?? []),
                    // The 2026-07-28 revision has no task requests; this path is always synchronous.
                    isTaskRequest: false,
                    mcpSessionId,
                    telemetryData,
                    clientContext,
                    tools: snapshot.tools,
                    paymentProvider,
                    allowUnauthMode,
                    signal,
                });

                if ('result' in prepared) {
                    // The engine already classified this post-resolution failure.
                    resolvedToolName = prepared.resolvedToolName;
                    args = prepared.decodedArgs;
                    toolStatus = prepared.toolStatus;
                    callDiagnostics = prepared.callDiagnostics;
                    toolResult = prepared.result;
                    return this.projectResult(prepared.result, outputSchema);
                }

                if ('message' in prepared) {
                    resolvedToolName = prepared.resolvedToolName ?? resolvedToolName;
                    if (prepared.decodedArgs) args = prepared.decodedArgs;
                    toolStatus = prepared.toolStatus;
                    callDiagnostics = prepared.callDiagnostics;
                    log.softFail(prepared.message, {
                        failureCategory: prepared.callDiagnostics.failure_category,
                        actorName: prepared.callDiagnostics.actor_name,
                        validationKeyword: prepared.callDiagnostics.validation_keyword,
                        validationPath: prepared.callDiagnostics.validation_path,
                        validationMissingProperty: prepared.callDiagnostics.validation_missing_property,
                        validationAdditionalProperty: prepared.callDiagnostics.validation_additional_property,
                        ...prepared.logFields,
                    });
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, prepared.message);
                }

                const { tool } = prepared;
                actorName = prepared.actorName;
                actorId = prepared.actorId;
                resolvedToolName = getToolFullName(tool);
                // Telemetry uses the decoded arguments.
                args = prepared.decodedArgs;

                const outcome = await executeSyncToolCall(prepared, {
                    apifyToken,
                    toolName: name,
                    mcpSessionId,
                    progressToken,
                    tools: snapshot.tools,
                    actorStore: this.host.actorStore,
                    paymentProvider,
                    signal,
                    sendNotification: this.buildNotificationForwarder(ctx),
                    emitLog: emitLogServerSide,
                });
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                toolResult = outcome.result;
                return this.projectResult(outcome.result, outputSchema);
            } catch (error) {
                if (isProtocolLevelError(error)) throw toStatelessProtocolError(error);
                const outcome = classifyToolCallError(error, {
                    tools: snapshot.tools,
                    toolName: name,
                    failingToolName: resolvedToolName,
                    actorName,
                    actorId,
                    isAborted: Boolean(signal.aborted),
                    mcpSessionId,
                });
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                toolResult = outcome.result;
                return this.projectResult(outcome.result, outputSchema);
            } finally {
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
                    telemetryEnv: this.host.telemetryEnv,
                });
            }
        });
    }

    /**
     * Run a tool result through the SDK's wire codec, as every low-level `tools/call` author must:
     * the projection lives in the codec, not here — on this era the SEP-2106 §4.3 text auto-append
     * (`structuredContent` re-shaping is legacy-only).
     */
    private projectResult(result: Record<string, unknown>, outputSchema: ToolEntry['outputSchema']) {
        return this.server.projectCallToolResult(
            result as CallToolResult,
            outputSchema as Readonly<Record<string, unknown>> | undefined,
        );
    }

    /**
     * Forwards a notification the shared engine emits (progress, plus whatever an Actor-MCP tool
     * relays from a remote 2025-era server) onto this request's response stream.
     *
     * The parameter type is the shared engine's v1 `ServerNotification`; v2's `notify` takes a
     * structurally identical `Notification`, so the cast only crosses the two SDKs' type boundary.
     * v2 refuses a notification that its era does not define or whose capability we did not declare
     * (`notifications/message`, since `logging` is undeclared) — a relayed notification must never
     * fail the tool call, so a refusal is logged and dropped.
     */
    private buildNotificationForwarder(ctx: ServerContext): (notification: ServerNotification) => Promise<void> {
        return async (notification) => {
            try {
                await ctx.mcpReq.notify(notification as unknown as Notification);
            } catch (error) {
                log.softFail('Dropped an outbound notification the 2026-07-28 revision does not serve', {
                    method: notification.method,
                    errMessage: error instanceof Error ? error.message : String(error),
                });
            }
        };
    }

    private setupResourceHandlers(): void {
        this.server.setRequestHandler('resources/list', async (_request, ctx) => {
            return await (await this.resolveSnapshot(ctx)).resourceService.listResources();
        });

        this.server.setRequestHandler('resources/templates/list', async (_request, ctx) => {
            return await (await this.resolveSnapshot(ctx)).resourceService.listResourceTemplates();
        });

        this.server.setRequestHandler('resources/read', async (request, ctx) => {
            const snapshot = await this.resolveSnapshot(ctx);
            const params = request.params as ApifyRequestParams & { uri: string };
            try {
                return await snapshot.resourceService.readResource(
                    params.uri,
                    snapshot.createApifyClient(this.resolveRequestToken(ctx, params._meta)),
                );
            } catch (error) {
                throw toStatelessProtocolError(error);
            }
        });
    }

    private setupPromptHandlers(): void {
        const { promptService } = this.host;
        this.server.setRequestHandler('prompts/list', () => promptService.listPrompts());
        this.server.setRequestHandler('prompts/get', (request) => {
            const params = request.params as { name: string; arguments?: Record<string, string> };
            try {
                return promptService.getPrompt(params.name, params.arguments);
            } catch (error) {
                throw toStatelessProtocolError(error);
            }
        });
    }
}

/**
 * The side channel the shared engine uses for Actor-MCP connect failures. A stateless request
 * declares no `logging` capability, so there is no client-visible `notifications/message` to send;
 * the same text already reaches the client in the result body or the protocol error.
 */
async function emitLogServerSide(msg: { level: string; data?: unknown }): Promise<void> {
    log.softFail('Tool call reported a failure', { level: msg.level, errMessage: String(msg.data) });
}

/**
 * Build the v2 SDK `Server` that serves one 2026-07-28 request from the shared facade.
 *
 * Pass this as (or from) the factory of the SDK's serving entry — `createMcpHandler` calls the
 * factory once per request:
 *
 * ```ts
 * const handler = createMcpHandler(() => createStatelessServer(actorsMcpServer), { legacy: 'reject' });
 * ```
 */
export function createStatelessServer(host: StatelessMcpServerHost): Server {
    return new StatelessMcpServer(host).server;
}
