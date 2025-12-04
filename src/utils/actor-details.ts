import type { Actor, Build } from 'apify-client';

import type { ApifyClient } from '../apify-client.js';
import { filterSchemaProperties, shortenProperties } from '../tools/utils.js';
import type { IActorInputSchema, type StructuredActorCard } from '../types.js';
import { formatActorToActorCard, formatActorToStructuredCard } from './actor-card.js';
import { logHttpError } from './logging.js';

// Keep the interface here since it is a self contained module
export interface ActorDetailsResult {
    actorInfo: Actor;
    buildInfo: Build;
    actorCard: string;
    actorCardStructured: StructuredActorCard;
    inputSchema: IActorInputSchema;
    readme: string;
}

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
        }) as IActorInputSchema;
        inputSchema.properties = filterSchemaProperties(inputSchema.properties);
        inputSchema.properties = shortenProperties(inputSchema.properties);
        const actorCard = formatActorToActorCard(actorInfo);
        const actorCardStructured = formatActorToStructuredCard(actorInfo);
        return {
            actorInfo,
            buildInfo,
            actorCard,
            actorCardStructured,
            inputSchema,
            readme: buildInfo.actorDefinition.readme || 'No README provided.',
        };
    } catch (error) {
        logHttpError(error, `Failed to fetch actor details for '${actorName}'`, { actorName });
        return null;
    }
}
