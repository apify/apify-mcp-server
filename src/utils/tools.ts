import { ADVANCED_INPUT_KEY } from '../const.js';
import type { IActorInputSchema, ToolBase } from '../types.js';

/**
 * Returns a public version of the tool containing only fields that should be exposed publicly.
 * Used for the tools list request.
 */
export function getToolPublicFieldOnly(tool: ToolBase) {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: clearAdvancedInputProperties(tool.inputSchema as IActorInputSchema),
    };
}

/** Removes properties under ADVANCED_INPUT_KEY from the schema */
function clearAdvancedInputProperties(schema: IActorInputSchema): IActorInputSchema {
    if (schema.properties && ADVANCED_INPUT_KEY in schema.properties) {
        return {
            ...schema,
            properties: {
                ...schema.properties,
                [ADVANCED_INPUT_KEY]: {
                    ...schema.properties[ADVANCED_INPUT_KEY],
                    properties: {},
                    additionalProperties: true,
                },
            },
        };
    }

    return schema;
}
