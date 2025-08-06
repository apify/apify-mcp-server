import type { IActorInputSchema, ToolBase } from '../types.js';

/**
 * Returns a public version of the tool containing only fields that should be exposed publicly.
 * Used for the tools list request.
 */
export function getToolPublicFieldOnly(tool: ToolBase) {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: simplifiedSchema(tool.inputSchema as IActorInputSchema),
    };
}

function simplifiedSchema(schema: IActorInputSchema): IActorInputSchema {
    if (schema.properties && 'advancedInputs' in schema.properties) {
        return {
            ...schema,
            properties: {
                ...schema.properties,
                advancedInputs: {
                    ...schema.properties.advancedInputs,
                    properties: {},
                    additionalProperties: true,
                },
            },
        };
    }

    return schema;
}
