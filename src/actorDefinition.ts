import { Ajv } from 'ajv';
import { ApifyClient } from 'apify-client';

import { log } from './logger.js';
import type { ActorDefinitionWithDesc, Tool } from './types';

/**
 * Get actor input schema by actor name.
 * First, fetch the actor details to get the default build tag and buildId.
 * Then, fetch the build details and return actorName, description, and input schema.
 * @param {string} actorFullName - The full name of the actor.
 * @returns {Promise<ActorDefinitionWithDesc | null>} - The actor definition with description or null if not found.
 */
async function fetchActorDefinition(actorFullName: string): Promise<ActorDefinitionWithDesc | null> {
    if (!process.env.APIFY_API_TOKEN) {
        log.error('APIFY_API_TOKEN is required but not set. Please set it as an environment variable');
        return null;
    }
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

        if (!buildId) {
            log.error(`Failed to fetch input schema for actor: ${actorFullName}. Build ID not found.`);
            return null;
        }
        // Fetch build details and return the input schema
        const buildDetails = await client.build(buildId).get();
        if (buildDetails?.actorDefinition) {
            const actorDefinitions = buildDetails?.actorDefinition as ActorDefinitionWithDesc;
            actorDefinitions.description = actor.description || '';
            actorDefinitions.name = actorFullName;
            return actorDefinitions;
        }
        return null;
    } catch (error) {
        log.error(`Failed to fetch input schema for actor: ${actorFullName} with error ${error}.`);
        return null;
    }
}

/**
 * Fetches actor input schemas by actor full names and creates MCP tools.
 *
 * This function retrieves the input schemas for the specified actors and compiles them into MCP tools.
 * It uses the AJV library to validate the input schemas.
 *
 * @param {string[]} actors - An array of actor full names.
 * @returns {Promise<Tool[]>} - A promise that resolves to an array of MCP tools.
 */
export async function getActorsAsTools(actors: string[]): Promise<Tool[]> {
    // Fetch input schemas in parallel
    const ajv = new Ajv({ coerceTypes: 'array', strict: false });
    const results = await Promise.all(actors.map(fetchActorDefinition));
    const tools = [];
    for (const result of results) {
        if (result) {
            try {
                tools.push({
                    name: result.name.replace('/', '_'),
                    description: result.description,
                    inputSchema: result.input || {},
                    ajvValidate: ajv.compile(result.input || {}),
                });
            } catch (validationError) {
                log.error(`Failed to compile AJV schema for actor: ${result.name}. Error: ${validationError}`);
            }
        }
    }
    return tools;
}
