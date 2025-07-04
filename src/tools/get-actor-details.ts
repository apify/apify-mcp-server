import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { ExtendedPricingInfo, IActorInputSchema, InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { getCurrentPricingInfo, pricingInfoToString } from '../utils/pricing-info.js';
import { filterSchemaProperties, shortenProperties } from './utils.js';

const getActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});

interface IGetActorDetailsToolResult {
    id: string;
    actorFullName: string;

    isPublic: boolean;
    isDeprecated: boolean;
    createdAt: string;
    modifiedAt: string;

    categories?: string[];
    description: string;
    readme: string;

    inputSchema: IActorInputSchema;

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
}

export const getActorDetailsTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_GET_DETAILS,
        description: `Retrieve information about an Actor by its ID or full name.
The Actor name is always composed of "username/name", for example, "apify/rag-web-browser".
This tool returns information about the Actor, including whether it is public or deprecated, when it was created or modified, the categories in which the Actor is listed, a description, a README (the Actor's documentation), the input schema, and usage statistics—such as how many users are using it and the number of failed runs of the Actor.`,
        inputSchema: zodToJsonSchema(getActorDetailsToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(getActorDetailsToolArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;

            const parsed = getActorDetailsToolArgsSchema.parse(args);
            const client = new ApifyClient({ token: apifyToken });

            const [actorInfo, buildInfo] = await Promise.all([
                client.actor(parsed.actor).get(),
                client.actor(parsed.actor).defaultBuild().then(async (build) => build.get()),
            ]);

            if (!actorInfo || !buildInfo || !buildInfo.actorDefinition) {
                return {
                    content: [{ type: 'text', text: `Actor information for '${parsed.actor}' was not found. Please check the Actor ID or name and ensure the Actor exists.` }],
                };
            }

            const inputSchema = (buildInfo.actorDefinition.input || {
                type: 'object',
                properties: {},
            }) as IActorInputSchema;
            inputSchema.properties = filterSchemaProperties(inputSchema.properties);
            inputSchema.properties = shortenProperties(inputSchema.properties);

            const currentPricingInfo = getCurrentPricingInfo(actorInfo.pricingInfos || [], new Date());

            const result: IGetActorDetailsToolResult = {
                id: actorInfo.id,
                actorFullName: `${actorInfo.username}/${actorInfo.name}`,

                isPublic: actorInfo.isPublic,
                isDeprecated: actorInfo.isDeprecated || false,
                createdAt: actorInfo.createdAt.toISOString(),
                modifiedAt: actorInfo.modifiedAt.toISOString(),

                categories: actorInfo.categories,
                description: actorInfo.description || 'No description provided.',
                readme: buildInfo.actorDefinition.readme || 'No README provided.',

                inputSchema,

                pricingInfo: pricingInfoToString(currentPricingInfo as (ExtendedPricingInfo | null)),

                usageStatistics: {
                    totalUsers: {
                        allTime: actorInfo.stats.totalUsers,
                        last7Days: actorInfo.stats.totalUsers7Days,
                        last30Days: actorInfo.stats.totalUsers30Days,
                        last90Days: actorInfo.stats.totalUsers90Days,
                    },
                    failedRunsInLast30Days: (
                        'publicActorRunStats30Days' in actorInfo.stats && 'FAILED' in (actorInfo.stats.publicActorRunStats30Days as object)
                    ) ? (actorInfo.stats.publicActorRunStats30Days as { FAILED: number }).FAILED : 'unknown',
                },
            };
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result),
                }],
            };
        },
    } as InternalTool,
};
