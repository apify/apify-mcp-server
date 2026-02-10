import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema, ServerNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ActorCallOptions } from 'apify-client';

import log from '@apify/log';

import { createApifyClientWithSkyfireSupport } from '../apify-client.js';
import { TOOL_STATUS } from '../const.js';
import { callActorGetDataset } from '../tools/index.js';
import type { ToolEntry, ToolStatus } from '../types.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { logHttpError, redactSkyfirePayId } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { createProgressTracker } from '../utils/progress.js';
import { validateSkyfirePayId } from '../utils/skyfire.js';
import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from './const.js';
import type { ActorsMcpServer } from './server.js';

type ExecuteToolForCallParams = {
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: string;
    progressToken: string | number | undefined;
    extra: RequestHandlerExtra<Request, Notification>;
    mcpSessionId: string;
    userRentedActorIds?: string[];
    apifyMcpServer: ActorsMcpServer;
    mcpServer: Server;
};

type ExecuteToolForTaskParams = {
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: string;
    progressToken: string | number | undefined;
    extra: RequestHandlerExtra<Request, Notification>;
    mcpSessionId: string | undefined;
    userRentedActorIds?: string[];
    apifyMcpServer: ActorsMcpServer;
    mcpServer: Server;
    taskId: string;
};

type ToolExecutionForCallResult = {
    handled: boolean;
    response?: Record<string, unknown>;
    toolStatus: ToolStatus;
};

type ToolExecutionForTaskResult = {
    response: Record<string, unknown>;
    toolStatus: ToolStatus;
};

/**
 * Executes a tool for standard MCP tool calls.
 */
export async function executeToolForCall(params: ExecuteToolForCallParams): Promise<ToolExecutionForCallResult> {
    const {
        tool,
        args,
        apifyToken,
        progressToken,
        extra,
        mcpSessionId,
        userRentedActorIds,
        apifyMcpServer,
        mcpServer,
    } = params;

    // Centralized skyfire validation for tools that require it
    if (tool.requiresSkyfirePayId) {
        const skyfireError = validateSkyfirePayId(apifyMcpServer, args);
        if (skyfireError) {
            return {
                handled: true,
                response: skyfireError,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            };
        }
    }

    // Handle internal tool
    if (tool.type === 'internal') {
        // Only create progress tracker for call-actor tool
        const progressTracker = tool.name === 'call-actor'
            ? createProgressTracker(progressToken, extra.sendNotification)
            : null;

        log.info('Calling internal tool', { name: tool.name, mcpSessionId, input: redactSkyfirePayId(args) });
        const res = await tool.call({
            args,
            extra,
            apifyMcpServer,
            mcpServer,
            apifyToken,
            userRentedActorIds,
            progressTracker,
            mcpSessionId,
        }) as object;

        if (progressTracker) {
            progressTracker.stop();
        }

        // If tool provided internal status, use it; otherwise infer from isError flag
        const { internalToolStatus, ...rest } = res as { internalToolStatus?: ToolStatus; isError?: boolean };
        if (internalToolStatus !== undefined) {
            return {
                handled: true,
                response: { ...rest },
                toolStatus: internalToolStatus,
            };
        }
        if ('isError' in rest && rest.isError) {
            return {
                handled: true,
                response: { ...rest },
                toolStatus: TOOL_STATUS.FAILED,
            };
        }

        // Never expose internal _toolStatus field to MCP clients
        return {
            handled: true,
            response: { ...rest },
            toolStatus: TOOL_STATUS.SUCCEEDED,
        };
    }

    if (tool.type === 'actor-mcp') {
        let client: Client | null = null;
        try {
            client = await connectMCPClient(tool.serverUrl, apifyToken, mcpSessionId);
            if (!client) {
                const msg = `Failed to connect to MCP server at "${tool.serverUrl}".
Please verify the server URL is correct and accessible, and ensure you have a valid Apify token with appropriate permissions.`;
                log.softFail(msg, { mcpSessionId, statusCode: 408 }); // 408 Request Timeout
                await mcpServer.sendLoggingMessage({ level: 'error', data: msg });
                return {
                    handled: true,
                    response: buildMCPResponse({ texts: [msg], isError: true }),
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                };
            }

            // Only set up notification handlers if progressToken is provided by the client
            if (progressToken) {
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

            log.info('Calling Actor-MCP', { actorId: tool.actorId, toolName: tool.originToolName, mcpSessionId, input: redactSkyfirePayId(args) });
            const res = await client.callTool({
                name: tool.originToolName,
                arguments: args,
                _meta: {
                    progressToken,
                },
            }, CallToolResultSchema, {
                timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
            });

            // For external MCP servers we do not try to infer soft_fail vs failed from isError.
            // We treat the call as succeeded at the telemetry layer unless an actual error is thrown.
            return {
                handled: true,
                response: { ...res },
                toolStatus: TOOL_STATUS.SUCCEEDED,
            };
        } catch (error) {
            logHttpError(error, `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}'`, {
                actorId: tool.actorId,
                toolName: tool.originToolName,
            });
            return {
                handled: true,
                response: buildMCPResponse({
                    texts: [`Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}': ${error instanceof Error ? error.message : String(error)}. The MCP server may be temporarily unavailable.`],
                    isError: true,
                }),
                toolStatus: TOOL_STATUS.FAILED,
            };
        } finally {
            if (client) await client.close();
        }
    }

    // Handle actor tool
    if (tool.type === 'actor') {
        // Create progress tracker if progressToken is available
        const progressTracker = createProgressTracker(progressToken, extra.sendNotification);

        const callOptions: ActorCallOptions = { memory: tool.memoryMbytes };

        const { 'skyfire-pay-id': _skyfirePayId, ...actorArgs } = args as Record<string, unknown>;
        const apifyClient = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

        try {
            log.info('Calling Actor', { actorName: tool.actorFullName, mcpSessionId, input: redactSkyfirePayId(actorArgs) });
            const callResult = await callActorGetDataset({
                actorName: tool.actorFullName,
                input: actorArgs,
                apifyClient,
                callOptions,
                progressTracker,
                abortSignal: extra.signal,
                mcpSessionId,
            });

            if (!callResult) {
                // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                return {
                    handled: true,
                    response: { },
                    toolStatus: TOOL_STATUS.ABORTED,
                };
            }

            const { content, structuredContent } = buildActorResponseContent(tool.actorFullName, callResult);
            return {
                handled: true,
                response: { content, structuredContent },
                toolStatus: TOOL_STATUS.SUCCEEDED,
            };
        } finally {
            if (progressTracker) {
                progressTracker.stop();
            }
        }
    }

    // If we reached here without returning, it means the tool type was not recognized (user error)
    return {
        handled: false,
        toolStatus: TOOL_STATUS.SOFT_FAIL,
    };
}

