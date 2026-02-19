import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

import { ApifyClient, createApifyClientWithSkyfireSupport } from '../../apify-client.js';
import {
    CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG,
    HelperTools,
    TOOL_STATUS,
} from '../../const.js';
import { connectMCPClient } from '../../mcp/client.js';
import type { InternalToolArgs, ToolInputSchema } from '../../types.js';
import { getActorMcpUrlCached } from '../../utils/actor.js';
import { compileSchema } from '../../utils/ajv.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { getActorsAsTools } from './actor-tools-factory.js';

/**
 * Zod schema for call-actor arguments — shared between default and openai variants.
 */
export const callActorArgs = z.object({
    actor: z.string()
        .describe(`The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").

For MCP server Actors, use format "actorName:toolName" to call a specific tool (e.g., "apify/actors-mcp-server:fetch-apify-docs").`),
    input: z.object({}).passthrough()
        .describe('The input JSON to pass to the Actor. Required.'),
    async: z.boolean()
        .optional()
        .describe(`When true: starts the run and returns immediately with runId. When false or not provided: waits for completion and returns results immediately. Default: true when UI mode is enabled (enforced), false otherwise. IMPORTANT: Only set async to true if the user explicitly asks to run the Actor in the background or does not need immediate results. When the user asks for data or results, always use async: false (default) so the results are returned immediately.`),
    previewOutput: z.boolean()
        .optional()
        .describe('When true (default): includes preview items. When false: metadata only (reduces context). Use when fetching fields via get-actor-output.'),
    callOptions: z.object({
        memory: z.number()
            .min(128, 'Memory must be at least 128 MB')
            .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
            .optional()
            .describe(`Memory allocation for the Actor in MB. Must be a power of 2 (e.g., 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768). Minimum: 128 MB, Maximum: 32768 MB (32 GB).`),
        timeout: z.number()
            .min(0, 'Timeout must be 0 or greater')
            .optional()
            .describe(`Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated. Use 0 for infinite timeout (no time limit). Minimum: 0 seconds (infinite).`),
    }).optional()
        .describe('Optional call options for the Actor run configuration.'),
});

/**
 * Compiled AJV input schema — shared between both variants.
 */
export const callActorInputSchema = z.toJSONSchema(callActorArgs) as ToolInputSchema;

/**
 * Compiled AJV validator with additional properties allowed (for Skyfire pay-id).
 */
export const callActorAjvValidate = compileSchema({
    ...z.toJSONSchema(callActorArgs),
    additionalProperties: true,
});

/**
 * Parsed call-actor arguments.
 */
export type CallActorParsedArgs = z.infer<typeof callActorArgs>;

/**
 * Result of resolving actor and MCP URL before execution.
 * Contains everything needed for the mode-specific execution path.
 */
export type CallActorResolvedContext = {
    baseActorName: string;
    mcpToolName: string | undefined;
    isActorMcpServer: boolean;
    mcpServerUrl: string | false;
};

/**
 * Resolves MCP URL and parses the "actor:tool" format.
 * Shared pre-processing step used by both default and openai variants.
 */
export function resolveActorContext(actorName: string): {
    baseActorName: string;
    mcpToolName: string | undefined;
} {
    const mcpToolMatch = actorName.match(/^(.+):(.+)$/);
    if (mcpToolMatch) {
        return {
            baseActorName: mcpToolMatch[1],
            mcpToolName: mcpToolMatch[2],
        };
    }
    return { baseActorName: actorName, mcpToolName: undefined };
}

/**
 * Handles the MCP tool call flow (when actorName contains ":toolName").
 * Returns a response if handled, or null if this is not an MCP tool call.
 */
export async function handleMcpToolCall(params: {
    baseActorName: string;
    mcpToolName: string;
    input: Record<string, unknown>;
    isActorMcpServer: boolean;
    mcpServerUrl: string | false;
    apifyToken: string;
    mcpSessionId?: string;
}): Promise<object | null> {
    const { baseActorName, mcpToolName, input, isActorMcpServer, mcpServerUrl, apifyToken, mcpSessionId } = params;

    if (!isActorMcpServer) {
        return buildMCPResponse({
            texts: [`Actor '${baseActorName}' is not an MCP server.`],
            isError: true,
        });
    }

    if (!input) {
        return buildMCPResponse({
            texts: [`Input is required for MCP tool '${mcpToolName}'. Please provide the input parameter based on the tool's input schema.`],
            isError: true,
        });
    }

    let client: Client | null = null;
    try {
        client = await connectMCPClient(mcpServerUrl as string, apifyToken, mcpSessionId);
        if (!client) {
            return buildMCPResponse({
                texts: [`Failed to connect to MCP server ${mcpServerUrl}`],
                isError: true,
            });
        }

        const result = await client.callTool({
            name: mcpToolName,
            arguments: input,
        });

        return { content: result.content };
    } catch (error) {
        logHttpError(error, `Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}'`, {
            actorName: baseActorName,
            toolName: mcpToolName,
        });
        return buildMCPResponse({
            texts: [`Failed to call MCP tool '${mcpToolName}' on Actor '${baseActorName}': ${error instanceof Error ? error.message : String(error)}. The MCP server may be temporarily unavailable.`],
            isError: true,
        });
    } finally {
        if (client) await client.close();
    }
}

