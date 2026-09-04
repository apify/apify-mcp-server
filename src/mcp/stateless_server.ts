/**
 * Adapter for the MCP 2026-07-28 protocol revision
 * (https://modelcontextprotocol.io/specification/2026-07-28), served via the v2 SDK
 * (`@modelcontextprotocol/server`). {@link createStatelessServer} (re-exported from
 * `src/index.ts`) builds one SDK `Server` per request, reading shared Apify state through
 * {@link StatelessMcpServerHost}. Sibling of `legacy_server.ts` (the 2025-era adapter on
 * `@modelcontextprotocol/sdk`), not a layer on top of it.
 *
 * This protocol revision has no `initialize` handshake: every request carries its own `_meta`
 * envelope (protocol version, client info, capabilities), so client identity — and with it
 * `'auto'` mode resolution — is resolved per request instead of from session state.
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
 * mutated afterwards. Concurrent requests with different identities get separate snapshots.
 */
export type StatelessRequestSnapshot = {
    readonly serverMode: SERVER_MODE;
    readonly clientContext: McpClientContext | undefined;
    readonly tools: Map<string, ToolEntry>;
    readonly resourceService: ReturnType<typeof createResourceService>;
    /**
     * Token-scoped Apify client for `resources/read`; `undefined` without a token. Bound by the
     * facade so the adapter stays off the Apify API-client layer.
     */
    readonly createApifyClient: (token: string | undefined) => ApifyClient | undefined;
};

/**
 * Read-facing view of the shared `ActorsMcpServer` facade (sibling of `LegacyMcpServerHost`).
 * Request-scoped state arrives through `createRequestSnapshot`; the rest is construction-time
 * configuration safe to share across requests.
 */
export interface StatelessMcpServerHost {
    readonly actorStore?: ActorStore;
    readonly telemetryEnabled: boolean;
    readonly telemetryEnv: TelemetryEnv;
    readonly options: ActorsMcpServerOptions;
    readonly promptService: ReturnType<typeof createPromptService>;
    resolveApifyToken(meta?: ApifyRequestParams['_meta']): string | undefined;
    getStatelessServerInstructions(requestUrl?: string): string;
    createRequestSnapshot(clientContext: McpClientContext | undefined): Promise<StatelessRequestSnapshot>;
}

/**
 * Map a domain or v1 `McpError` to a v2 `ProtocolError` with the same code/message/data.
 * Any other error is returned unchanged for the caller to rethrow.
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

/** Client identity from the request's validated `_meta` envelope. */
function buildClientContextFromEnvelope(envelope: Record<string, unknown> | undefined): McpClientContext | undefined {
    if (!envelope) return undefined;
    // Same wire shapes as `initialize` carries; the cast only crosses the v2/v1 type boundary.
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
     * The request's snapshot, memoized as a promise so every handler awaits the same composition.
     * Built lazily by whichever handler runs first — there is no `initialize` to hook.
     */
    private snapshot: Promise<StatelessRequestSnapshot> | undefined;

    constructor(host: StatelessMcpServerHost, requestUrl?: string) {
        this.host = host;
        this.server = new Server(getServerInfo(), {
            capabilities: {
                // Deliberately no `tasks` (tasks/* → method-not-found), no `logging` (deprecated by SEP-2577), no
                // `tools.listChanged` (never originated; `tool_dispatch.ts` only relays a proxied Actor-MCP server's).
                // TODO: the SDK answers `subscriptions/listen` upstream of our handlers and opens a
                // stream that can never emit; the dev server closes it per request, a long-lived
                // host does not. Refusing the method outright is a follow-up.
                tools: {},
                resources: {},
                prompts: {},
            },
            instructions: this.host.getStatelessServerInstructions(requestUrl),
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
     * Token precedence: server-validated `authInfo` from the serving entry, then the facade's own
     * chain (`_meta.apifyToken` > `options.token`).
     */
    private resolveRequestToken(ctx: ServerContext, meta?: ApifyRequestParams['_meta']): string | undefined {
        return ctx.http?.authInfo?.token || this.host.resolveApifyToken(meta);
    }

    private setupToolHandlers(): void {
        this.server.setRequestHandler('tools/list', async (_request, ctx) => {
            const snapshot = await this.resolveSnapshot(ctx);
            const presentTools = new Set(snapshot.tools.keys());
            const tools = Array.from(snapshot.tools.values()).map((tool) =>
                getToolPublicFieldOnly(tool, { mode: snapshot.serverMode, filterWidgetMeta: true, presentTools }),
            );
            // Tool entries carry the same public fields as the SDK's `Tool`; type-boundary cast only.
            return { tools } as unknown as ListToolsResult;
        });

        this.server.setRequestHandler('tools/call', async (request, ctx) => {
            const params = request.params as ApifyRequestParams & { name: string; arguments?: Record<string, unknown> };
            // Keep telemetry on the decoded arguments.
            const { name, arguments: initialArgs, _meta: meta } = params;
            let args = initialArgs;
            const progressToken = meta?.progressToken;
            const snapshot = await this.resolveSnapshot(ctx);
            const apifyToken = this.resolveRequestToken(ctx, meta) as string;
            // No session on this path; logs and telemetry report the id empty.
            const mcpSessionId = undefined;
            const startTime = Date.now();
            let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
            let callDiagnostics: CallDiagnostics = {};
            let resolvedToolName = name;
            let toolResult: unknown = null;
            let actorName: string | undefined;
            let actorId: string | undefined;
            // Resolved up front (same rule as `prepareToolCall`) so every return path — including
            // pre-dispatch failures — projects with the schema this request advertised. Only this
            // call shell projects results. This is inert today: the 2026-07-28 codec discards the
            // schema, while the codec that reads it only re-wraps non-object structured content,
            // which no tool emits.
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
     * Run a tool result through the SDK's wire codec, as every low-level `tools/call` author must
     * (SEP-2106 §4.3 text auto-append; `structuredContent` re-shaping is legacy-only).
     */
    private projectResult(result: Record<string, unknown>, outputSchema: ToolEntry['outputSchema']) {
        return this.server.projectCallToolResult(
            result as CallToolResult,
            outputSchema as Readonly<Record<string, unknown>> | undefined,
        );
    }

    /**
     * Forwards engine-emitted notifications (progress, Actor-MCP relays) onto this request's
     * response stream. v2 refuses notifications its era does not define or whose capability we did
     * not declare — a refusal must never fail the tool call, so it is logged and dropped.
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
 * Server-side log for Actor-MCP connect failures: no `logging` capability is declared, so there is
 * no client-visible `notifications/message` to send. The text reaches the client in the result body
 * or protocol error.
 */
async function emitLogServerSide(msg: { level: string; data?: unknown }): Promise<void> {
    log.softFail('Tool call reported a failure', { level: msg.level, errMessage: String(msg.data) });
}

/**
 * Build the v2 SDK `Server` that serves one 2026-07-28 request from the shared facade. Pass it as
 * the factory of the SDK's serving entry, which calls it once per request:
 *
 * ```ts
 * const handler = createMcpHandler(() => createStatelessServer(actorsMcpServer), { legacy: 'reject' });
 * ```
 *
 * `requestUrl` sharpens the served instructions' cross-tool mentions (`call-actor`, Actor tools);
 * omit it for the same, tool-blind fallback.
 */
export function createStatelessServer(host: StatelessMcpServerHost, requestUrl?: string): Server {
    return new StatelessMcpServer(host, requestUrl).server;
}
