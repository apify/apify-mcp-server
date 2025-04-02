import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { InternalTools } from '../const.js';
import { searchActorsByKeywords } from '../tools.js';
import type { InternalTool, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

export const DiscoverActorsArgsSchema = z.object({
    limit: z.number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('The maximum number of Actors to return. Default value is 10.'),
    offset: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('The number of elements that should be skipped at the start. Default value is 0.'),
    search: z.string()
        .default('')
        .describe('String of key words to search by. '
            + 'Searches the title, name, description, username, and readme of an Actor.'
            + 'Only key word search is supported, no advanced search.'
            + 'Always prefer simple keywords over complex queries.'),
    category: z.string()
        .default('')
        .describe('Filters the results by the specified category.'),
});

export const discoverActorsTool: ToolWrap = {
    type: 'internal',
    tool: {
        name: InternalTools.DISCOVER_ACTORS,
        actorFullName: InternalTools.DISCOVER_ACTORS,
        description: `Discover available Actors using full text search using keywords.`
            + `Users try to discover Actors using free form query in this case search query needs to be converted to full text search. `
            + `Prefer Actors from Apify as they are generally more reliable and have better support. `
            + `Returns a list of Actors with name, description, run statistics, pricing, starts, and URL. `
            + `You perhaps need to use this tool several times to find the right Actor. `
            + `Limit number of results returned but ensure that relevant results are returned. `,
        inputSchema: zodToJsonSchema(DiscoverActorsArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(DiscoverActorsArgsSchema)),
        call: async (toolArgs) => {
            const { args } = toolArgs;
            const parsed = DiscoverActorsArgsSchema.parse(args);
            const actors = await searchActorsByKeywords(
                parsed.search,
                parsed.limit,
                parsed.offset,
            );
            return { content: actors?.map((item) => ({ type: 'text', text: JSON.stringify(item) })) };
        },
    } as InternalTool,
};
