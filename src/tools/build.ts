import { Ajv } from 'ajv';
import type { Actor, ActorDefinition } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import { ACTOR_README_MAX_LENGTH, ADVANCED_INPUT_KEY, HelperTools } from '../const.js';
import type {
    ActorDefinitionPruned,
    ActorDefinitionWithDesc,
    InternalTool,
    ISchemaProperties,
    ToolEntry,
} from '../types.js';
import { filterSchemaProperties, shortenProperties } from './utils.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

/**
 * Get Actor input schema by Actor name.
 * First, fetch the Actor details to get the default build tag and buildId.
 * Then, fetch the build details and return actorName, description, and input schema.
 * @param {string} actorIdOrName - Actor ID or Actor full name.
 * @param {number} limit - Truncate the README to this limit.
 * @param {string} apifyToken
 * @returns {Promise<ActorDefinitionWithDesc | null>} - The actor definition with description or null if not found.
 */
export async function getActorDefinition(
    actorIdOrName: string,
    apifyToken: string,
    limit: number = ACTOR_README_MAX_LENGTH,
    fullActorSchema = true,
): Promise<ActorDefinitionPruned | null> {
    const client = new ApifyClient({ token: apifyToken });
    const actorClient = client.actor(actorIdOrName);
    try {
        // Fetch actor details
        const actor = await actorClient.get();
        if (!actor) {
            log.error(`Failed to fetch input schema for Actor: ${actorIdOrName}. Actor not found.`);
            return null;
        }

        const defaultBuildClient = await actorClient.defaultBuild();
        const buildDetails = await defaultBuildClient.get();

        if (buildDetails?.actorDefinition) {
            return processActorDefinition(actor, buildDetails.actorDefinition, limit, fullActorSchema);
        }
        return null;
    } catch (error) {
        const errorMessage = `Failed to fetch input schema for Actor: ${actorIdOrName} with error ${error}.`;
        log.error(errorMessage);
        throw new Error(errorMessage);
    }
}
export function processActorDefinition(
    actor: Actor,
    definition: ActorDefinition,
    limit: number,
    fullActorSchema: boolean,
): ActorDefinitionPruned {
    let input;
    if (definition?.input && 'type' in definition.input && 'properties' in definition.input) {
        input = {
            ...definition.input,
            type: definition.input.type as string,
            properties: definition.input.properties as Record<string, ISchemaProperties>,
        };
        if (!fullActorSchema) {
            input = separateAdvancedInputs(input);
        }
    }
    return {
        id: actor.id,
        actorFullName: `${actor.username}/${actor.name}`,
        buildTag: definition?.buildTag || '',
        readme: truncateActorReadme(definition.readme || '', limit),
        input,
        description: actor.description || '',
        defaultRunOptions: actor.defaultRunOptions,
        webServerMcpPath: 'webServerMcpPath' in definition ? definition.webServerMcpPath as string : undefined,
    };
}

function separateAdvancedInputs(input: ActorDefinitionWithDesc['input']): ActorDefinitionPruned['input'] {
    if (!input || !input.properties) {
        return input;
    }

    const properties = Object.entries(input.properties);
    const firstSectionCaptionIndex = properties.findIndex(([_key, value]) => value.sectionCaption);
    if (firstSectionCaptionIndex === -1) {
        // No advanced inputs, return the input as is
        return input;
    }

    // Separate advanced inputs from the main section
    const mainInputs = properties.slice(0, firstSectionCaptionIndex);
    const advancedInputs = properties.slice(firstSectionCaptionIndex);

    const propObject = Object.fromEntries(mainInputs);
    propObject[ADVANCED_INPUT_KEY] = {
        type: 'object',
        title: 'Advanced Inputs',
        description: 'These inputs are considered advanced and are not required for basic functionality.',
        properties: Object.fromEntries(advancedInputs),
    };

    return { ...input, properties: propObject };
}

/** Prune Actor README if it is too long
 * If the README is too long
 * - We keep the README as it is up to the limit.
 * - After the limit, we keep heading only
 * - We add a note that the README was truncated because it was too long.
 */
function truncateActorReadme(readme: string, limit = ACTOR_README_MAX_LENGTH): string {
    if (readme.length <= limit) {
        return readme;
    }
    const readmeFirst = readme.slice(0, limit);
    const readmeRest = readme.slice(limit);
    const lines = readmeRest.split('\n');
    const prunedReadme = lines.filter((line) => line.startsWith('#'));
    return `${readmeFirst}\n\nREADME was truncated because it was too long. Remaining headers:\n${prunedReadme.join(', ')}`;
}

const getActorDefinitionArgsSchema = z.object({
    actorName: z.string()
        .min(1)
        .describe('Retrieve input, readme, and other details for Actor ID or Actor full name. '
            + 'Actor name is always composed from `username/name`'),
    limit: z.number()
        .int()
        .default(ACTOR_README_MAX_LENGTH)
        .describe(`Truncate the README to this limit. Default value is ${ACTOR_README_MAX_LENGTH}.`),
});

/**
 * https://docs.apify.com/api/v2/actor-build-get
 */
export const actorDefinitionTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_GET_DETAILS,
        // TODO: remove actorFullName from internal tools
        actorFullName: HelperTools.ACTOR_GET_DETAILS,
        description: 'Get documentation, readme, input schema and other details about an Actor. '
            + 'For example, when user says, I need to know more about web crawler Actor.'
            + 'Get details for an Actor with with Actor ID or Actor full name, i.e. username/name.'
            + `Limit the length of the README if needed.`,
        inputSchema: zodToJsonSchema(getActorDefinitionArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(getActorDefinitionArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;

            const parsed = getActorDefinitionArgsSchema.parse(args);
            const v = await getActorDefinition(parsed.actorName, apifyToken, parsed.limit);
            if (!v) {
                return { content: [{ type: 'text', text: `Actor '${parsed.actorName}' not found.` }] };
            }
            if (v && v.input && 'properties' in v.input && v.input) {
                const properties = filterSchemaProperties(v.input.properties as { [key: string]: ISchemaProperties });
                v.input.properties = shortenProperties(properties);
            }
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};
