import { Ajv } from 'ajv';
import type { ActorStoreList } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { ACTOR_SEARCH_ABOVE_LIMIT, HelperTools } from '../const.js';
import type { ActorPricingModel, ExtendedActorStoreList, ExtendedPricingInfo, HelperTool, ToolEntry } from '../types.js';
import { pricingInfoToString } from '../utils/pricing-info.js';

export async function searchActorsByKeywords(
    search: string,
    apifyToken: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
): Promise<ExtendedActorStoreList[]> {
    const client = new ApifyClient({ token: apifyToken });
    const results = await client.store().list({ search, limit, offset });
    return results.items;
}

const ajv = new Ajv({ coerceTypes: 'array', strict: false });
export const searchActorsArgsSchema = z.object({
    limit: z.number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('The maximum number of Actors to return. The default value is 10.'),
    offset: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('The number of elements to skip at the start. The default value is 0.'),
    search: z.string()
        .default('')
        .describe(`A string to search for in the Actor's title, name, description, username, and readme.
Use simple space-separated keywords, such as "web scraping", "data extraction", or "playwright browser mcp".
Do not use complex queries, AND/OR operators, or other advanced syntax, as this tool uses full-text search only.`),
    category: z.string()
        .default('')
        .describe('Filter the results by the specified category.'),
});

export interface ISearchActorsResult {
    total: number;
    actors: {
        actorFullName: string;

        categories?: string[];
        description: string;

        actorRating: string; // We convert the star (out of 5) rating into a string representation (e.g., "4.5 out of 5")
        bookmarkCount: string; // We convert the bookmark count into a string representation (e.g., "100 users bookmarked this Actor")

        pricingInfo: string; // We convert the pricing info into a string representation

        usageStatistics: {
            totalUsers: {
                allTime: number;
                last7Days: number;
                last30Days: number;
                last90Days: number;
            };
            failedRunsInLast30Days: number | string; // string for 'unknown' case
        }
    }[];
}

/**
 * Filters out actors with the 'FLAT_PRICE_PER_MONTH' pricing model (rental actors),
 * unless the actor's ID is present in the user's rented actor IDs list.
 *
 * This is necessary because the Store list API does not support filtering by multiple pricing models at once.
 *
 * @param actors - Array of ActorStorePruned objects to filter.
 * @param userRentedActorIds - Array of Actor IDs that the user has rented.
 * @returns Array of Actors excluding those with 'FLAT_PRICE_PER_MONTH' pricing model (= rental Actors),
 *  except for Actors that the user has rented (whose IDs are in userRentedActorIds).
 */
function filterRentalActors(
    actors: ActorStoreList[],
    userRentedActorIds: string[],
): ActorStoreList[] {
    // Store list API does not support filtering by two pricing models at once,
    // so we filter the results manually after fetching them.
    return actors.filter((actor) => (
        actor.currentPricingInfo.pricingModel as ActorPricingModel) !== 'FLAT_PRICE_PER_MONTH'
        || userRentedActorIds.includes(actor.id),
    );
}

/**
 * https://docs.apify.com/api/v2/store-get
 */
export const searchActors: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.STORE_SEARCH,
        description: `Discover available Actors or MCP servers (which are also considered Actors in the context of Apify) in the Apify Store.
This tool uses full-text search, so you MUST use simple space-separated keywords, such as "web scraping", "data extraction", or "playwright browser mcp".
This tool returns a list of Actors with basic information, including descriptions, pricing models, usage statistics, and user ratings.
Prefer Actors with more users, stars, and runs.
You may need to use this tool several times to find the right Actor.
Limit the number of results returned, but ensure that relevant results are included.
This is not a general search tool; it is designed specifically to search for Actors in the Apify Store.`,
        inputSchema: zodToJsonSchema(searchActorsArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(searchActorsArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken, userRentedActorIds } = toolArgs;
            const parsed = searchActorsArgsSchema.parse(args);
            let actors = await searchActorsByKeywords(
                parsed.search,
                apifyToken,
                parsed.limit + ACTOR_SEARCH_ABOVE_LIMIT,
                parsed.offset,
            );
            actors = filterRentalActors(actors || [], userRentedActorIds || []).slice(0, parsed.limit);

            const result: ISearchActorsResult = {
                total: actors.length,
                actors: actors.map((actor) => {
                    return {
                        actorFullName: `${actor.username}/${actor.name}`,

                        categories: actor.categories,
                        description: actor.description || 'No description provided.',

                        actorRating: actor.actorReviewRating
                            ? `${actor.actorReviewRating.toFixed(2)} out of 5`
                            : 'unknown',
                        bookmarkCount: actor.bookmarkCount
                            ? `${actor.bookmarkCount} users have bookmarked this Actor`
                            : 'unknown',

                        pricingInfo: pricingInfoToString(actor.currentPricingInfo as ExtendedPricingInfo),

                        usageStatistics: {
                            totalUsers: {
                                allTime: actor.stats.totalUsers,
                                last7Days: actor.stats.totalUsers7Days,
                                last30Days: actor.stats.totalUsers30Days,
                                last90Days: actor.stats.totalUsers90Days,
                            },
                            failedRunsInLast30Days: (
                                'publicActorRunStats30Days' in actor.stats && 'FAILED' in (actor.stats.publicActorRunStats30Days as object)
                            ) ? (actor.stats.publicActorRunStats30Days as { FAILED: number }).FAILED : 'unknown',
                        },
                    };
                }),
            };

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result),
                }],
            };
        },
    } as HelperTool,
};