/**
 * Validates the actor and its input, returning the resolved actor tool or an error response.
 * Shared validation logic used by both default and openai execution paths.
 */
export async function resolveAndValidateActor(params: {
    actorName: string;
    input: Record<string, unknown>;
    toolArgs: InternalToolArgs;
}): Promise<{ error: object } | { actor: Awaited<ReturnType<typeof getActorsAsTools>>[0] }> {
    const { actorName, input, toolArgs } = params;
    const apifyClient = createApifyClientWithSkyfireSupport(toolArgs.apifyMcpServer, toolArgs.args, toolArgs.apifyToken);

    const [actor] = await getActorsAsTools([actorName], apifyClient, { mcpSessionId: toolArgs.mcpSessionId });

    if (!actor) {
        return {
            error: buildMCPResponse({
                texts: [`Actor '${actorName}' was not found.
Please verify Actor ID or name format (e.g., "username/name" like "apify/rag-web-browser") and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            }),
        };
    }

    if (!input) {
        const content = [
            `Input is required for Actor '${actorName}'. Please provide the input parameter based on the Actor's input schema.`,
            `The input schema for this Actor was retrieved and is shown below:`,
            `\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
        ];
        return { error: buildMCPResponse({ texts: content, isError: true }) };
    }

    if (!actor.ajvValidate(input)) {
        const { errors } = actor.ajvValidate;
        const content = [
            `Input validation failed for Actor '${actorName}'. Please ensure your input matches the Actor's input schema.`,
            `Input schema:\n\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
        ];
        if (errors && errors.length > 0) {
            content.push(`Validation errors: ${errors.map((e) => (e as { message?: string; }).message).join(', ')}`);
        }
        return { error: buildMCPResponse({ texts: content, isError: true }) };
    }

    return { actor };
}

/**
 * Performs the pre-execution checks common to both modes:
 * - Parses args
 * - Resolves actor/MCP context
 * - Handles Skyfire restrictions
 * - Handles MCP tool calls
 *
 * Returns either an early response (error or MCP tool result) or the parsed context for mode-specific execution.
 */
export async function callActorPreExecute(toolArgs: InternalToolArgs): Promise<
    | { earlyResponse: object }
    | {
        parsed: CallActorParsedArgs;
        baseActorName: string;
        mcpToolName: string | undefined;
    }
> {
    const { args, apifyToken, apifyMcpServer, mcpSessionId } = toolArgs;
    const parsed = callActorArgs.parse(args);

    const { baseActorName, mcpToolName } = resolveActorContext(parsed.actor);

    // For definition resolution we always use token-based client; Skyfire is only for actual Actor runs
    const apifyClientForDefinition = new ApifyClient({ token: apifyToken });
    const mcpServerUrlOrFalse = await getActorMcpUrlCached(baseActorName, apifyClientForDefinition);
    const isActorMcpServer = mcpServerUrlOrFalse && typeof mcpServerUrlOrFalse === 'string';

    // Standby Actors (MCPs) are not supported in Skyfire mode
    if (isActorMcpServer && apifyMcpServer.options.skyfireMode) {
        return {
            earlyResponse: buildMCPResponse({
                texts: [`This Actor (${parsed.actor}) is an MCP server and cannot be accessed using a Skyfire token. To use this Actor, please provide a valid Apify token instead of a Skyfire token.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            }),
        };
    }

    // Validate MCP tool name for MCP server Actors
    const isMcpToolNameInvalid = mcpToolName === undefined || mcpToolName.trim().length === 0;
    if (isActorMcpServer && isMcpToolNameInvalid) {
        return {
            earlyResponse: buildMCPResponse({
                texts: [CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG],
                isError: true,
            }),
        };
    }

    // Handle MCP tool calls
    if (mcpToolName) {
        const mcpResult = await handleMcpToolCall({
            baseActorName,
            mcpToolName,
            input: parsed.input as Record<string, unknown>,
            isActorMcpServer: !!isActorMcpServer,
            mcpServerUrl: mcpServerUrlOrFalse,
            apifyToken,
            mcpSessionId,
        });
        if (mcpResult) {
            return { earlyResponse: mcpResult };
        }
    }

    return { parsed, baseActorName, mcpToolName };
}
