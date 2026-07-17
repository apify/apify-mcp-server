import dedent from 'dedent';
import { z } from 'zod';

import log from '@apify/log';

import { HELPER_TOOLS } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondServerError } from '../../utils/mcp.js';
import { extractActorId } from '../../utils/tools.js';
import { buildStartRunWidgetResponse } from '../actors/actor_run_response.js';
import {
    buildCallActorErrorResponse,
    callActorPreExecute,
    callOptionsSchema,
    resolveAndValidateActor,
} from '../actors/call_actor.js';
import { actorRunOutputSchema } from '../structured_output_schemas.js';

/**
 * Widget-only input: `actor` + `input` + optional `callOptions`.
 *
 * This schema is declared as `.strict()` so the widget tool's contract excludes stray keys.
 * AJV may also remove unknown properties at the server boundary, but any non-AJV execution
 * path must explicitly parse with this schema in the handler to enforce the same runtime
 * contract. The widget is always async.
 *
 * The widget variant does not support MCP `actor:toolName` syntax — use `call-actor` for that.
 */
const callActorWidgetArgsSchema = z
    .object({
        actor: z
            .string()
            .describe('The name of the Actor to call. Format: "username/name" (e.g., "apify/rag-web-browser").'),
        input: z.object({}).passthrough().describe('The input JSON to pass to the Actor. Required.'),
        callOptions: callOptionsSchema
            .optional()
            .describe(
                'Optional run config: memory (MB), timeout (s), build, maxItems (pay-per-result cap), maxTotalChargeUsd (pay-per-event cap).',
            ),
    })
    .strict();

const CALL_ACTOR_WIDGET_DESCRIPTION = dedent`
    Render an interactive UI element (widget) that displays live Actor run progress for the user.

    Use this tool ONLY when the user explicitly wants to see run progress visually
    (e.g., "run apify/rag-web-browser and show progress", "start this Actor with a progress view").
    The response renders as an interactive widget that automatically tracks run status until
    completion — do NOT poll or call any other tool after this.

    For silent async starts where no UI is needed (e.g., "start this in the background",
    or when your next step is to fetch results via ${HELPER_TOOLS.DATASET_GET_ITEMS}), use
    ${HELPER_TOOLS.ACTOR_CALL} instead — it returns the same runId without rendering a widget.

    WORKFLOW:
    1. Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} to get the Actor's input schema
    2. Call this tool with the actor name and proper input based on the schema

    If the actor name is not in "username/name" format, use ${HELPER_TOOLS.STORE_SEARCH} to resolve the correct Actor first.

    Input: actor name and input JSON; callOptions (memory, timeout) are optional.
`;

export const callActorWidget: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_CALL_WIDGET,
    title: 'Call Actor (widget)',
    description: CALL_ACTOR_WIDGET_DESCRIPTION,
    inputSchema: z.toJSONSchema(callActorWidgetArgsSchema) as ToolInputSchema,
    outputSchema: actorRunOutputSchema,
    // Allow arbitrary keys inside `input` (dynamic Actor input) while keeping the outer shape strict.
    ajvValidate: compileSchema(z.toJSONSchema(callActorWidgetArgsSchema)),
    paymentRequired: true,
    _meta: getWidgetConfig(WIDGET_URIS.ACTOR_RUN)?.meta,
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
            return respondServerError([
                `${HELPER_TOOLS.ACTOR_CALL_WIDGET} does not render widgets for MCP tool calls.`,
                `Use ${HELPER_TOOLS.ACTOR_CALL} for the "actorName:toolName" syntax.`,
            ]);
        }

        const preResult = await callActorPreExecute(toolArgs, { route: HELPER_TOOLS.ACTOR_CALL_WIDGET });
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
            log.debug('Started Actor run (widget)', {
                actorName: baseActorName,
                runId: actorRun.id,
                mcpSessionId: toolArgs.mcpSessionId,
            });
            const response = buildStartRunWidgetResponse({ actorName: baseActorName, actorRun });
            return {
                ...response,
                toolTelemetry: { actorId: resolvedActorId },
            };
        } catch (error) {
            return buildCallActorErrorResponse({
                actorName: baseActorName,
                error,
                actorId: resolvedActorId,
                mcpSessionId: toolArgs.mcpSessionId,
                actorGetDetailsTool: HELPER_TOOLS.ACTOR_GET_DETAILS,
            });
        }
    },
} as const);
