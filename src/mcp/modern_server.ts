/**
 * Modern-era (MCP 2026-07-28, stateless) registration shell around {@link ActorsMcpServer}.
 *
 * A second, additive registration surface built on the v2 SDK: `tools/list`, `tools/call`,
 * `resources/*` and `prompts/*` call today's unmodified tool/resource/prompt logic. The
 * existing v1-based {@link ActorsMcpServer} class is untouched and keeps serving legacy
 * clients (including Tasks) exactly as before; this shell serves 2026-07-28 traffic only.
 *
 * Everything the legacy dispatcher resolves once at `initialize` is per-request here:
 * - session ID: `ctx.sessionId`, optional (logging-only; Tasks — the one consumer that
 *   requires it — are not served on this path).
 * - client identity/capabilities/protocol version: the request's `_meta` envelope
 *   (`ctx.mcpReq.envelope`, reserved `io.modelcontextprotocol/*` keys), synthesized into an
 *   initialize-shaped object so the existing client-keyed helpers are reused unchanged.
 * - server mode (MCP Apps vs default): re-resolved per request from the envelope capabilities.
 * - `clientKnown` (gates `report-problem`): envelope `clientInfo` present on this request.
 * - Apify token: `ctx.http?.authInfo?.token` (server-derived, IAM-validated — set by the
 *   hosting layer via the SDK's `req.auth` pass-through), never `_meta.apifyToken`.
 *
 * Tasks are not registered: the v2 SDK's 2026-07-28 method registry has no `tasks/*` entries,
 * so those calls are rejected `-32601` by the SDK itself. `notifications/logging` is gone on
 * this era too, so the legacy `sendLoggingMessage` side-channel is intentionally not ported.
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { InitializeRequest, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
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
import dedent from 'dedent';

import log from '@apify/log';

import { ApifyClient } from '../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../const.js';
import { prepareToolCallContext } from '../payments/helpers.js';
import type { PaymentMeta } from '../payments/types.js';
import { prompts } from '../prompts/index.js';
import { createResourceService } from '../resources/resource_service.js';
import { getServerInfo } from '../server_card.js';
import { decodeDotPropertyNames } from '../tools/actor_input_schema.js';
import { legacyToolNameToNew } from '../tools/actor_tool_naming.js';
import { checkPaymentProviderStandbyConflict } from '../tools/actors/call_actor.js';
import { withReportProblemNudge } from '../tools/dev/report_problem.js';
import type { CallDiagnostics, ToolStatus } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { logHttpError } from '../utils/logging.js';
import { respondOk } from '../utils/mcp.js';
import { getRequestOriginForClient } from '../utils/mcp_clients.js';
import { createProgressTracker } from '../utils/progress.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { extractAjvErrorDetails } from '../utils/tool_status.js';
import {
    buildActorFields,
    extractActorId,
    extractActorName,
    getToolFullName,
    getToolPublicFieldOnly,
} from '../utils/tools.js';
import type { ActorsMcpServer } from './server.js';
import { buildPreflightFailureOutcome } from './server.js';
import { buildToolCallErrorResult, TOOL_CALL_ERROR_KIND } from './tool_call_error_mapper.js';
import type { ToolCallErrorResult } from './tool_call_error_mapper.js';
import { logToolCallAndTelemetry, prepareTelemetryData } from './tool_call_telemetry.js';
import { dispatchToolCall } from './tool_dispatch.js';

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
 * Adapt the v2 handler context to the v1 `RequestHandlerExtra` consumed by `dispatchToolCall`
 * and `ToolEntry.call()`. Only `signal` and `sendNotification` are read on this path
 * (`sendRequest` has no modern equivalent — 2026-07-28 removed server→client requests).
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
export function createModernServer(apifyMcpServer: ActorsMcpServer): ModernServer {
    const server = new ModernServer(getServerInfo(), {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {},
        },
        instructions: getServerInstructions(apifyMcpServer.serverMode),
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
        let args = params.arguments;
        // Reserved envelope keys are already lifted out; what remains carries e.g. progressToken
        // and provider payment fields, exactly like the legacy `_meta`.
        const meta = params._meta;
        const progressToken = meta?.progressToken;
        const mcpSessionId = ctx.sessionId;
        const apifyToken = resolveApifyTokenForRequest(ctx, apifyMcpServer) as string;
        const initializeRequestData = toInitializeRequestData(ctx);
        const extra = toRequestHandlerExtra(ctx);
        const startTime = Date.now();
        let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
        let callDiagnostics: CallDiagnostics = {};
        let resolvedToolName = name;
        let toolResult: unknown = null;
        const captureResult = <T>(r: T): T => {
            const augmented = withReportProblemNudge({
                result: r,
                tools: apifyMcpServer.tools,
                failingToolName: resolvedToolName,
                failureCategory: callDiagnostics.failure_category,
                failureHttpStatus: callDiagnostics.failure_http_status,
            });
            toolResult = augmented;
            return augmented;
        };
        const failInvalidParams = (
            message: string,
            details: CallDiagnostics,
            logFields?: Record<string, unknown>,
        ): never => {
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
            // No `sendLoggingMessage` side-channel here: SEP-2577 removed logging on this era.
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
        };

        const { telemetryData, userId } = await prepareTelemetryData({
            toolName: name,
            mcpSessionId,
            apifyToken,
            apifyMcpServer,
            initializeRequestData,
        });

        let actorName: string | undefined;
        let actorId: string | undefined;

        try {
            if (
                !apifyToken &&
                !apifyMcpServer.options.paymentProvider?.allowsUnauthenticated &&
                !apifyMcpServer.options.allowUnauthMode
            ) {
                failInvalidParams(
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

            const newName = legacyToolNameToNew(name) ?? name;
            const toolEntry = Array.from(apifyMcpServer.tools.values()).find(
                (t) => t.name === newName || getToolFullName(t) === newName,
            );

            if (!toolEntry) {
                const availableTools = apifyMcpServer.listToolNames();
                failInvalidParams(
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
            if (telemetryData) {
                telemetryData.tool_name = resolvedToolName;
            }

            actorName = extractActorName(tool, args as Record<string, unknown>);
            actorId = extractActorId(tool);
            callDiagnostics = { ...callDiagnostics, ...buildActorFields(actorName, actorId) };

            if (!args) {
                failInvalidParams(
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

            args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;

            const requestHeaders = ctx.http?.req ? Object.fromEntries(ctx.http.req.headers.entries()) : undefined;
            const {
                toolArgsWithoutPayment: toolArgs,
                toolArgsRedacted: logSafeArgs,
                apifyClient,
                paymentRequiredResult,
            } = prepareToolCallContext({
                provider: apifyMcpServer.options.paymentProvider,
                tool,
                args: args as Record<string, unknown>,
                apifyToken,
                meta: meta as PaymentMeta,
                requestHeaders,
                requestOrigin: getRequestOriginForClient(initializeRequestData),
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
                failInvalidParams(
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

            const { paymentProvider } = apifyMcpServer.options;
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

            if (standbyRejection || paymentRequiredResult) {
                const outcome = buildPreflightFailureOutcome(
                    standbyRejection,
                    paymentRequiredResult,
                    actorName,
                    actorId,
                );
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                return server.projectCallToolResult(
                    captureResult(outcome.result) as ModernCallToolResult,
                    tool.outputSchema,
                );
            }

            const progressTrackerOptIn =
                tool.type === TOOL_TYPE.ACTOR ||
                (tool.type === TOOL_TYPE.INTERNAL &&
                    (tool.name === HELPER_TOOLS.ACTOR_CALL || tool.name === HELPER_TOOLS.ACTOR_RUNS_GET));
            const progressTracker = progressTrackerOptIn
                ? createProgressTracker(progressToken, extra.sendNotification)
                : null;

            const dispatchResult = await dispatchToolCall({
                tool,
                toolArgs: toolArgs!,
                logSafeArgs,
                apifyToken,
                apifyClient: apifyClient!,
                apifyMcpServer,
                mcpSessionId,
                progressToken,
                progressTracker,
                shouldForwardNotifications: true,
                extra,
                actorName,
                actorId,
                taskMode: false,
            });
            toolStatus = dispatchResult.toolStatus;
            callDiagnostics = dispatchResult.callDiagnostics;
            return server.projectCallToolResult(
                captureResult(dispatchResult.result) as ModernCallToolResult,
                tool.outputSchema,
            );
        } catch (error) {
            // Re-throw protocol errors (e.g. from failInvalidParams) so the SDK returns them as
            // JSON-RPC errors; callDiagnostics already carries the semantic category.
            if (error instanceof ProtocolError) {
                throw error;
            }

            const errorResult = buildToolCallErrorResult(error, {
                toolName: name,
                actorName,
                actorId,
                isAborted: Boolean(extra.signal?.aborted),
            });
            toolStatus = errorResult.toolStatus;

            switch (errorResult.kind) {
                case TOOL_CALL_ERROR_KIND.PAYMENT: {
                    callDiagnostics = errorResult.callDiagnostics;
                    return server.projectCallToolResult(
                        captureResult(errorResult.response) as ModernCallToolResult,
                        undefined,
                    );
                }
                case TOOL_CALL_ERROR_KIND.APPROVAL: {
                    callDiagnostics = errorResult.callDiagnostics;
                    logHttpError(error, 'Permission approval required while calling tool', {
                        toolName: name,
                        mcpSessionId,
                    });
                    return server.projectCallToolResult(
                        captureResult(errorResult.response) as ModernCallToolResult,
                        undefined,
                    );
                }
                case TOOL_CALL_ERROR_KIND.EXECUTION: {
                    callDiagnostics = {
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
                    // Unlike the legacy handler, no `toolTelemetry` rides the wire here: that leak
                    // is preserved on v1 for byte-compatibility only, and this surface is new.
                    return server.projectCallToolResult(
                        captureResult({
                            ...respondOk(errorResult.userText),
                            isError: true,
                        }) as ModernCallToolResult,
                        undefined,
                    );
                }
                default:
                    // Compile-time exhaustiveness guard (same `satisfies never` idiom as
                    // dispatchToolCall's default arm). Unreachable at runtime.
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Unknown tool-call error kind "${(errorResult satisfies never as ToolCallErrorResult).kind}"`,
                    );
            }
        } finally {
            logToolCallAndTelemetry({
                toolName: resolvedToolName,
                mcpSessionId,
                toolStatus,
                startTime,
                telemetryData,
                userId,
                callDiagnostics,
                args: args as Record<string, unknown> | undefined,
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
