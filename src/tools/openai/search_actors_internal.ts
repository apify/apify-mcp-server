import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { searchAndFilterActors } from '../../utils/actor_search.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { searchActorsBaseArgsSchema } from '../core/search_actors_common.js';
import { actorSearchInternalOutputSchema } from '../structured_output_schemas.js';

const searchActorsInternalInputSchema = z.toJSONSchema(searchActorsBaseArgsSchema);

export const searchActorsInternalTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.STORE_SEARCH_INTERNAL,
    description: dedent`
        Search Actors internally (UI mode internal tool).

        This tool is available because the LLM is operating in UI mode. Use it for internal lookups
        where data presentation to the user is NOT needed - this tool does NOT render a widget.

        Use this instead of ${HelperTools.STORE_SEARCH} when you need to find an Actor but the user
        did NOT explicitly ask to search Actors. For example, when user says "scrape me google maps"
        and you need to find the right Actor for the task, then fetch its schema and call it.

        Returns only minimal fields (fullName, title, description) needed for subsequent calls.
    `,
    inputSchema: searchActorsInternalInputSchema as ToolInputSchema,
    outputSchema: actorSearchInternalOutputSchema,
    ajvValidate: compileSchema(searchActorsInternalInputSchema),
    annotations: {
        title: 'Search Actors (internal)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, userRentedActorIds, apifyMcpServer } = toolArgs;
        const parsed = searchActorsBaseArgsSchema.parse(args);
        const actors = await searchAndFilterActors({
            keywords: parsed.keywords,
            apifyToken,
            limit: parsed.limit,
            offset: parsed.offset,
            paymentProvider: apifyMcpServer.options.paymentProvider,
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
                `Query: ${parsed.keywords}`,
                `Actors:\n\`\`\`json\n${JSON.stringify(minimalActors)}\n\`\`\``,
            ],
            structuredContent: {
                actors: minimalActors,
                query: parsed.keywords,
                count: minimalActors.length,
            },
        });
    },
});
