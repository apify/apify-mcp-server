import { Ajv } from 'ajv';
import type { ActorStoreList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { ActorStorePruned, ApifyStorePricingModel, HelperTool, PricingInfo, ToolEntry } from '../types.js';

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
    pricingModel: ApifyStorePricingModel | undefined = undefined,
): Promise<ActorStorePruned[]> {
    const client = new ApifyClient({ token: apifyToken });
    const results = await client.store().list({ search, limit, offset, pricingModel });
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
 * Filters out actors with the 'FLAT_PRICE_PER_MONTH' pricing model (rental actors).
 *
 * @param actors - Array of ActorStorePruned objects to filter.
 * @returns Array of actors excluding those with 'FLAT_PRICE_PER_MONTH' pricing model.
 */
function filterRentalActors(
    actors: ActorStorePruned[],
): ActorStorePruned[] {
    // Store list API does not support filtering by two pricing models at once,
    // so we filter the results manually after fetching them.
    return actors.filter((actor) => (actor.currentPricingInfo.pricingModel as ApifyStorePricingModel) !== 'FLAT_PRICE_PER_MONTH');
}

/**
 * Fallback function to fetch actors if no rental actors are found.
 * Fetches both free and pay-per-result actors and merges them in a zig-zag order.
 *
 * @param search - Search keywords for actors.
 * @param apifyToken - Apify API token.
 * @param limit - Maximum number of actors to return.
 * @param offset - Number of actors to skip from the start.
 * @returns Array of ActorStorePruned objects, alternating between free and pay-per-result actors.
 */
async function getFallbackActors(
    search: string,
    apifyToken: string,
    limit: number | undefined,
    offset: number | undefined,
): Promise<ActorStorePruned[]> {
    const freeActors = await searchActorsByKeywords(
        search,
        apifyToken,
        limit,
        offset,
        'FREE',
    );
    const payPerResultActors = await searchActorsByKeywords(
        search,
        apifyToken,
        limit,
        offset,
        'PRICE_PER_DATASET_ITEM',
    );
    const allActors: ActorStorePruned[] = [];
    // Push Actors in zig-zag order to ensure that we return all Actors
    // in relevant order.
    const maxLength = Math.max(freeActors?.length || 0, payPerResultActors?.length || 0);
    for (let i = 0; i < maxLength; i++) {
        if (freeActors && freeActors[i]) allActors.push(freeActors[i]);
        if (payPerResultActors && payPerResultActors[i]) allActors.push(payPerResultActors[i]);
    }
    return allActors;
}

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
            let actors = await searchActorsByKeywords(
                parsed.search,
                apifyToken,
                parsed.limit,
                parsed.offset,
            );
            actors = filterRentalActors(actors || []);
            if (actors.length === 0) {
                // If no non-rental actors found, search for free and pay-per-result actors directly
                // and sort them by total stars.
                // This is a fallback to ensure we return some results.
                actors = await getFallbackActors(
                    parsed.search,
                    apifyToken,
                    parsed.limit,
                    parsed.offset,
                );
            }

            return { content: actors?.map((item) => ({ type: 'text', text: JSON.stringify(item) })) };
        },
    } as HelperTool,
};