/**
 * Executes a tool for long-running task mode.
 */
export async function executeToolForTask(params: ExecuteToolForTaskParams): Promise<ToolExecutionForTaskResult> {
    const {
        tool,
        args,
        apifyToken,
        progressToken,
        extra,
        mcpSessionId,
        userRentedActorIds,
        apifyMcpServer,
        mcpServer,
        taskId,
    } = params;

    let response: Record<string, unknown> = {};
    let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;

    // Centralized skyfire validation for tools that require it
    if (tool.requiresSkyfirePayId) {
        const skyfireError = validateSkyfirePayId(apifyMcpServer, args);
        if (skyfireError) {
            response = skyfireError;
            toolStatus = TOOL_STATUS.SOFT_FAIL;
        }
    }

    // Handle internal tool execution in task mode
    if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === 'internal') {
        const progressTracker = createProgressTracker(progressToken, extra.sendNotification, taskId);

        log.info('Calling internal tool for task', { taskId, name: tool.name, mcpSessionId, input: redactSkyfirePayId(args) });
        const res = await tool.call({
            args,
            extra,
            apifyMcpServer,
            mcpServer,
            apifyToken,
            userRentedActorIds,
            progressTracker,
            mcpSessionId,
        }) as object;

        if (progressTracker) {
            progressTracker.stop();
        }

        // If tool provided internal status, use it; otherwise infer from isError flag
        const { internalToolStatus, ...rest } = res as { internalToolStatus?: ToolStatus; isError?: boolean };
        if (internalToolStatus !== undefined) {
            toolStatus = internalToolStatus;
        } else if ('isError' in rest && rest.isError) {
            toolStatus = TOOL_STATUS.FAILED;
        } else {
            toolStatus = TOOL_STATUS.SUCCEEDED;
        }

        response = rest;
    }

    // Handle actor tool execution in task mode
    if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === 'actor') {
        const progressTracker = createProgressTracker(progressToken, extra.sendNotification, taskId);
        const callOptions: ActorCallOptions = { memory: tool.memoryMbytes };
        const { 'skyfire-pay-id': _skyfirePayId, ...actorArgs } = args as Record<string, unknown>;
        const apifyClient = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);

        log.info('Calling Actor for task', { taskId, actorName: tool.actorFullName, mcpSessionId, input: redactSkyfirePayId(actorArgs) });
        const callResult = await callActorGetDataset({
            actorName: tool.actorFullName,
            input: actorArgs,
            apifyClient,
            callOptions,
            progressTracker,
            abortSignal: extra.signal,
            mcpSessionId,
        });

        if (!callResult) {
            toolStatus = TOOL_STATUS.ABORTED;
            response = {};
        } else {
            const { content, structuredContent } = buildActorResponseContent(tool.actorFullName, callResult);
            response = { content, structuredContent };
        }

        if (progressTracker) {
            progressTracker.stop();
        }
    }

    return {
        response,
        toolStatus,
    };
}
