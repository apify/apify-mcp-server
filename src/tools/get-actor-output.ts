import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, SKYFIRE_TOOL_INSTRUCTIONS, TOOL_MAX_OUTPUT_CHARS } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { getValuesByDotKeys, parseCommaSeparatedList } from '../utils/generic.js';

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
    tool: {
        name: HelperTools.ACTOR_OUTPUT_GET,
        actorFullName: HelperTools.ACTOR_OUTPUT_GET,
        description: `Fetch the dataset of a specific Actor run based on datasetId.
You can also retrieve only specific fields from the output if needed.

USAGE:
- Use this tool to get Actor dataset outside of the preview, or to access fields from the Actor output
dataset schema that are not included in the preview.

EXAMPLES:
- user_input: Get data of my last Actor run?
- user_input: Get number_of_likes from my dataset?

Note: This tool is automatically included if the Apify MCP Server is configured with any Actor tools
 (e.g. "apify-slash-rag-web-browser") or tools that can interact with Actors (e.g. "call-actor", "add-actor").`,
        inputSchema: zodToJsonSchema(getActorOutputArgs),
        /**
         * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
         */
        ajvValidate: ajv.compile({ ...zodToJsonSchema(getActorOutputArgs), additionalProperties: true }),
        call: async (toolArgs) => {
            const { args, apifyToken, apifyMcpServer } = toolArgs;

            /**
             * In Skyfire mode, we check for the presence of `skyfire-pay-id`.
             * If it is missing, we return instructions to the LLM on how to create it and pass it to the tool.
             */
            if (apifyMcpServer.options.skyfireMode
                && args['skyfire-pay-id'] === undefined
            ) {
                return {
                    content: [{
                        type: 'text',
                        text: SKYFIRE_TOOL_INSTRUCTIONS,
                    }],
                };
            }

            /**
             * Create Apify token, for Skyfire mode use `skyfire-pay-id` and for normal mode use `apifyToken`.
             */
            const apifyClient = apifyMcpServer.options.skyfireMode && typeof args['skyfire-pay-id'] === 'string'
                ? new ApifyClient({ skyfirePayId: args['skyfire-pay-id'] })
                : new ApifyClient({ token: apifyToken });
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
                return { content: [{ type: 'text', text: `Dataset '${parsed.datasetId}' not found.` }] };
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

            let outputText = JSON.stringify(cleanedItems);
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
    } as InternalTool,
};
