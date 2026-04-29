import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { extractActorId } from '../../utils/tools.js';
import {
    buildCallActorErrorResponse,
    buildStartAsyncResponse,
    callActorPreExecute,
    resolveAndValidateActor,
} from '../core/call_actor_common.js';
import { callActorOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget-only input: `actor` + `input` + optional `callOptions`.
 *
 * This schema is declared as `.strict()` so the widget tool's contract excludes stray keys
 * such as `async` or `previewOutput`. AJV may also remove unknown properties at the server
 * boundary, but any non-AJV execution path must explicitly parse with this schema in the
 * handler to enforce the same runtime contract. The widget is always async.
 *
 * The widget variant does not support MCP `actor:toolName` syntax — use `call-actor` for that.
 */
const callActorWidgetArgsSchema = z.object({
    actor: z.string()
        .describe('The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").'),
    input: z.object({}).passthrough()
        .describe('The input JSON to pass to the Actor. Required.'),
    callOptions: z.object({
        memory: z.number()
            .min(128, 'Memory must be at least 128 MB')
            .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
            .optional()
            .describe(dedent`
                Memory allocation for the Actor in MB. Must be a power of 2 (e.g., 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768).
                Minimum: 128 MB, Maximum: 32768 MB (32 GB).
            `),
        timeout: z.number()
            .min(0, 'Timeout must be 0 or greater')
            .optional()
            .describe(dedent`
                Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated.
                Use 0 for infinite timeout (no time limit). Minimum: 0 seconds (infinite).
            `),
    }).optional()
        .describe('Optional call options for the Actor run configuration.'),
}).strict();

const CALL_ACTOR_WIDGET_DESCRIPTION = dedent`
    Render an interactive UI element (widget) that displays live Actor run progress for the user.

    Use this tool ONLY when the user explicitly wants to see run progress visually
    (e.g., "run apify/rag-web-browser and show progress", "start this Actor with a progress view").
    The response renders as an interactive widget that automatically tracks run status until
    completion — do NOT poll or call any other tool after this.

    For silent async starts where no UI is needed (e.g., "start this in the background",
    or when your next step is to fetch results via ${HelperTools.ACTOR_OUTPUT_GET}), use
    ${HelperTools.ACTOR_CALL} instead — it returns the same runId without rendering a widget.

    WORKFLOW:
    1. Use ${HelperTools.ACTOR_GET_DETAILS} to get the Actor's input schema
    2. Call this tool with the actor name and proper input based on the schema

    If the actor name is not in "username/name" format, use ${HelperTools.STORE_SEARCH} to resolve the correct Actor first.

    Input: actor name and input JSON; callOptions (memory, timeout) are optional.
`;

export const appsCallActorWidget: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_CALL_WIDGET,
    description: CALL_ACTOR_WIDGET_DESCRIPTION,
    inputSchema: z.toJSONSchema(callActorWidgetArgsSchema) as ToolInputSchema,
    outputSchema: callActorOutputSchema,
    // Allow arbitrary keys inside `input` (dynamic Actor input) while keeping the outer shape strict.
    ajvValidate: compileSchema(z.toJSONSchema(callActorWidgetArgsSchema)),
    paymentRequired: true,
    // Tool-level widget meta; only registered in apps mode so stripWidgetMeta is a no-op here.
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta,
    },
    annotations: {
        title: 'Call Actor (widget)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const rawActor = toolArgs.args?.actor;
        if (typeof rawActor === 'string' && rawActor.includes(':')) {
            return buildMCPResponse({
                texts: [
                    `${HelperTools.ACTOR_CALL_WIDGET} does not render widgets for MCP tool calls.`,
                    `Use ${HelperTools.ACTOR_CALL} for the "actorName:toolName" syntax.`,
                ],
                isError: true,
            });
        }

        const preResult = await callActorPreExecute(toolArgs, { route: HelperTools.ACTOR_CALL_WIDGET });
        if ('earlyResponse' in preResult) {
            return preResult.earlyResponse;
        }

        const { parsed, baseActorName } = preResult;
        const { input, callOptions } = parsed;

        let resolvedActorId: string | undefined;
        try {
            const resolution = await resolveAndValidateActor({
                actorName: baseActorName,
                input: input as Record<string, unknown>,
                toolArgs,
            });
            if ('error' in resolution) {
                return resolution.error;
            }

            resolvedActorId = extractActorId(resolution.actor);
            const { apifyClient } = toolArgs;

            const actorClient = apifyClient.actor(baseActorName);
            const actorRun = await actorClient.start(input, callOptions);
            log.debug('Started Actor run (widget)', { actorName: baseActorName, runId: actorRun.id, mcpSessionId: toolArgs.mcpSessionId });
            const response = buildStartAsyncResponse({
                actorName: baseActorName,
                actorRun,
                input,
                widget: true,
            });
            return {
                ...response,
                toolTelemetry: { actorId: resolvedActorId },
            };
        } catch (error) {
            return buildCallActorErrorResponse({
                actorName: baseActorName,
                error,
                actorId: resolvedActorId,
                isAsync: true,
                mcpSessionId: toolArgs.mcpSessionId,
                actorGetDetailsTool: HelperTools.ACTOR_GET_DETAILS,
            });
        }
    },
} as const);
