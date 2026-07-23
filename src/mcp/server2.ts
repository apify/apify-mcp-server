/**
 * Modern-era (MCP 2026-07-28, stateless) registration shell around {@link ActorsMcpServer}.
 *
 * A second, additive registration surface built on the v2 SDK: `tools/list`, `tools/call`,
 * `resources/*` and `prompts/*` call the shared tool-call engine (`tool_call_engine.ts`) and
 * today's unmodified resource/prompt logic. The existing v1-based {@link ActorsMcpServer} class
 * is untouched and keeps serving legacy clients (including Tasks) exactly as before; this shell
 * serves 2026-07-28 traffic only.
 *
 * Everything the legacy dispatcher resolves once at `initialize` is per-request here:
 * - session ID: `ctx.sessionId`, optional (Tasks — the one consumer that requires it — are not
 *   served on this path).
 * - client identity/capabilities/protocol version: the request's `_meta` envelope
 *   (`ctx.mcpReq.envelope`, reserved `io.modelcontextprotocol/*` keys), synthesized into an
 *   initialize-shaped object so the existing client-keyed helpers are reused unchanged.
 * - server mode (MCP Apps vs default): re-resolved per request from the envelope capabilities.
 * - `report-problem` visibility: gated on the request's envelope `clientInfo`.
 * - Apify token: `ctx.http?.authInfo?.token` (server-derived, IAM-validated — set by the hosting
 *   layer), never `_meta.apifyToken`.
 *
 * Four differences from the v1 shell fall out of the stateless spec:
 * - `tasks/*` is not registered (the v2 SDK rejects it `-32601`); `isTaskRequest` is always false.
 * - `InvalidToolCall` throws `ProtocolError(InvalidParams)` (v1 throws `McpError`) with no
 *   `sendLoggingMessage` side-channel: SEP-2577 removed logging on this era.
 * - every result is projected through `server.projectCallToolResult` (v1 returns identity).
 * - client identity, capabilities, mode, and token are per-request, not initialize-scoped.
 *
 * This is a thin shell: it builds per-request inputs, calls `prepareToolCall` then
 * `executeSyncToolCall`, and maps the outcome to the v2 SDK. It does NOT re-implement the
 * prep/dispatch/error-classification spine the engine owns.
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { InitializeRequest, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type {
    CallToolResult as ModernCallToolResult,
    ClientCapabilities as ModernClientCapabilities,
    ListToolsResult as ModernListToolsResult,
    ServerContext,
} from '@modelcontextprotocol/server';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    Server as ModernServer,
} from '@modelcontextprotocol/server';

import log from '@apify/log';

import { ApifyClient } from '../apify_client.js';
import { HELPER_TOOLS, TOOL_STATUS } from '../const.js';
import type { PaymentMeta, RequestHeaders } from '../payments/types.js';
import { prompts } from '../prompts/index.js';
import { createResourceService } from '../resources/resource_service.js';
import { getServerInfo } from '../server_card.js';
import type { CallDiagnostics, ToolStatus } from '../types.js';
import { getRequestOriginForClient } from '../utils/mcp_clients.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { getToolFullName, getToolPublicFieldOnly } from '../utils/tools.js';
import type { ActorsMcpServer } from './server.js';
import { classifyToolCallError, executeSyncToolCall, prepareToolCall } from './tool_call_engine.js';
import { logToolCallAndTelemetry, prepareTelemetryData } from './tool_call_telemetry.js';

/**
 * Typed view of the per-request `_meta` envelope. The published v2 typings flatten
 * `RequestMetaEnvelope` to `{}` (the reserved keys are erased in the beta's .d.mts), so the
 * shape is restated here, keyed by the SDK's own exported meta-key constants.
 */
type RequestEnvelopeView = {
    [PROTOCOL_VERSION_META_KEY]?: string;
    [CLIENT_INFO_META_KEY]?: InitializeRequest['params']['clientInfo'];
    [CLIENT_CAPABILITIES_META_KEY]?: ModernClientCapabilities;
};

/**
 * Synthesize an initialize-shaped request from the per-request envelope so the existing
 * client-keyed helpers (`getRequestOriginForClient`, `isReportProblemServableForClient`,
 * `resolveServerModeForClient`, telemetry fields) are reused unchanged. Returns `undefined`
 * when the request carried no `clientInfo` — the client is unknown for this request
 * (`clientInfo` is SHOULD, not required, on 2026-07-28).
 */
