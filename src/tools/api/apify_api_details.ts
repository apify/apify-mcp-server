import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { apifyApiDetailsOutputSchema } from '../structured_output_schemas.js';
import { redactApiCallArgs, resolveMethodOperation, resolvePathOperations } from './apify_api_request.js';
import { API_METHODS, fetchApiOperationIndex, isRecord } from './apify_api_spec.js';

const apifyApiDetailsArgs = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            'The API path, as a template such as /v2/datasets/{datasetId} or with its values in it, ' +
                'such as /v2/datasets/abc.',
        ),
    method: z
        .enum(API_METHODS)
        .optional()
        .describe('HTTP method of the operation. Omit it to get every operation on the path.'),
});

/**
 * A copy of a body schema without the refused fields, at its top level and in its `allOf`/`anyOf`/`oneOf`
 * parts, the same places the refusal looks. The agent may not send them, and their schemas cost context.
 */
function omitRefusedFields(schema: unknown, refusedBodyFields: readonly string[]): unknown {
    if (!isRecord(schema)) return schema;
    const result: Record<string, unknown> = { ...schema };
    if (isRecord(schema.properties)) {
        result.properties = Object.fromEntries(
            Object.entries(schema.properties).filter(([name]) => !refusedBodyFields.includes(name)),
        );
    }
    if (Array.isArray(schema.required)) {
        result.required = schema.required.filter((name) => !refusedBodyFields.includes(name));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
        const parts = schema[key];
        if (Array.isArray(parts)) result[key] = parts.map((part) => omitRefusedFields(part, refusedBodyFields));
    }
    return result;
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? ` Find the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    return dedent`
        Get the Apify API operations on a path: for each method, its description, path and query
        parameters, and the JSON schema of its request body. Also returns each operation's access (read,
        write, or unavailable with the reason) and the body fields the API tools refuse to set.${findPath}
        Give a method to get only that operation, for example {"path": "/v2/datasets/abc", "method": "PUT"}.

        USAGE:
        - Use before calling an operation, to pass the right parameters and body.

        USAGE EXAMPLES:
        - user_input: What parameters does the dataset items operation take?
        - user_input: How do I update a webhook through the API?
    `;
}

/**
 * Returns the operations on one path of the published Apify API spec, https://docs.apify.com/api/v2.
 */
export const apifyApiDetails: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.API_DETAILS,
    title: 'Get Apify API operation details',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(apifyApiDetailsArgs) as ToolInputSchema,
    outputSchema: apifyApiDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(apifyApiDetailsArgs)),
    annotations: {
        title: 'Get Apify API operation details',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    // Only path and method are declared; a query written into a pasted path, such as ?token=, is cut.
    redactArgs: redactApiCallArgs,
    call: async (toolArgs: InternalToolArgs) => {
        const parsed = apifyApiDetailsArgs.parse(toolArgs.args);
        const index = await fetchApiOperationIndex();
        const matched = resolvePathOperations({
            index,
            path: parsed.path,
            loadedToolNames: toolArgs.loadedToolNames,
            canBeTemplate: true,
        });
        if ('error' in matched) return respondUserError(matched.error);
        let { operations } = matched;
        if (parsed.method) {
            const resolved = resolveMethodOperation(matched.path, operations, parsed.method);
            if ('error' in resolved) return respondUserError(resolved.error);
            operations = [resolved.operation];
        }
        const result = {
            operations: operations.map((operation) => ({
                method: operation.method,
                path: operation.path,
                summary: operation.summary,
                description: operation.description,
                access: operation.access,
                ...(operation.unavailableReason && { unavailableReason: operation.unavailableReason }),
                parameters: operation.parameters,
                ...(operation.requestBody && {
                    requestBody: {
                        ...operation.requestBody,
                        schema: omitRefusedFields(operation.requestBody.schema, operation.refusedBodyFields),
                    },
                }),
                refusedBodyFields: operation.refusedBodyFields,
            })),
        };
        const methods = operations.map((operation) => `${operation.method} (${operation.access})`).join(', ');
        const summary = `${operations[0].path}: ${methods}.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
