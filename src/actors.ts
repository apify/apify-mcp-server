import { Ajv } from 'ajv';
import { ApifyClient } from 'apify-client';

import { ACTOR_ADDITIONAL_INSTRUCTIONS, defaults, MAX_DESCRIPTION_LENGTH, ACTOR_README_MAX_LENGTH, ACTOR_ENUM_MAX_LENGTH } from './const.js';
import { log } from './logger.js';
import type { ActorDefinitionPruned, ActorDefinitionWithDesc, IActorInputSchema, ISchemaProperties, Tool } from './types.js';

export function actorNameToToolName(actorName: string): string {
    return actorName
        .replace(/\//g, '-slash-')
        .replace(/\./g, '-dot-')
        .slice(0, 64);
}

/**
 * Get actor input schema by actor name.
 * First, fetch the actor details to get the default build tag and buildId.
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

/**
 * Helper function to shorten the enum list if it is too long.
 *
 * @param {string[]} enumList - The list of enum values to be shortened.
 * @returns {string[] | undefined} - The shortened enum list or undefined if the list is too long.
 */
export function shortenEnum(enumList: string[]): string[] | undefined {
    let charCount = 0;
    const resultEnumList = enumList.filter((enumValue) => {
        charCount += enumValue.length;
        return charCount <= ACTOR_ENUM_MAX_LENGTH;
    });

    return resultEnumList.length > 0 ? resultEnumList : undefined;
}

/**
 * Shortens the description, enum, and items.enum properties of the schema properties.
 * @param properties
 */
export function shortenProperties(properties: { [key: string]: ISchemaProperties}): { [key: string]: ISchemaProperties } {
    for (const property of Object.values(properties)) {
        if (property.description.length > MAX_DESCRIPTION_LENGTH) {
            property.description = `${property.description.slice(0, MAX_DESCRIPTION_LENGTH)}...`;
        }

        if (property.enum && property.enum?.length > 0) {
            property.enum = shortenEnum(property.enum);
        }

        if (property.items?.enum && property.items.enum.length > 0) {
            property.items.enum = shortenEnum(property.items.enum);
        }
    }

    return properties;
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
/**
 * Helps determine the type of items in an array schema property.
 * Priority order: explicit type in items > prefill type > default value type > editor type.
 *
 * Based on JSON schema, the array needs a type, and most of the time Actor input schema does not have this, so we need to infer that.
 *
 */
export function inferArrayItemType(property: ISchemaProperties): string | null {
    return property.items?.type
        || (Array.isArray(property.prefill) && property.prefill.length > 0 && typeof property.prefill[0])
        || (Array.isArray(property.default) && property.default.length > 0 && typeof property.default[0])
        || (property.editor && getEditorItemType(property.editor))
        || null;

    function getEditorItemType(editor: string): string | null {
        const editorTypeMap: Record<string, string> = {
            requestListSources: 'object',
            stringList: 'string',
            json: 'object',
            globs: 'object',
        };
        return editorTypeMap[editor] || null;
    }
}

/**
 * Add enum values as string to property descriptions.
 *
 * This is done as a preventive measure to prevent cases where library or agent framework
 * does not handle enums or examples based on JSON schema definition.
 *
 * https://json-schema.org/understanding-json-schema/reference/enum
 * https://json-schema.org/understanding-json-schema/reference/annotations
 *
 * @param properties
 */
function addEnumsToDescriptionsWithExamples(properties: Record<string, ISchemaProperties>): Record<string, ISchemaProperties> {
    for (const property of Object.values(properties)) {
        if (property.enum && property.enum.length > 0) {
            property.description = `${property.description}\nPossible values: ${property.enum.slice(0, 20).join(',')}`;
        }
        const value = property.prefill ?? property.default;
        if (value && !(Array.isArray(value) && value.length === 0)) {
            property.examples = Array.isArray(value) ? value : [value];
            property.description = `${property.description}\nExample values: ${JSON.stringify(value)}`;
        }
    }
    return properties;
}

/**
 * Filters schema properties to include only the necessary fields.
 *
 * This is done to reduce the size of the input schema and to make it more readable.
 *
 * @param properties
 */
export function filterSchemaProperties(properties: { [key: string]: ISchemaProperties }): { [key: string]: ISchemaProperties } {
    const filteredProperties: { [key: string]: ISchemaProperties } = {};
    for (const [key, property] of Object.entries(properties)) {
        filteredProperties[key] = {
            title: property.title,
            description: property.description,
            enum: property.enum,
            type: property.type,
            default: property.default,
            prefill: property.prefill,
            properties: property.properties,
            items: property.items,
            required: property.required,
        };
        if (property.type === 'array' && !property.items?.type) {
            const itemsType = inferArrayItemType(property);
            if (itemsType) {
                filteredProperties[key].items = {
                    ...filteredProperties[key].items,
                    title: filteredProperties[key].title ?? 'Item',
                    description: filteredProperties[key].description ?? 'Item',
                    type: itemsType,
                };
            }
        }
    }
    return filteredProperties;
}

/**
 * Marks input properties as required by adding a "REQUIRED" prefix to their descriptions.
 * Takes an IActorInput object and returns a modified Record of SchemaProperties.
 *
 * This is done for maximum compatibility in case where library or agent framework does not consider
 * required fields and does not handle the JSON schema properly: we are prepending this to the description
 * as a preventive measure.
 * @param {IActorInputSchema} input - Actor input object containing properties and required fields
 * @returns {Record<string, ISchemaProperties>} - Modified properties with required fields marked
 */
function markInputPropertiesAsRequired(input: IActorInputSchema): Record<string, ISchemaProperties> {
    const { required = [], properties } = input;

    for (const property of Object.keys(properties)) {
        if (required.includes(property)) {
            properties[property] = {
                ...properties[property],
                description: `**REQUIRED** ${properties[property].description}`,
            };
        }
    }

    return properties;
}

/**
 * Builds nested properties for object types in the schema.
 *
 * Specifically handles special cases like proxy configuration and request list sources
 * by adding predefined nested properties to these object types.
 * This is necessary for the agent to correctly infer how to structure object inputs
 * when passing arguments to the Actor.
 *
 * For proxy objects (type='object', editor='proxy'), adds 'useApifyProxy' property.
 * For request list sources (type='array', editor='requestListSources'), adds URL structure to items.
 *
 * @param {Record<string, ISchemaProperties>} properties - The input schema properties
 * @returns {Record<string, ISchemaProperties>} Modified properties with nested properties
 */
function buildNestedProperties(properties: Record<string, ISchemaProperties>): Record<string, ISchemaProperties> {
    const clonedProperties = { ...properties };

    for (const [propertyName, property] of Object.entries(clonedProperties)) {
        if (property.type === 'object' && property.editor === 'proxy') {
            clonedProperties[propertyName] = {
                ...property,
                properties: {
                    ...property.properties,
                    useApifyProxy: {
                        title: 'Use Apify Proxy',
                        type: 'boolean',
                        description: 'Whether to use Apify Proxy - ALWAYS SET TO TRUE.',
                        default: true,
                        examples: [true],
                    },
                },
                required: ['useApifyProxy'],
            };
        } else if (property.type === 'array' && property.editor === 'requestListSources') {
            clonedProperties[propertyName] = {
                ...property,
                items: {
                    ...property.items,
                    type: 'object',
                    title: 'Request list source',
                    description: 'Request list source',
                    properties: {
                        url: {
                            title: 'URL',
                            type: 'string',
                            description: 'URL of the request list source',
                        },
                    },
                },
            };
        }
    }

    return clonedProperties;
}

/**
 * Fetches actor input schemas by Actor IDs or Actor full names and creates MCP tools.
 *
 * This function retrieves the input schemas for the specified actors and compiles them into MCP tools.
 * It uses the AJV library to validate the input schemas.
 *
 * Tool name can't contain /, so it is replaced with _
 *
 * The input schema processing workflow:
 * 1. Properties are marked as required using markInputPropertiesAsRequired() to add "REQUIRED" prefix to descriptions
 * 2. Nested properties are built by analyzing editor type (proxy, requestListSources) using buildNestedProperties()
 * 3. Properties are filtered using filterSchemaProperties()
 * 4. Properties are shortened using shortenProperties()
 * 5. Enums are added to descriptions with examples using addEnumsToDescriptionsWithExamples()
 *
 * @param {string[]} actors - An array of actor IDs or Actor full names.
 * @returns {Promise<Tool[]>} - A promise that resolves to an array of MCP tools.
 */
export async function getActorsAsTools(actors: string[]): Promise<Tool[]> {
    const ajv = new Ajv({ coerceTypes: 'array', strict: false });
    const results = await Promise.all(actors.map(getActorDefinition));
    const tools = [];
    for (const result of results) {
        if (result) {
            if (result.input && 'properties' in result.input && result.input) {
                result.input.properties = markInputPropertiesAsRequired(result.input);
                result.input.properties = buildNestedProperties(result.input.properties);
                result.input.properties = filterSchemaProperties(result.input.properties);
                result.input.properties = shortenProperties(result.input.properties);
                result.input.properties = addEnumsToDescriptionsWithExamples(result.input.properties);
            }
            try {
                const memoryMbytes = result.defaultRunOptions?.memoryMbytes || defaults.maxMemoryMbytes;
                tools.push({
                    name: actorNameToToolName(result.actorFullName),
                    actorFullName: result.actorFullName,
                    description: `${result.description} Instructions: ${ACTOR_ADDITIONAL_INSTRUCTIONS}`,
                    inputSchema: result.input || {},
                    ajvValidate: ajv.compile(result.input || {}),
                    memoryMbytes: memoryMbytes > defaults.maxMemoryMbytes ? defaults.maxMemoryMbytes : memoryMbytes,
                });
            } catch (validationError) {
                log.error(`Failed to compile AJV schema for Actor: ${result.actorFullName}. Error: ${validationError}`);
            }
        }
    }
    return tools;
}
