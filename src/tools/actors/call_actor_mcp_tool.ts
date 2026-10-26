import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../../mcp/actors.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../mcp/const.js';
import { withRemoteMcpClient } from '../../mcp/remote_tool_call.js';
import type {
    ActorInterfaces,
    InternalToolArgs,
    ToolDescriptionContext,
    ToolEntry,
    ToolInputSchema,
} from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { getActorDefinitionCached } from '../../utils/actor.js';
import { compileSchema } from '../../utils/ajv.js';
import { remoteMcpFailureDetail } from '../../utils/apify_errors.js';
import { logHttpError } from '../../utils/logging.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondRaw, respondServerError, respondUserError } from '../../utils/mcp.js';
import { resolveActorInterfaces } from '../actor_tool_naming.js';
import { anyJsonObjectSchema } from '../structured_output_schemas.js';
import { fixActorNameInputAndLog } from './actor_tools_factory.js';
import { buildActorNotFoundResponse } from './fetch_actor_details.js';

const callActorMcpToolArgs = z.object({
    actor: z.string().min(1).describe('The MCP server Actor: its ID, or its name in the "username/name" form.'),
    tool: z.string().min(1).describe("The name of the tool on the Actor's MCP server."),
    arguments: anyJsonObjectSchema
        .optional()
        .describe("The tool's arguments, matching its input schema. Omit for a tool that takes none."),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const details = hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS)
        ? `\n${HELPER_TOOLS.ACTOR_GET_DETAILS} with output.mcpTools lists the Actor's MCP tools and their input schemas.`
        : '';
    return dedent`
        Call one tool on an Actor's MCP server and return its result.${details}
        It connects with your Apify API token. Connecting can start a Server Actor run in your account, kept until its idle timeout; a multi-tenant Server Actor charges per event. What the tool itself does depends on the Actor.

        Example call: {"actor": "username/name", "tool": "search", "arguments": {"query": "apify"}}

        USAGE:
        - Use when the user asks to call a tool on an Actor's MCP server.

        USAGE EXAMPLES:
        - user_input: Use the search tool of username/name to look up apify
    `;
}

/** Rejection for an Actor that is not an MCP server, pointing at the tool that serves its interface when there is one. */
function buildNotMcpServerText(
    actorFullName: string,
    { input, server }: ActorInterfaces,
    loadedToolNames: readonly string[],
): string {
    const text = `Actor '${actorFullName}' is not an MCP server.`;
    if (server && loadedToolNames.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST)) {
        return `${text} Its HTTP API can be called with ${HELPER_TOOLS.ACTOR_SERVER_REQUEST}.`;
    }
    if (input && loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)) {
        return `${text} It can be run from an input with ${HELPER_TOOLS.ACTOR_CALL}.`;
    }
    return text;
}

/**
 * Runs one operation on an MCP server Actor's server under the caller's token: resolves the Actor, rejects one
 * without the `mcp` interface before connecting, and turns a failed connection, an abort or a thrown error into
 * a response. `operation` completes "Failed to … on Actor 'name'". Every response after the lookup, except an
 * abort, carries the Actor ID for telemetry.
 */
export async function runOnActorMcpServer(
    toolArgs: InternalToolArgs,
    params: { actor: string; operation: string; run: (client: Client) => Promise<ToolResponse> },
): Promise<ToolResponse> {
    const { apifyToken, apifyClient, mcpSessionId, loadedToolNames, signal } = toolArgs;
    if (!apifyToken) {
        return respondUserError(
            "An Apify API token is required: the connection to the Actor's MCP server carries it.",
            {
                category: FAILURE_CATEGORY.AUTH,
            },
        );
    }
    const actorName = fixActorNameInputAndLog(params.actor, { mcpSessionId });
    const cached = await getActorDefinitionCached(actorName, apifyClient);
    if (!cached) return buildActorNotFoundResponse(actorName, loadedToolNames);
    const { definition, info } = cached;
    const { actorFullName } = definition;
    const withActorId = (response: ToolResponse): ToolResponse => ({
        ...response,
        toolTelemetry: { ...response.toolTelemetry, actorId: info.id },
    });

    const webServerMcpPath = getActorMCPServerPath(definition);
    const interfaces = resolveActorInterfaces({ definition, actor: info, webServerMcpPath });
    if (!webServerMcpPath || !interfaces.mcp) {
        return withActorId(
            respondUserError(buildNotMcpServerText(actorFullName, interfaces, loadedToolNames), {
                detail: 'not an MCP server',
            }),
        );
    }
    let serverUrl: string;
    try {
        serverUrl = await getActorMCPServerURL(info, webServerMcpPath);
    } catch (error) {
        return withActorId(respondServerError((error as Error).message));
    }
    if (signal.aborted) return respondAborted();

    const outcome = await withRemoteMcpClient(
        serverUrl,
        { token: apifyToken, requestOrigin: apifyClient.requestOrigin },
        mcpSessionId,
        signal,
        params.run,
    );
    switch (outcome.outcome) {
        case 'connect-failed':
            return withActorId(respondServerError(`Failed to connect to MCP server ${serverUrl}`));
        case 'aborted':
            return respondAborted();
        case 'error':
            logHttpError(outcome.error, `Failed to ${params.operation} on Actor '${actorFullName}'`, {
                actorName: actorFullName,
            });
            return withActorId(
                respondServerError(
                    `Failed to ${params.operation} on Actor '${actorFullName}': ${remoteMcpFailureDetail(outcome.error)}`,
                    { error: outcome.error },
                ),
            );
        case 'success':
            return withActorId(outcome.value);
    }
}

export async function executeCallActorMcpTool(toolArgs: InternalToolArgs): Promise<ToolResponse> {
    const parsed = callActorMcpToolArgs.parse(toolArgs.args);
    return runOnActorMcpServer(toolArgs, {
        actor: parsed.actor,
        operation: `call MCP tool '${parsed.tool}'`,
        run: async (client) => {
            // `toolTelemetry` is this server's internal channel, so a remote result must not set it.
            const { toolTelemetry: _remoteTelemetry, ...result } = await client.callTool(
                { name: parsed.tool, arguments: parsed.arguments ?? {} },
                CallToolResultSchema,
                { timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, signal: toolArgs.signal },
            );
            const response = respondRaw(result as CallToolResult);
            if (!result.isError) return response;
            // The remote reports no cause, so this is recorded like a proxied Actor MCP tool's error.
            return {
                ...response,
                toolTelemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR },
            };
        },
    });
}

/** Calls one tool on an MCP server Actor and passes its `CallToolResult` through. */
export const callActorMcpTool: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_MCP_TOOL_CALL,
    title: 'Call Actor MCP tool',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(callActorMcpToolArgs) as ToolInputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(callActorMcpToolArgs)),
    // A third-party payment provider cannot pay for a Server Actor run, so such a session is rejected before the call.
    hasPaymentProviderStandbyCheck: true,
    annotations: {
        title: 'Call Actor MCP tool',
        readOnlyHint: false,
        // What the remote tool does is up to the Actor.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    call: async (toolArgs: InternalToolArgs) => executeCallActorMcpTool(toolArgs),
} as const);
