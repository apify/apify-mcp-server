import { z } from 'zod';

import { HelperTools, TOOL_MAX_OUTPUT_CHARS, TOOL_STATUS } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { compileSchema } from '../utils/ajv.js';
import { getValuesByDotKeys, parseCommaSeparatedList } from '../utils/generic.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { createApifyClientWithSkyfireSupport, validateSkyfirePayId } from '../utils/skyfire.js';

/**
 * Zod schema for get-actor-output tool arguments
 */
const getActorOutputArgs = z.object({
    datasetId: z.string()
        .min(1)
        .describe('Actor output dataset ID to retrieve from.'),
    fields: z.string()
        .optional()
        .describe('Comma-separated list of fields to include (supports dot notation like "crawl.statusCode"). For example: "crawl.statusCode,text,metadata"'),
    offset: z.number()
        .optional()
        .default(0)
        .describe('Number of items to skip (default: 0).'),
    limit: z.number()
        .optional()
        .default(100)
        .describe('Maximum number of items to return (default: 100).'),
});

/**
 * Cleans empty properties (null, undefined, empty strings, empty arrays, empty objects) from an object
 * @param obj - The object to clean
 * @returns The cleaned object or undefined if the result is empty
 */
export function cleanEmptyProperties(obj: unknown): unknown {
    if (obj === null || obj === undefined || obj === '') {
        return undefined;
    }

    if (typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        const cleaned = obj
            .map((item) => cleanEmptyProperties(item))
            .filter((item) => item !== undefined);
        return cleaned.length > 0 ? cleaned : undefined;
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const cleanedValue = cleanEmptyProperties(value);
        if (cleanedValue !== undefined) {
            cleaned[key] = cleanedValue;
        }
    }

    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * This tool is used specifically for retrieving Actor output.
 * It is a simplified version of the get-dataset-items tool.
 */
export const getActorOutput: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_OUTPUT_GET,
    description: `Retrieve the output dataset items of a specific Actor run using its datasetId.
You can select specific fields to return (supports dot notation like "crawl.statusCode") and paginate results with offset and limit.
This tool is a simplified version of the get-dataset-items tool, focused on Actor run outputs.

The results will include the dataset items from the specified dataset. If you provide fields, only those fields will be included (nested fields supported via dot notation).

You can obtain the datasetId from an Actor run (e.g., after calling an Actor with the call-actor tool) or from the Apify Console (Runs → Run details → Dataset ID).

USAGE:
- Use when you need to read Actor output data (full items or selected fields), especially when preview does not include all fields.

USAGE EXAMPLES:
- user_input: Get data of my last Actor run
- user_input: Get number_of_likes from my dataset
- user_input: Return only crawl.statusCode and url from dataset aab123

Note: This tool is automatically included if the Apify MCP Server is configured with any Actor tools (e.g., "apify-slash-rag-web-browser") or tools that can interact with Actors (e.g., "call-actor", "add-actor").`,
    inputSchema: z.toJSONSchema(getActorOutputArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getActorOutputArgs), additionalProperties: true }),
    annotations: {
        title: 'Get Actor output',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;

        const skyfireError = validateSkyfirePayId(apifyMcpServer, args);
        if (skyfireError) return skyfireError;

        const apifyClient = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const parsed = getActorOutputArgs.parse(args);

        // Parse fields into array
        const fieldsArray = parseCommaSeparatedList(parsed.fields);

        // TODO: we can optimize the API level field filtering in future
        /**
             * Only top-level fields can be filtered.
             * If a dot is present, filtering is done here and not at the API level.
             */
        const hasDot = fieldsArray.some((field) => field.includes('.'));
        const response = await apifyClient.dataset(parsed.datasetId).listItems({
            offset: parsed.offset,
            limit: parsed.limit,
            fields: fieldsArray.length > 0 && !hasDot ? fieldsArray : undefined,
            clean: true,
        });

        if (!response) {
            return buildMCPResponse({
                texts: [`Dataset '${parsed.datasetId}' not found.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }

        let { items } = response;
        // Apply field selection if specified
        if (fieldsArray.length > 0) {
            items = items.map((item) => getValuesByDotKeys(item, fieldsArray));
        }

        // Clean empty properties
        const cleanedItems = items
            .map((item) => cleanEmptyProperties(item))
            .filter((item) => item !== undefined);

        let outputText = `\`\`\`json\n${JSON.stringify(cleanedItems)}\n\`\`\``;
        let truncated = false;
        if (outputText.length > TOOL_MAX_OUTPUT_CHARS) {
            outputText = outputText.slice(0, TOOL_MAX_OUTPUT_CHARS);
            truncated = true;
        }
        if (truncated) {
            outputText += `\n\n[Output was truncated to ${TOOL_MAX_OUTPUT_CHARS} characters to comply with the tool output limits.]`;
        }
        return { content: [{ type: 'text', text: outputText }] };
    },
} as const;
