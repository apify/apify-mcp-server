import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { apifyApiDetailsOutputSchema } from '../structured_output_schemas.js';
import {
    findPathOperations,
    formatApiPath,
    formatList,
    normalizeApiPath,
    redactApiCallArgs,
} from './apify_api_request.js';
import { API_METHODS, fetchApiOperationIndex } from './apify_api_spec.js';

const apifyApiDetailsArgs = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            'The API path, as a template such as /v2/datasets/{datasetId} or with its values in it, ' +
                'such as /v2/datasets/abc. datasets/abc, v2/datasets/abc, and /v2/datasets/abc are the same.',
        ),
    method: z
        .enum(API_METHODS)
        .optional()
        .describe('HTTP method of the operation. Omit it to get every operation on the path.'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const findPath = hasTool(HELPER_TOOLS.API_SEARCH) ? ` Find the path with ${HELPER_TOOLS.API_SEARCH}.` : '';
    return dedent`
        Get the Apify API operations on a path: for each method, its description, path and query
        parameters, and the JSON schema of its request body.${findPath}
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
        const normalizedPath = normalizeApiPath(parsed.path);
        const path = formatApiPath(normalizedPath);
        const matched = findPathOperations(index, normalizedPath);
        if (matched.length === 0) {
            const next = toolArgs.loadedToolNames.includes(HELPER_TOOLS.API_SEARCH)
                ? ` Find the path with ${HELPER_TOOLS.API_SEARCH}.`
                : '';
            return respondUserError(
                `The path ${path} is not in the API spec. A name is written username~name, as in ` +
                    `/v2/acts/john~my-actor.${next}`,
            );
        }
        const operations = parsed.method ? matched.filter((operation) => operation.method === parsed.method) : matched;
        if (operations.length === 0) {
            const noun = matched.length === 1 ? 'method' : 'methods';
            const methods = formatList(
                matched.map((operation) => operation.method),
                'and',
            );
            return respondUserError(
                `The path ${path} has no ${parsed.method} operation; it matches ${noun} ${methods}.`,
            );
        }
        const result = {
            operations: operations.map((operation) => ({
                method: operation.method,
                path: operation.path,
                summary: operation.summary,
                description: operation.description,
                parameters: operation.parameters,
                ...(operation.requestBody && { requestBody: operation.requestBody }),
            })),
        };
        const summary = `${operations[0].path}: ${operations.map((operation) => operation.method).join(', ')}.`;
        return respondOk([JSON.stringify(result), summary], { structuredContent: result });
    },
} as const);
