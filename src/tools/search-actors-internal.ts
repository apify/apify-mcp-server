import { z } from 'zod';

import { ACTOR_SEARCH_ABOVE_LIMIT, HelperTools } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { filterRentalActors, searchActorsByKeywords } from './store_collection.js';
import { actorSearchInternalOutputSchema } from './structured-output-schemas.js';

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

export const searchActorsInternalTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.STORE_SEARCH_INTERNAL,
    description: `Internal-only Actor search.

Use this tool for helper/internal lookups to resolve an Actor name.
Use it instead of ${HelperTools.STORE_SEARCH} when the next step is fetching schema or running an Actor.
It returns only minimal fields needed for subsequent calls.`,
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
        let actors = await searchActorsByKeywords(
            parsed.keywords,
            apifyToken,
            parsed.limit + ACTOR_SEARCH_ABOVE_LIMIT,
            parsed.offset,
            apifyMcpServer.options.skyfireMode ? true : undefined,
        );
        actors = filterRentalActors(actors || [], userRentedActorIds || []).slice(0, parsed.limit);

        const minimalActors = actors.map((actor) => ({
            fullName: `${actor.username}/${actor.name}`,
            title: actor.title || actor.name,
            description: actor.description || '',
        }));

        return buildMCPResponse({
            texts: [
                `Found ${minimalActors.length} Actors for "${parsed.keywords}".`,
            ],
            structuredContent: {
                actors: minimalActors,
                query: parsed.keywords,
                count: minimalActors.length,
            },
        });
    },
};
