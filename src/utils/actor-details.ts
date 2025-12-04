import type { Actor, Build } from 'apify-client';

import type { ApifyClient } from '../apify-client.js';
import { filterSchemaProperties, shortenProperties } from '../tools/utils.js';
import type { ActorInputSchema } from '../types.js';
import { formatActorToActorCard } from './actor-card.js';
import { logHttpError } from './logging.js';

// Keep the type here since it is a self contained module
export type ActorDetailsResult = {
    actorInfo: Actor;
    buildInfo: Build;
    actorCard: string;
    inputSchema: ActorInputSchema;
    readme: string;
};

export async function fetchActorDetails(apifyClient: ApifyClient, actorName: string): Promise<ActorDetailsResult | null> {
    try {
        const [actorInfo, buildInfo]: [Actor | undefined, Build | undefined] = await Promise.all([
            apifyClient.actor(actorName).get(),
            apifyClient.actor(actorName).defaultBuild().then(async (build) => build.get()),
        ]);
        if (!actorInfo || !buildInfo || !buildInfo.actorDefinition) return null;
        const inputSchema = (buildInfo.actorDefinition.input || {
            type: 'object',
            properties: {},
        }) as ActorInputSchema;
        inputSchema.properties = filterSchemaProperties(inputSchema.properties);
        inputSchema.properties = shortenProperties(inputSchema.properties);
        const actorCard = formatActorToActorCard(actorInfo);
        return {
            actorInfo,
            buildInfo,
            actorCard,
            inputSchema,
            readme: buildInfo.actorDefinition.readme || 'No README provided.',
        };
    } catch (error) {
        logHttpError(error, `Failed to fetch actor details for '${actorName}'`, { actorName });
        return null;
    }
}
