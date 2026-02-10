import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import { ALLOWED_TASK_TOOL_EXECUTION_MODES, HelperTools } from '../const.js';
import { decodeDotPropertyNames } from '../tools/utils.js';
import type { ActorsMcpServerOptions, ApifyRequestParams, ToolEntry } from '../types.js';

type ToolCallTaskParams = {
    ttl?: number;
};

type ToolCallRequestParams = ApifyRequestParams & {
    name: string;
    arguments?: Record<string, unknown>;
    task?: ToolCallTaskParams;
};

export type ValidatedToolCall = {
    name: string;
    args: Record<string, unknown>;
    tool: ToolEntry;
    apifyToken: string;
    progressToken: string | number | undefined;
    userRentedActorIds?: string[];
    mcpSessionId: string;
    task?: ToolCallTaskParams;
};

type ValidateAndPrepareToolCallParams = {
    request: {
        params: ToolCallRequestParams;
    };
    options: ActorsMcpServerOptions;
    tools: Map<string, ToolEntry>;
    server: Server;
    listToolNames: () => string[];
};

/**
 * Validates tool call request and returns normalized data needed for execution.
 */
export async function validateAndPrepareToolCall({
    request,
    options,
    tools,
    server,
    listToolNames,
}: ValidateAndPrepareToolCallParams): Promise<ValidatedToolCall> {
    // eslint-disable-next-line prefer-const
    let { name, arguments: args, _meta: meta } = request.params;
    const progressToken = meta?.progressToken;
    const metaApifyToken = meta?.apifyToken;
    const apifyToken = (metaApifyToken || options.token || process.env.APIFY_TOKEN) as string;
    const userRentedActorIds = meta?.userRentedActorIds;
    // mcpSessionId was injected upstream it is important and required for long running tasks as the store uses it and there is not other way to pass it
    const mcpSessionId = meta?.mcpSessionId;
    if (!mcpSessionId) {
        log.error('MCP Session ID is missing in tool call request. This should never happen.');
        throw new Error('MCP Session ID is required for tool calls');
    }

    // Validate token
    if (!apifyToken && !options.skyfireMode && !options.allowUnauthMode) {
        const msg = `Apify API token is required but was not provided.
Please set the APIFY_TOKEN environment variable or pass it as a parameter in the request header as Authorization Bearer <token>.
You can obtain your Apify token from https://console.apify.com/account/integrations.`;
        log.softFail(msg, { mcpSessionId, statusCode: 400 });
        await server.sendLoggingMessage({ level: 'error', data: msg });
        throw new McpError(
            ErrorCode.InvalidParams,
            msg,
        );
    }

    // Claude is saving tool names with 'local__' prefix, name is local__apify-actors__compass-slash-crawler-google-places
    // We are interested in the Actor name only, so we remove the 'local__apify-actors__' prefix
    if (name.startsWith('local__')) {
        // we split the name by '__' and take the last part, which is the actual Actor name
        const parts = name.split('__');
        log.debug('Tool name with prefix detected', { toolName: name, lastPart: parts[parts.length - 1], mcpSessionId });
        if (parts.length > 1) {
            name = parts[parts.length - 1];
        }
    }
    // TODO - if connection is /mcp client will not receive notification on tool change
    // Find tool by name or actor full name
    const tool = Array.from(tools.values())
        .find((registeredTool) => registeredTool.name === name || (registeredTool.type === 'actor' && registeredTool.actorFullName === name));
    if (!tool) {
        const availableTools = listToolNames();
        const msg = `Tool "${name}" was not found.
Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
Please verify the tool name is correct. You can list all available tools using the tools/list request.`;
        log.softFail(msg, { mcpSessionId, statusCode: 404 });
        await server.sendLoggingMessage({ level: 'error', data: msg });
        throw new McpError(
            ErrorCode.InvalidParams,
            msg,
        );
    }
    if (!args) {
        const msg = `Missing arguments for tool "${name}".
Please provide the required arguments for this tool. Check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool to see what parameters are required.`;
        log.softFail(msg, { mcpSessionId, statusCode: 400 });
        await server.sendLoggingMessage({ level: 'error', data: msg });
        throw new McpError(
            ErrorCode.InvalidParams,
            msg,
        );
    }
    // Decode dot property names in arguments before validation,
    // since validation expects the original, non-encoded property names.
    args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;
    log.debug('Validate arguments for tool', { toolName: tool.name, mcpSessionId, input: args });
    if (!tool.ajvValidate(args)) {
        const errors = tool?.ajvValidate.errors || [];
        const errorMessages = errors.map((error: { message?: string; instancePath?: string }) => `${error.instancePath || 'root'}: ${error.message || 'validation error'}`).join('; ');
        const msg = `Invalid arguments for tool "${tool.name}".
Validation errors: ${errorMessages}.
Please check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool and ensure all required parameters are provided with correct types and values.`;
        log.softFail(msg, { mcpSessionId, statusCode: 400 });
        await server.sendLoggingMessage({ level: 'error', data: msg });
        throw new McpError(
            ErrorCode.InvalidParams,
            msg,
        );
    }
    // Check if tool call is a long running task and the tool supports that
    // Cast to allowed task mode types ('optional' | 'required') for type-safe includes() check
    const taskSupport = tool.execution?.taskSupport as typeof ALLOWED_TASK_TOOL_EXECUTION_MODES[number];
    if (request.params.task && !ALLOWED_TASK_TOOL_EXECUTION_MODES.includes(taskSupport)) {
        const msg = `Tool "${tool.name}" does not support long running task calls.
Please remove the "task" parameter from the tool call request or use a different tool that supports long running tasks.`;
        log.softFail(msg, { mcpSessionId, statusCode: 400 });
        await server.sendLoggingMessage({ level: 'error', data: msg });
        throw new McpError(
            ErrorCode.InvalidParams,
            msg,
        );
    }

    return {
        name,
        args: args as Record<string, unknown>,
        tool,
        apifyToken,
        progressToken,
        userRentedActorIds,
        mcpSessionId,
        task: request.params.task,
    };
}
