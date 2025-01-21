import { Ajv } from 'ajv';
import { ApifyClient } from 'apify-client';

import { MAX_DESCRIPTION_LENGTH, MAX_ENUM_LENGTH, MAX_MEMORY_MBYTES } from './const.js';
import { log } from './logger.js';
import type { ActorDefinitionWithDesc, SchemaProperties, Tool } from './types.js';

/**
 * Get actor input schema by actor name.
 * First, fetch the actor details to get the default build tag and buildId.
 * Then, fetch the build details and return actorName, description, and input schema.
 * @param {string} actorFullName - The full name of the actor.
 * @returns {Promise<ActorDefinitionWithDesc | null>} - The actor definition with description or null if not found.
 */
async function fetchActorDefinition(actorFullName: string): Promise<ActorDefinitionWithDesc | null> {
    if (!process.env.APIFY_TOKEN) {
        log.error('APIFY_TOKEN is required but not set. Please set it as an environment variable');
        return null;
    }
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    const actorClient = client.actor(actorFullName);

    try {
        // Fetch actor details
        const actor = await actorClient.get();
        if (!actor) {
            log.error(`Failed to fetch input schema for actor: ${actorFullName}. Actor not found.`);
            return null;
        }

        // fnesveda: The default build is not necessarily tagged, you can specify any build number as default build.
        // There will be a new API endpoint to fetch a default build.
        // For now, we'll use the tagged build, it will work for 90% of Actors. Later, we can update this.
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
            actorDefinitions.defaultRunOptions = actor.defaultRunOptions;
            return actorDefinitions;
        }
        return null;
    } catch (error) {
        log.error(`Failed to fetch input schema for actor: ${actorFullName} with error ${error}.`);
        return null;
    }
}

/**
 * Shortens the description and enum values of schema properties.
 * @param properties
 */
function shortenProperties(properties: { [key: string]: SchemaProperties}): { [key: string]: SchemaProperties } {
    for (const property of Object.values(properties)) {
        if (property.description.length > MAX_DESCRIPTION_LENGTH) {
            property.description = `${property.description.slice(0, MAX_DESCRIPTION_LENGTH)}...`;
        }
        if (property.enum) {
            property.enum = property.enum.slice(0, MAX_ENUM_LENGTH);
        }
        if (property.enumTitles) {
            property.enumTitles = property.enumTitles.slice(0, MAX_ENUM_LENGTH);
        }
    }
    return properties;
}

/**
 * Filters schema properties to include only the necessary fields.
 * @param properties
 */
function filterSchemaProperties(properties: { [key: string]: SchemaProperties }): { [key: string]: SchemaProperties } {
    const filteredProperties: { [key: string]: SchemaProperties } = {};
    for (const [key, property] of Object.entries(properties)) {
        const { title, description, enum: enumValues, enumTitles, type, default: defaultValue, prefill } = property;
        filteredProperties[key] = { title, description, enum: enumValues, enumTitles, type, default: defaultValue, prefill };
    }
    return filteredProperties;
}

/**
 * Fetches actor input schemas by actor full names and creates MCP tools.
 *
 * This function retrieves the input schemas for the specified actors and compiles them into MCP tools.
 * It uses the AJV library to validate the input schemas.
 *
 * Tool name can't contain /, so it is replaced with _
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
            if (result.input && 'properties' in result.input && result.input) {
                const properties = filterSchemaProperties(result.input.properties as { [key: string]: SchemaProperties });
                result.input.properties = shortenProperties(properties);
            }
            try {
                const memoryMbytes = result.defaultRunOptions?.memoryMbytes || MAX_MEMORY_MBYTES;
                tools.push({
                    name: result.name.replace('/', '_'),
                    actorName: result.name,
                    description: result.description,
                    inputSchema: result.input || {},
                    ajvValidate: ajv.compile(result.input || {}),
                    memoryMbytes: memoryMbytes > MAX_MEMORY_MBYTES ? MAX_MEMORY_MBYTES : memoryMbytes,
                });
            } catch (validationError) {
                log.error(`Failed to compile AJV schema for actor: ${result.name}. Error: ${validationError}`);
            }
        }
    }
    return tools;
}
