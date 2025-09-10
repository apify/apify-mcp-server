import type { Actor, Build } from 'apify-client';

import { resolveApifyClient } from '../apify-client-factory.js';
import { filterSchemaProperties, shortenProperties } from '../tools/utils.js';
import type { IActorInputSchema } from '../types.js';
import { formatActorToActorCard } from './actor-card.js';

// Keep the interface here since it is a self contained module
export interface ActorDetailsResult {
    actorInfo: Actor;
    buildInfo: Build;
    actorCard: string;
    inputSchema: IActorInputSchema;
    readme: string;
}

export async function fetchActorDetails(actorName: string): Promise<ActorDetailsResult | null> {
    const apifyClient = resolveApifyClient({ token: null });
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
    return {
        actorInfo,
        buildInfo,
        actorCard,
        inputSchema,
        readme: buildInfo.actorDefinition.readme || 'No README provided.',
    };
}
