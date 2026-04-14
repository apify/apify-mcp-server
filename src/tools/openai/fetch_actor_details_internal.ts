import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import {
    buildFetchActorDetailsResult,
    fetchActorDetailsToolArgsSchema,
} from '../core/fetch_actor_details_common.js';
import { actorDetailsOutputSchema } from '../structured_output_schemas.js';

export const fetchActorDetailsInternalTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS_INTERNAL,
    description: dedent`
        Fetch Actor details with flexible output options (UI mode internal tool).

        This tool is available because the LLM is operating in UI mode. Use it for internal lookups
        where data presentation to the user is NOT needed - this tool does NOT render a widget.

        Use 'output' parameter with boolean flags to control returned information:
        - Default: Fields: description, stats, pricing, rating, metadata, inputSchema, readme - except mcpTools
        - Selective: Set desired fields to true to save tokens (e.g., output: { inputSchema: true, readme: false })
        - Common patterns: inputSchema only for execution prep, readme + inputSchema for documentation, etc.

        Use this instead of fetch-actor-details when you need Actor information to prepare execution
        but the user did NOT explicitly ask for Actor details presentation.
    `,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
    annotations: {
        title: 'Fetch Actor details internal',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs) => buildFetchActorDetailsResult(toolArgs, 'fetch-actor-details-internal'),
} as const);