function toInitializeRequestData(ctx: ServerContext): InitializeRequest | undefined {
    const envelope = (ctx.mcpReq.envelope ?? {}) as RequestEnvelopeView;
    const clientInfo = envelope[CLIENT_INFO_META_KEY];
    if (!clientInfo) return undefined;
    return {
        method: 'initialize',
        params: {
            protocolVersion: envelope[PROTOCOL_VERSION_META_KEY] ?? '',
            capabilities: (envelope[CLIENT_CAPABILITIES_META_KEY] ?? {}) as InitializeRequest['params']['capabilities'],
            clientInfo,
        },
    };
}

/** Token sources in order: validated HTTP auth (hosted path) > server-instance option (stdio/dev). */
function resolveApifyTokenForRequest(ctx: ServerContext, apifyMcpServer: ActorsMcpServer): string | undefined {
    return ctx.http?.authInfo?.token || apifyMcpServer.options.token;
}

/**
 * Adapt the v2 handler context to the v1 `RequestHandlerExtra` consumed by the engine and
 * `ToolEntry.call()`. Only `signal` and `sendNotification` are read on this path — the latter
 * is the channel that preserves status/progress notifications (`createProgressTracker`).
 * `sendRequest` has no modern equivalent (2026-07-28 removed server→client requests).
 */
function toRequestHandlerExtra(ctx: ServerContext): RequestHandlerExtra<Request, Notification> {
    return {
        signal: ctx.mcpReq.signal,
        requestId: ctx.mcpReq.id,
        sessionId: ctx.sessionId,
        sendNotification: async (notification: Notification) => {
            await ctx.mcpReq.notify(notification as Parameters<typeof ctx.mcpReq.notify>[0]);
        },
        sendRequest: async () => {
            throw new Error('Server-to-client requests are not available on the 2026-07-28 path');
        },
    } as unknown as RequestHandlerExtra<Request, Notification>;
}

/**
 * Create a v2 {@link ModernServer} serving 2026-07-28 traffic from the given
 * {@link ActorsMcpServer}'s tools, resources and prompts. Stateless by construction — call it
 * per request from a `createMcpHandler` factory (a v2 `Server` binds to one transport).
 * The caller is responsible for `apifyMcpServer.prepare()` having run (widget resolution).
 */
