import { Ajv } from 'ajv';
import type { ActorStoreList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { ActorStorePruned, HelperTool, PricingInfo, ToolEntry } from '../types.js';

function pruneActorStoreInfo(response: ActorStoreList): ActorStorePruned {
    const stats = response.stats || {};
    const pricingInfo = (response.currentPricingInfo || {}) as PricingInfo;
    return {
        id: response.id,
        name: response.name?.toString() || '',
        username: response.username?.toString() || '',
        actorFullName: `${response.username}/${response.name}`,
        title: response.title?.toString() || '',
        description: response.description?.toString() || '',
        stats: {
            totalRuns: stats.totalRuns,
            totalUsers30Days: stats.totalUsers30Days,
            publicActorRunStats30Days: 'publicActorRunStats30Days' in stats
                ? stats.publicActorRunStats30Days : {},
        },
        currentPricingInfo: {
            pricingModel: pricingInfo.pricingModel?.toString() || '',
            pricePerUnitUsd: pricingInfo?.pricePerUnitUsd ?? 0,
            trialMinutes: pricingInfo?.trialMinutes ?? 0,
        },
        url: response.url?.toString() || '',
        totalStars: 'totalStars' in response ? (response.totalStars as number) : null,
    };
}

export async function searchActorsByKeywords(
    search: string,
    apifyToken: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
): Promise<ActorStorePruned[] | null> {
    const client = new ApifyClient({ token: apifyToken });
    const results = await client.store().list({ search, limit, offset });
    return results.items.map((x) => pruneActorStoreInfo(x));
}

const ajv = new Ajv({ coerceTypes: 'array', strict: false });
export const searchActorsArgsSchema = z.object({
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
        .describe('String of key words to search Actors by. '
            + 'Searches the title, name, description, username, and readme of an Actor.'
            + 'Only key word search is supported, no advanced search.'
            + 'Always prefer simple keywords over complex queries.'),
    category: z.string()
        .default('')
        .describe('Filters the results by the specified category.'),
});

/**
 * https://docs.apify.com/api/v2/store-get
 */
export const searchActors: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.STORE_SEARCH,
        actorFullName: HelperTools.STORE_SEARCH,
        description: `Discover available Actors or MCP-Servers in Apify Store using full text search using keywords.`
            + `Users try to discover Actors using free form query in this case search query must be converted to full text search. `
            + `Returns a list of Actors with name, description, run statistics, pricing, starts, and URL. `
            + `You perhaps need to use this tool several times to find the right Actor. `
            + `You should prefer simple keywords over complex queries. `
            + `Limit number of results returned but ensure that relevant results are returned. `
            + `This is not a general search tool, it is designed to search for Actors in Apify Store. `,
        inputSchema: zodToJsonSchema(searchActorsArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(searchActorsArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = searchActorsArgsSchema.parse(args);
            if (!parsed.search || parsed.search.trim() === '') {
                return {
                    content: [{
                        type: 'text',
                        text: 'Search string must not be empty. Please provide keywords to search for Actors.',
                    }],
                };
            }
            const actors = await searchActorsByKeywords(
                parsed.search,
                apifyToken,
                parsed.limit,
                parsed.offset,
            );
            return { content: actors?.map((item) => ({ type: 'text', text: JSON.stringify(item) })) };
        },
    } as HelperTool,
};
