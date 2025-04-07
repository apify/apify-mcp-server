import { Ajv } from 'ajv';

import { ACTOR_ADDITIONAL_INSTRUCTIONS, defaults } from '../const.js';
import { log } from '../logger.js';
import type { ToolWrap } from '../types.js';
import { getActorDefinition } from './details.js';
import {
    addEnumsToDescriptionsWithExamples,
    buildNestedProperties,
    filterSchemaProperties,
    markInputPropertiesAsRequired,
    shortenProperties,
} from './schema.js';
import { actorNameToToolName } from './utils.js';

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
export async function getActorsAsTools(actors: string[]): Promise<ToolWrap[]> {
    const ajv = new Ajv({ coerceTypes: 'array', strict: false });
    const results = await Promise.all(actors.map(getActorDefinition));
    const tools: ToolWrap[] = [];
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
                    type: 'actor',
                    tool: {
                        name: actorNameToToolName(result.actorFullName),
                        actorFullName: result.actorFullName,
                        description: `${result.description} Instructions: ${ACTOR_ADDITIONAL_INSTRUCTIONS}`,
                        inputSchema: result.input || {},
                        ajvValidate: ajv.compile(result.input || {}),
                        memoryMbytes: memoryMbytes > defaults.maxMemoryMbytes ? defaults.maxMemoryMbytes : memoryMbytes,
                    },
                });
            } catch (validationError) {
                log.error(`Failed to compile AJV schema for Actor: ${result.actorFullName}. Error: ${validationError}`);
            }
        }
    }
    return tools;
}
