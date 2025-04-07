import { ApifyClient } from 'apify-client';

import { ACTOR_README_MAX_LENGTH } from '../const.js';
import { log } from '../logger.js';
import type { ActorDefinitionPruned, ActorDefinitionWithDesc, ISchemaProperties } from '../types.js';

/**
 * Get Actor input schema by Actor name.
 * First, fetch the Actor details to get the default build tag and buildId.
 * Then, fetch the build details and return actorName, description, and input schema.
 * @param {string} actorIdOrName - Actor ID or Actor full name.
 * @param {number} limit - Truncate the README to this limit.
 * @returns {Promise<ActorDefinitionWithDesc | null>} - The actor definition with description or null if not found.
 */
export async function getActorDefinition(actorIdOrName: string, limit: number = ACTOR_README_MAX_LENGTH): Promise<ActorDefinitionPruned | null> {
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    const actorClient = client.actor(actorIdOrName);

    try {
        // Fetch actor details
        const actor = await actorClient.get();
        if (!actor) {
            log.error(`Failed to fetch input schema for Actor: ${actorIdOrName}. Actor not found.`);
            return null;
        }

        // fnesveda: The default build is not necessarily tagged, you can specify any build number as default build.
        // There will be a new API endpoint to fetch a default build.
        // For now, we'll use the tagged build, it will work for 90% of Actors. Later, we can update this.
        const tag = actor.defaultRunOptions?.build || '';
        const buildId = actor.taggedBuilds?.[tag]?.buildId || '';

        if (!buildId) {
            log.error(`Failed to fetch input schema for Actor: ${actorIdOrName}. Build ID not found.`);
            return null;
        }
        // Fetch build details and return the input schema
        const buildDetails = await client.build(buildId).get();
        if (buildDetails?.actorDefinition) {
            const actorDefinitions = buildDetails?.actorDefinition as ActorDefinitionWithDesc;
            actorDefinitions.id = actor.id;
            actorDefinitions.readme = truncateActorReadme(actorDefinitions.readme || '', limit);
            actorDefinitions.description = actor.description || '';
            actorDefinitions.actorFullName = `${actor.username}/${actor.name}`;
            actorDefinitions.defaultRunOptions = actor.defaultRunOptions;
            return pruneActorDefinition(actorDefinitions);
        }
        return null;
    } catch (error) {
        const errorMessage = `Failed to fetch input schema for Actor: ${actorIdOrName} with error ${error}.`;
        log.error(errorMessage);
        throw new Error(errorMessage);
    }
}

function pruneActorDefinition(response: ActorDefinitionWithDesc): ActorDefinitionPruned {
    return {
        id: response.id,
        actorFullName: response.actorFullName || '',
        buildTag: response?.buildTag || '',
        readme: response?.readme || '',
        input: response?.input && 'type' in response.input && 'properties' in response.input
            ? { ...response.input,
                type: response.input.type as string,
                properties: response.input.properties as Record<string, ISchemaProperties> }
            : undefined,
        description: response.description,
        defaultRunOptions: response.defaultRunOptions,
    };
}

/** Prune Actor README if it is too long
 * If the README is too long
 * - We keep the README as it is up to the limit.
 * - After the limit, we keep heading only
 * - We add a note that the README was truncated because it was too long.
 */
export function truncateActorReadme(readme: string, limit = ACTOR_README_MAX_LENGTH): string {
    if (readme.length <= limit) {
        return readme;
    }
    const readmeFirst = readme.slice(0, limit);
    const readmeRest = readme.slice(limit);
    const lines = readmeRest.split('\n');
    const prunedReadme = lines.filter((line) => line.startsWith('#'));
    return `${readmeFirst}\n\nREADME was truncated because it was too long. Remaining headers:\n${prunedReadme.join(', ')}`;
}
