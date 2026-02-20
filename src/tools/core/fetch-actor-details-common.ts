import { z } from 'zod';

import { HelperTools } from '../../const.js';
import { getWidgetConfig, WIDGET_URIS } from '../../resources/widgets.js';
import type { HelperTool, ToolInputSchema } from '../../types.js';
import {
    actorDetailsOutputOptionsSchema,
} from '../../utils/actor-details.js';
import { compileSchema } from '../../utils/ajv.js';
import { actorDetailsOutputSchema } from '../structured-output-schemas.js';

/**
 * Zod schema for fetch-actor-details arguments — shared between default and openai variants.
 */
export const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
    output: actorDetailsOutputOptionsSchema.optional()
        .describe('Specify which information to include in the response to save tokens.'),
});

const FETCH_ACTOR_DETAILS_DESCRIPTION = `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").

Use 'output' parameter with boolean flags to control returned information:
- Default: All fields true except mcpTools
- Selective: Set desired fields to true (e.g., output: { inputSchema: true })
- Common patterns: inputSchema only, description + readme, mcpTools for MCP Actors

Use when querying Actor details, documentation, input requirements, or MCP tools.

EXAMPLES:
- What does apify/rag-web-browser do?
- What is the input schema for apify/web-scraper?
- What tools does apify/actors-mcp-server provide?`;

/**
 * Shared tool metadata for fetch-actor-details — everything except the `call` handler.
 * Used by both default and openai variants.
 */
export const fetchActorDetailsMetadata: Omit<HelperTool, 'call'> = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS,
    description: FETCH_ACTOR_DETAILS_DESCRIPTION,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
    // openai/* keys are stripped in non-openai mode by stripOpenAiMeta() in src/utils/tools.ts
    _meta: {
        ...getWidgetConfig(WIDGET_URIS.SEARCH_ACTORS)?.meta,
    },
    annotations: {
        title: 'Fetch Actor details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
};