export function createServer2(apifyMcpServer: ActorsMcpServer): ModernServer {
    // Eagerly compose the client-gated tools (report-problem) the v1 path defers to its initialize
    // flush; the stateless modern path never gets that flush, so without this report-problem never
    // enters the tool set and tools/list's per-request filter has nothing to admit. Idempotent.
    apifyMcpServer.composeModernClientGatedTools();

    const server = new ModernServer(getServerInfo(), {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {},
        },
        // Instructions are set once at construction (v2 SDK). Reflect the composed servable set from
        // this.tools — same ground truth v1's initialize handler uses — instead of the static default,
        // so report-problem is advertised when the instance serves it.
        instructions: getServerInstructions(
            apifyMcpServer.serverMode,
            apifyMcpServer.tools.has(HELPER_TOOLS.PROBLEM_REPORT),
        ),
    });

    const resourceServiceFor = (ctx: ServerContext) => {
        const initializeRequestData = toInitializeRequestData(ctx);
        const mode = apifyMcpServer.resolveServerModeForClient(initializeRequestData);
        return createResourceService({
            paymentProvider: apifyMcpServer.options.paymentProvider,
            getMode: () => mode,
            getAvailableWidgets: () => apifyMcpServer.getAvailableWidgets(),
        });
    };

    server.setRequestHandler('tools/list', (_request, ctx) => {
        const initializeRequestData = toInitializeRequestData(ctx);
        const mode = apifyMcpServer.resolveServerModeForClient(initializeRequestData);
        const reportProblemServable = apifyMcpServer.isReportProblemServableForClient(initializeRequestData);
        const tools = Array.from(apifyMcpServer.tools.values())
            .filter((tool) => reportProblemServable || tool.name !== HELPER_TOOLS.PROBLEM_REPORT)
            .map((tool) => getToolPublicFieldOnly(tool, { mode, filterWidgetMeta: true }));
        return { tools } as ModernListToolsResult;
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
        const { params } = request;
        const { name } = params;
        // Keep telemetry on the decoded arguments.
        let args = params.arguments as Record<string, unknown> | undefined;
        const meta = params._meta;
        const progressToken = meta?.progressToken;
        const mcpSessionId = ctx.sessionId;
        const apifyToken = resolveApifyTokenForRequest(ctx, apifyMcpServer) as string;
        const initializeRequestData = toInitializeRequestData(ctx);
        const extra = toRequestHandlerExtra(ctx);
        const requestHeaders: RequestHeaders = ctx.http?.req
            ? Object.fromEntries(ctx.http.req.headers.entries())
            : undefined;
        const startTime = Date.now();
        let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
        let callDiagnostics: CallDiagnostics = {};
        let resolvedToolName = name;
        // The measured result: the engine's neutral outcome before v2 projection (matches v1).
        let toolResult: unknown = null;
        let actorName: string | undefined;
        let actorId: string | undefined;

        // Start with the raw name so early failures still have telemetry.
        const { telemetryData, userId } = await prepareTelemetryData({
            toolName: name,
            mcpSessionId,
            apifyToken,
            apifyMcpServer,
            initializeRequestData,
        });

        try {
            const prepared = await prepareToolCall({
                apifyMcpServer,
                apifyToken,
                name,
                args,
                meta: meta as PaymentMeta,
                requestHeaders,
                isTaskRequest: false,
                mcpSessionId,
                telemetryData,
                extra,
                initializeRequestData,
            });

            if ('result' in prepared) {
                // The engine already classified this post-resolution failure.
                resolvedToolName = prepared.resolvedToolName;
                args = prepared.decodedArgs;
                toolStatus = prepared.toolStatus;
                callDiagnostics = prepared.callDiagnostics;
                toolResult = prepared.result;
                return server.projectCallToolResult(prepared.result as ModernCallToolResult, undefined);
            }

            if ('message' in prepared) {
                // Reproduce v1's invalid-params tail (server-side softFail + preserved telemetry),
                // but throw a v2 ProtocolError instead of McpError and drop the client-facing
                // logging notification: SEP-2577 removed logging on this era.
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
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, prepared.message);
            }

            const { tool } = prepared;
            actorName = prepared.actorName;
            actorId = prepared.actorId;
            resolvedToolName = getToolFullName(tool);
            // Telemetry uses the decoded arguments.
            args = prepared.decodedArgs;

            // Sync path: run the shared dispatch tail and project its neutral outcome.
            const outcome = await executeSyncToolCall(prepared, {
                apifyMcpServer,
                apifyToken,
                toolName: name,
                mcpSessionId,
                progressToken,
                extra,
            });
            toolStatus = outcome.toolStatus;
            callDiagnostics = outcome.callDiagnostics;
            toolResult = outcome.result;
            // Project against the tool's output schema only for a genuine success; error and
            // pre-flight outcomes carry no schema-conformant structuredContent.
            const outputSchema = outcome.toolStatus === TOOL_STATUS.SUCCEEDED ? tool.outputSchema : undefined;
            return server.projectCallToolResult(outcome.result as ModernCallToolResult, outputSchema);
        } catch (error) {
            // Re-throw protocol errors as JSON-RPC errors; classify other failures with actor context.
            if (error instanceof ProtocolError) {
                throw error;
            }
            // The shared engine's protocol-error escape hatch throws a v1 McpError (e.g. the
            // tool_dispatch exhaustiveness guard); it is already a JSON-RPC error, so map it to the
            // v2 equivalent rather than reclassifying it into an isError result — mirrors v1's catch.
            if (error instanceof McpError) {
                throw new ProtocolError(error.code, error.message);
            }
            const outcome = classifyToolCallError(error, {
                apifyMcpServer,
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
            return server.projectCallToolResult(outcome.result as ModernCallToolResult, undefined);
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
                apifyMcpServer,
            });
        }
    });

    server.setRequestHandler('resources/list', async (_request, ctx) => {
        return await resourceServiceFor(ctx).listResources();
    });

    server.setRequestHandler('resources/read', async (request, ctx) => {
        const token = resolveApifyTokenForRequest(ctx, apifyMcpServer);
        // Token-scoped client for the API proxy, same token-only rule as the legacy path: a
        // payment-only session (no Apify token) has no client and every read fails by design.
        const apifyClient = token
            ? new ApifyClient({ token, requestOrigin: getRequestOriginForClient(toInitializeRequestData(ctx)) })
            : undefined;
        return await resourceServiceFor(ctx).readResource(request.params.uri, apifyClient);
    });

    server.setRequestHandler('resources/templates/list', async (_request, ctx) => {
        return await resourceServiceFor(ctx).listResourceTemplates();
    });

    server.setRequestHandler('prompts/list', () => {
        return { prompts };
    });

    server.setRequestHandler('prompts/get', (request) => {
        const { name, arguments: args } = request.params;
        const prompt = prompts.find((p) => p.name === name);
        if (!prompt) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Prompt ${name} not found. Available prompts: ${prompts.map((p) => p.name).join(', ')}`,
            );
        }
        if (!prompt.ajvValidate(args)) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Invalid arguments for prompt ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(prompt.ajvValidate.errors)}`,
            );
        }
        return {
            description: prompt.description,
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: prompt.render(args || {}),
                    },
                },
            ],
        };
    });

    return server;
}
