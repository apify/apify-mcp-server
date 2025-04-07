import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { getActorDefinition } from '../actors/details.js';
import { filterSchemaProperties, shortenProperties } from '../actors/schema.js';
import { ACTOR_README_MAX_LENGTH, InternalTools } from '../const.js';
import type { InternalTool, ISchemaProperties, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

export const GetActorDefinition = z.object({
    actorName: z.string()
        .describe('Retrieve input, readme, and other details for Actor ID or Actor full name. '
            + 'Actor name is always composed from `username/name`'),
    limit: z.number()
        .int()
        .default(ACTOR_README_MAX_LENGTH)
        .describe(`Truncate the README to this limit. Default value is ${ACTOR_README_MAX_LENGTH}.`),
});

export const getActorsDetailsTool: ToolWrap = {
    type: 'internal',
    tool: {
        name: InternalTools.GET_ACTOR_DETAILS,
        actorFullName: InternalTools.GET_ACTOR_DETAILS,
        description: 'Get documentation, readme, input schema and other details about an Actor. '
            + 'For example, when user says, I need to know more about web crawler Actor.'
            + 'Get details for an Actor with with Actor ID or Actor full name, i.e. username/name.'
            + `Limit the length of the README if needed.`,
        inputSchema: zodToJsonSchema(GetActorDefinition),
        ajvValidate: ajv.compile(zodToJsonSchema(GetActorDefinition)),
        call: async (toolArgs) => {
            const { args } = toolArgs;

            const parsed = GetActorDefinition.parse(args);
            const v = await getActorDefinition(parsed.actorName, parsed.limit);
            if (v && v.input && 'properties' in v.input && v.input) {
                const properties = filterSchemaProperties(v.input.properties as { [key: string]: ISchemaProperties });
                v.input.properties = shortenProperties(properties);
            }
            return { content: [{ type: 'text', text: JSON.stringify(v) }] };
        },
    } as InternalTool,
};
