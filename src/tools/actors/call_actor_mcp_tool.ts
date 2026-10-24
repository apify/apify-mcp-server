import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import { getActorMCPServerPath, getActorMCPServerURL } from '../../mcp/actors.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from '../../mcp/const.js';
import { withRemoteMcpClient } from '../../mcp/remote_tool_call.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
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
        The server connects with the Apify API token. Connecting can start a standby run of the Actor in your account, kept for its idle timeout, or is charged per event when the Actor is multi-tenant. What the tool itself does depends on the Actor.

        Example call: {"actor": "username/name", "tool": "search", "arguments": {"query": "apify"}}

        USAGE:
        - Use when the user asks to call a tool on an Actor's MCP server.

        USAGE EXAMPLES:
        - user_input: Use the search tool of username/name to look up apify
    `;
}

/**
 * Runs one operation on an MCP server Actor's server under the caller's token: resolves the Actor, rejects one
 * without the `mcp` interface before connecting, and turns a failed connection, an abort or a thrown error into
 * a response. `operation` completes "Failed to … on Actor 'name'". Every response after the lookup carries the
 * Actor ID for telemetry.
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
    if (!webServerMcpPath || !resolveActorInterfaces({ definition, actor: info, webServerMcpPath }).mcp) {
        return withActorId(
            respondUserError(`Actor '${actorFullName}' is not an MCP server.`, { detail: 'not an MCP server' }),
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
            return respondRaw(result as CallToolResult);
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
    // A third-party payment provider cannot pay for a standby run, so such a session is rejected before the call.
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
