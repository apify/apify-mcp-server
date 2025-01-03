import { Ajv } from 'ajv';
import type { ActorDefinition } from 'apify-client';
import { ApifyClient } from 'apify-client';

import { log } from './logger.js';

interface ActorDefinitionWithDesc extends ActorDefinition {
    description: string;
}

/**
 * Get actor input schema by actor name.
 * First, fetch the actor details to get the default build tag and buildId.
 * Then, fetch the build details and return actorName, description, and input schema.
 * @param actorFullName
 */
async function fetchActorDefinition(actorFullName: string): Promise<ActorDefinitionWithDesc | null> {
    const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
    const actorClient = client.actor(actorFullName);

    try {
        // Fetch actor details
        const actor = await actorClient.get();
        if (!actor) {
            log.error(`Failed to fetch input schema for actor: ${actorFullName}. Actor not found.`);
            return null;
        }

        // Extract default build label
        const tag = actor.defaultRunOptions?.build || '';
        const buildId = actor.taggedBuilds?.[tag]?.buildId || '';
        const description = actor.description || '';

        if (!buildId) {
            log.error(`Failed to fetch input schema for actor: ${actorFullName}. Build ID not found.`);
            return null;
        }
        // Fetch build details and return the input schema
        const buildDetails = await client.build(buildId).get();
        if (buildDetails && 'actorDefinition' in buildDetails) {
            // The buildDetails schema contains actorDefinitions but return type is ActorDefinition
            const actorDefinitions = buildDetails?.actorDefinition as ActorDefinitionWithDesc;
            actorDefinitions.description = description;
            // Change the name to the actorFullName (we need to tools with a full name to call the actor)
            actorDefinitions.name = actorFullName;
            return actorDefinitions;
        }
        return null;
    } catch (error) {
        log.error(`Failed to fetch input schema for actor: ${actorFullName} with error ${error}.`);
        return null;
    }
}

export async function getActorsAsTools(actorNames: string[]) {
    // Fetch input schemas in parallel
    const ajv = new Ajv({ coerceTypes: 'array', strict: false });
    const results = await Promise.all(actorNames.map(fetchActorDefinition));
    const tools = [];
    for (const result of results) {
        if (result) {
            tools.push({
                name: result.name,
                description: result.description,
                inputSchema: result.input || {},
                ajvValidate: ajv.compile(result.input || {}),
            });
        }
    }
    return tools;
}

// getActorsAsTools(['apify/rag-web-browser', 'apify/google-search-scraper']).catch((error) => log.error('Global Error:', error));
