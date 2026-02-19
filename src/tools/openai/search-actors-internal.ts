import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { searchAndFilterActors } from '../../utils/actor-search.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { actorSearchInternalOutputSchema } from '../structured-output-schemas.js';

const searchActorsInternalArgsSchema = z.object({
    limit: z.number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('The maximum number of Actors to return (default = 10)'),
    offset: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('The number of elements to skip from the start (default = 0)'),
    keywords: z.string()
        .default('')
        .describe('Keywords used to search for Actors in the Apify Store.'),
    category: z.string()
        .default('')
        .describe('Filter the results by the specified category.'),
});

export const searchActorsInternalTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.STORE_SEARCH_INTERNAL,
    openaiOnly: true,
    description: `Search Actors internally (UI mode internal tool).

This tool is available because the LLM is operating in UI mode. Use it for internal lookups 
where data presentation to the user is NOT needed - this tool does NOT render a widget.

Use this instead of ${HelperTools.STORE_SEARCH} when you need to find an Actor but the user 
did NOT explicitly ask to search Actors. For example, when user says "scrape me google maps" 
and you need to find the right Actor for the task, then fetch its schema and call it.

Returns only minimal fields (fullName, title, description) needed for subsequent calls.`,
    inputSchema: z.toJSONSchema(searchActorsInternalArgsSchema) as ToolInputSchema,
    outputSchema: actorSearchInternalOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(searchActorsInternalArgsSchema)),
    annotations: {
        title: 'Search Actors (internal)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, userRentedActorIds, apifyMcpServer } = toolArgs;
        const parsed = searchActorsInternalArgsSchema.parse(args);
        const actors = await searchAndFilterActors({
            keywords: parsed.keywords,
            apifyToken,
            limit: parsed.limit,
            offset: parsed.offset,
            skyfireMode: apifyMcpServer.options.skyfireMode,
            userRentedActorIds,
        });

        const minimalActors = actors.map((actor) => ({
            fullName: `${actor.username}/${actor.name}`,
            title: actor.title || actor.name,
            description: actor.description || '',
        }));

        return buildMCPResponse({
            texts: [
                `Found ${minimalActors.length} Actors for "${parsed.keywords}".`,
                '',
                `Query: ${parsed.keywords}`,
                '',
                `Actors:\n\`\`\`json\n${JSON.stringify(minimalActors, null, 2)}\n\`\`\``,
            ],
            structuredContent: {
                actors: minimalActors,
                query: parsed.keywords,
                count: minimalActors.length,
            },
        });
    },
});
