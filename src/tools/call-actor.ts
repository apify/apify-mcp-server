import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    HelperTools,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../const.js';
import type { ToolEntry } from '../types.js';
import { callActorGetDataset, getActorsAsTools } from '../utils/actor.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { ajv } from '../utils/ajv.js';
import { actorNameToToolName } from './utils.js';

const callActorArgs = z.object({
    actor: z.string()
        .describe('The name of the Actor to call. For example, "apify/rag-web-browser".'),
    step: z.enum(['info', 'call'])
        .default('info')
        .describe(`Step to perform: "info" to get Actor details and input schema (required first step), "call" to execute the Actor (only after getting info).`),
    input: z.object({}).passthrough()
        .optional()
        .describe(`The input JSON to pass to the Actor. For example, {"query": "apify", "maxResults": 5, "outputFormats": ["markdown"]}. Required only when step is "call".`),
    callOptions: z.object({
        memory: z.number()
            .min(128, 'Memory must be at least 128 MB')
            .max(32768, 'Memory cannot exceed 32 GB (32768 MB)')
            .optional()
            .describe(`Memory allocation for the Actor in MB. Must be a power of 2 (e.g., 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768). Minimum: 128 MB, Maximum: 32768 MB (32 GB).`),
        timeout: z.number()
            .min(0, 'Timeout must be 0 or greater')
            .optional()
            .describe(`Maximum runtime for the Actor in seconds. After this time elapses, the Actor will be automatically terminated. Use 0 for infinite timeout (no time limit). Minimum: 0 seconds (infinite).`),
    }).optional()
        .describe('Optional call options for the Actor run configuration.'),
});

export const callActor: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_CALL,
        actorFullName: HelperTools.ACTOR_CALL,
        description: `Call Any Actor from Apify Store - Two-Step Process

This tool uses a mandatory two-step process to safely call any Actor from the Apify store.

USAGE:
• ONLY for Actors that are NOT available as dedicated tools
• If a dedicated tool exists (e.g., ${actorNameToToolName('apify/rag-web-browser')}), use that instead

MANDATORY TWO-STEP WORKFLOW:

Step 1: Get Actor Info (step="info", default)
• First call this tool with step="info" to get Actor details and input schema
• This returns the Actor description, documentation, and required input schema
• You MUST do this step first - it's required to understand how to call the Actor

Step 2: Call Actor (step="call") 
• Only after step 1, call again with step="call" and proper input based on the schema
• This executes the Actor and returns the results

The step parameter enforces this workflow - you cannot call an Actor without first getting its info.`,
        inputSchema: zodToJsonSchema(callActorArgs),
        ajvValidate: ajv.compile({
            ...zodToJsonSchema(callActorArgs),
            // Additional props true to allow skyfire-pay-id
            additionalProperties: true,
        }),
        call: async (toolArgs) => {
            const { args, apifyToken, progressTracker, extra, apifyMcpServer } = toolArgs;
            const { actor: actorName, step, input, callOptions } = callActorArgs.parse(args);

            try {
                if (step === 'info') {
                    const apifyClient = new ApifyClient({ token: apifyToken });
                    // Step 1: Return Actor card and schema directly
                    const details = await fetchActorDetails(apifyClient, actorName);
                    if (!details) {
                        return {
                            content: [{ type: 'text', text: `Actor information for '${actorName}' was not found. Please check the Actor ID or name and ensure the Actor exists.` }],
                        };
                    }
                    const content = [
                        { type: 'text', text: `**Input Schema:**\n${JSON.stringify(details.inputSchema, null, 0)}` },
                    ];
                    /**
                     * Add Skyfire instructions also in the info step since clients are most likely truncating the long tool description of the call-actor.
                     */
                    if (apifyMcpServer.options.skyfireMode) {
                        content.push({
                            type: 'text',
                            text: SKYFIRE_TOOL_INSTRUCTIONS,
                        });
                    }
                    return { content };
                }

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

                // Step 2: Call the Actor
                if (!input) {
                    return {
                        content: [
                            { type: 'text', text: `Input is required when step="call". Please provide the input parameter based on the Actor's input schema.` },
                        ],
                    };
                }

                const [actor] = await getActorsAsTools([actorName], apifyClient);

                if (!actor) {
                    return {
                        content: [
                            { type: 'text', text: `Actor '${actorName}' not found.` },
                        ],
                    };
                }

                if (!actor.tool.ajvValidate(input)) {
                    const { errors } = actor.tool.ajvValidate;
                    if (errors && errors.length > 0) {
                        return {
                            content: [
                                { type: 'text', text: `Input validation failed for Actor '${actorName}': ${errors.map((e) => e.message).join(', ')}` },
                                { type: 'text', text: `Input Schema:\n${JSON.stringify(actor.tool.inputSchema)}` },
                            ],
                        };
                    }
                }

                const callResult = await callActorGetDataset(
                    actorName,
                    input,
                    apifyClient,
                    callOptions,
                    progressTracker,
                    extra.signal,
                );

                if (!callResult) {
                    // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                    // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                    return { };
                }

                const content = buildActorResponseContent(actorName, callResult);

                return { content };
            } catch (error) {
                log.error('Error with Actor operation', { error, actorName, step });
                return {
                    content: [
                        { type: 'text', text: `Error with Actor operation: ${error instanceof Error ? error.message : String(error)}` },
                    ],
                };
            }
        },
    },
};
