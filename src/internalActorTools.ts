import { Ajv } from 'ajv';
import type { ActorStoreList } from 'apify-client';
import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { InternalTools } from './const.js';
import { log } from './logger.js';
import type { ActorStoreTruncated, PricingInfo, Tool } from './types.js';

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
            + 'Only key word search is supported, no advanced search.',
        ),
    category: z.string()
        .default('')
        .describe('Filters the results by the specified category.'),
});

export const RemoveActorToolArgsSchema = z.object({
    name: z.string().describe('Full name of the Actor to remove. Actor full name is always composed from `username`_`name`'
        + 'For example, username, name that leads to username/name. Never use name or username only'),
});

export const AddActorToToolsArgsSchema = z.object({
    name: z.string().describe('Full name of the Actor to add as tool. Actor full name is always composed from `username`_`name`'
        + 'For example, username, name that leads to username/name. Never use name or username only'),
});

export const GetActorDefinition = z.object({
    name: z.string().describe('Full name of the Actor to retrieve documentation. Actor full name is always composed from `username`_`name`'
        + 'For example, username, name that leads to username_name. Never use name or username only'),
});

export function getInternalTools(): Tool[] {
    const ajv = new Ajv({ coerceTypes: 'array', strict: false });
    return [
        {
            name: InternalTools.DISCOVER_ACTORS,
            actorName: InternalTools.DISCOVER_ACTORS,
            description: `Discover available Actors using full text search using keywords.`
                + `Users try to discover Actors using free form query in this case search query needs to be converted to full text search. `
                + `Prefer Actors from Apify as they are generally more reliable and have better support. `
                + `Returns a list of Actors with name, description, statistics, and URL. `
                + `Always limit number of results returned but ensure that the most relevant results are returned. `,
            inputSchema: zodToJsonSchema(DiscoverActorsArgsSchema),
            ajvValidate: ajv.compile(zodToJsonSchema(DiscoverActorsArgsSchema)),
        },
        {
            name: InternalTools.ADD_ACTOR_TO_TOOLS,
            actorName: InternalTools.ADD_ACTOR_TO_TOOLS,
            description: 'Add an Actor tool by name to available tools. Do not execute the actor, only add it and list it in available tools. '
                + 'Never run the tool without user consent! '
                + 'For example, add a tool with username_name when user wants to scrape/extract data',
            inputSchema: zodToJsonSchema(AddActorToToolsArgsSchema),
            ajvValidate: ajv.compile(zodToJsonSchema(AddActorToToolsArgsSchema)),
        },
        {
            name: InternalTools.REMOVE_ACTOR_FROM_TOOLS,
            actorName: InternalTools.ADD_ACTOR_TO_TOOLS,
            description: 'Remove an actor tool by name from available toos. '
                + 'For example, when user says, I do not need a tool username_name anymore',
            inputSchema: zodToJsonSchema(RemoveActorToolArgsSchema),
            ajvValidate: ajv.compile(zodToJsonSchema(RemoveActorToolArgsSchema)),
        },
        {
            name: InternalTools.GET_ACTOR_DETAILS,
            actorName: InternalTools.GET_ACTOR_DETAILS,
            description: 'Get documentation, readme, input schema and other details about Actor. '
                + 'For example, when user says, I need to know more about web crawler Actor.'
                + 'Get details for Actors with username_name.',
            inputSchema: zodToJsonSchema(GetActorDefinition),
            ajvValidate: ajv.compile(zodToJsonSchema(GetActorDefinition)),
        },
    ];
}

function transform(response: ActorStoreList): ActorStoreTruncated {
    return {
        name: response.name?.toString() || '',
        username: response.username?.toString() || '',
        title: response.title?.toString() || '',
        description: response.description?.toString() || '',
        stats: {
            totalRuns: response.stats.totalRuns,
            totalUsers: response.stats.totalUsers,
            totalUsers7Days: response.stats.totalUsers7Days,
            totalUsers30Days: response.stats.totalUsers30Days,
        },
        currentPricingInfo: response.currentPricingInfo || {} as PricingInfo,
        url: response.url?.toString() || '',
        totalStars: 'totalStars' in response ? (response.totalStars as number) : null,
    };
}

export async function searchActorsByKeywords(
    search: string,
    limit: number | undefined = undefined,
    offset: number | undefined = undefined,
): Promise<ActorStoreTruncated[] | null> {
    if (!process.env.APIFY_TOKEN) {
        log.error('APIFY_TOKEN is required but not set. Please set it as an environment variable');
        return null;
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    const results = await client.store().list({ search, limit, offset });
    return results.items.map((x) => transform(x));
}
