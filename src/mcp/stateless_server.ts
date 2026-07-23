/** MCP 2026-07-28 registration shell around {@link ActorsMcpServer}. */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { InitializeRequest, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type {
    CallToolResult as StatelessCallToolResult,
    ClientCapabilities as StatelessClientCapabilities,
    ListToolsResult as StatelessListToolsResult,
    ServerContext,
} from '@modelcontextprotocol/server';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    Server as StatelessServer,
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

type RequestEnvelopeView = {
    [PROTOCOL_VERSION_META_KEY]?: string;
    [CLIENT_INFO_META_KEY]?: InitializeRequest['params']['clientInfo'];
    [CLIENT_CAPABILITIES_META_KEY]?: StatelessClientCapabilities;
};

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

function resolveApifyTokenForRequest(ctx: ServerContext, apifyMcpServer: ActorsMcpServer): string | undefined {
    return ctx.http?.authInfo?.token || apifyMcpServer.options.token;
}

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

/** Create a stateless server backed by an {@link ActorsMcpServer}. */
export function createStatelessServer(apifyMcpServer: ActorsMcpServer): StatelessServer {
    const initialTools = apifyMcpServer.composeStatelessClientGatedTools(apifyMcpServer.serverMode);

    const server = new StatelessServer(getServerInfo(), {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {},
        },
        instructions: getServerInstructions(apifyMcpServer.serverMode, initialTools.has(HELPER_TOOLS.PROBLEM_REPORT)),
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
        const requestTools = apifyMcpServer.composeStatelessClientGatedTools(mode);
        if (!reportProblemServable) requestTools.delete(HELPER_TOOLS.PROBLEM_REPORT);
        const tools = Array.from(requestTools.values()).map((tool) =>
            getToolPublicFieldOnly(tool, { mode, filterWidgetMeta: true }),
        );
        return { tools } as StatelessListToolsResult;
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
        const { params } = request;
        const { name } = params;
        let args = params.arguments as Record<string, unknown> | undefined;
        const meta = params._meta;
        const progressToken = meta?.progressToken;
        const mcpSessionId = ctx.sessionId;
        const apifyToken = resolveApifyTokenForRequest(ctx, apifyMcpServer) as string;
        const initializeRequestData = toInitializeRequestData(ctx);
        const mode = apifyMcpServer.resolveServerModeForClient(initializeRequestData);
        const requestTools = apifyMcpServer.composeStatelessClientGatedTools(mode);
        if (!apifyMcpServer.isReportProblemServableForClient(initializeRequestData)) {
            requestTools.delete(HELPER_TOOLS.PROBLEM_REPORT);
        }
        const extra = toRequestHandlerExtra(ctx);
        const requestHeaders: RequestHeaders = ctx.http?.req
            ? Object.fromEntries(ctx.http.req.headers.entries())
            : undefined;
        const startTime = Date.now();
        let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
        let callDiagnostics: CallDiagnostics = {};
        let resolvedToolName = name;
        let toolResult: unknown = null;
        let actorName: string | undefined;
        let actorId: string | undefined;

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
                tools: requestTools,
            });

            if ('result' in prepared) {
                resolvedToolName = prepared.resolvedToolName;
                args = prepared.decodedArgs;
                toolStatus = prepared.toolStatus;
                callDiagnostics = prepared.callDiagnostics;
                toolResult = prepared.result;
                return server.projectCallToolResult(prepared.result as StatelessCallToolResult, undefined);
            }

            if ('message' in prepared) {
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
            args = prepared.decodedArgs;

            const outcome = await executeSyncToolCall(prepared, {
                apifyMcpServer,
                apifyToken,
                toolName: name,
                mcpSessionId,
                progressToken,
                extra,
                tools: requestTools,
            });
            toolStatus = outcome.toolStatus;
            callDiagnostics = outcome.callDiagnostics;
            toolResult = outcome.result;
            // Project against the tool's output schema only for a genuine success; error and
            // pre-flight outcomes carry no schema-conformant structuredContent.
            const outputSchema = outcome.toolStatus === TOOL_STATUS.SUCCEEDED ? tool.outputSchema : undefined;
            return server.projectCallToolResult(outcome.result as StatelessCallToolResult, outputSchema);
        } catch (error) {
            if (error instanceof ProtocolError) {
                throw error;
            }
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
                tools: requestTools,
            });
            toolStatus = outcome.toolStatus;
            callDiagnostics = outcome.callDiagnostics;
            toolResult = outcome.result;
            return server.projectCallToolResult(outcome.result as StatelessCallToolResult, undefined);
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
