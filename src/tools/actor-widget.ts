import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { generateSchemaFromItems } from '../utils/schema-generation.js';
import { getActorsAsTools } from './actor.js';

const callActorWidgetArgs = z.object({
    actor: z.string()
        .min(1)
        .describe('The name of the Actor to call. For example, "apify/rag-web-browser".'),
    input: z.object({}).passthrough()
        .describe(`The input JSON to pass to the Actor. For example, {"query": "apify", "maxResults": 5}.`),
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

const getActorRunStatusArgs = z.object({
    runId: z.string()
        .min(1)
        .describe('The ID of the Actor run to get status for.'),
});

/**
 * Tool to get the status of a running Actor run.
 * Returns the current status, runtime statistics, and final results if completed.
 */
export const getActorRunStatus: ToolEntry = {
    type: 'internal',
    name: HelperTools.GET_ACTOR_RUN_STATUS,
    description: `Get the current status of an Actor run.
Returns the current status, runtime statistics, and final results if completed.
Use this tool to check the progress of a running Actor or retrieve results when the run has finished.

USAGE:
- Use when checking the status of an Actor run started with ${HelperTools.CALL_ACTOR_WIDGET}.
- Use to retrieve dataset results when a run has completed.

USAGE EXAMPLES:
- user_input: Check status of run abc123
- user_input: Get results for run xyz789`,
    inputSchema: zodToJsonSchema(getActorRunStatusArgs) as ToolInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getActorRunStatusArgs)),
    _meta: {
        'openai/outputTemplate': 'ui://widget/actor-run.html',
        'openai/toolInvocation/invoking': 'Checking Actor run status...',
        'openai/toolInvocation/invoked': 'Actor run status retrieved',
        'openai/widgetAccessible': true,
        'openai/resultCanProduceWidget': true,
        // TODO: replace with real CSP domains
        'openai/widgetCSP': {
            connect_domains: ['https://api.example.com'],
            resource_domains: ['https://persistent.oaistatic.com'],
        },
        'openai/widgetDomain': 'https://chatgpt.com',
    },
    annotations: {
        title: 'Get Actor run status',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs): Promise<CallToolResult> => {
        const { args, apifyToken } = toolArgs;
        const { runId } = getActorRunStatusArgs.parse(args);

        try {
            const apifyClient = new ApifyClient({ token: apifyToken });
            const run = await apifyClient.run(runId).get();

            if (!run) {
                return buildMCPResponse({
                    texts: [`Actor run '${runId}' was not found.
Please verify the run ID and ensure that the run exists.`],
                    isError: true,
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                }) as CallToolResult;
            }

            log.debug('Get actor run status', { runId, status: run.status });

            // Build response with current status
            const structuredContent: {
                runId: string;
                actorName?: string;
                status: string;
                startedAt: string;
                finishedAt?: string;
                stats?: unknown;
                dataset?: {
                    datasetId: string;
                    itemCount: number;
                    schema: unknown;
                    previewItems: unknown[];
                };
            } = {
                runId: run.id,
                status: run.status,
                startedAt: run.startedAt?.toISOString() || '',
                finishedAt: run.finishedAt?.toISOString(),
                stats: run.stats,
            };

            // If completed, fetch dataset results
            if (run.status === 'SUCCEEDED' && run.defaultDatasetId) {
                const dataset = apifyClient.dataset(run.defaultDatasetId);
                const datasetItems = await dataset.listItems({ limit: 5 });

                const generatedSchema = generateSchemaFromItems(datasetItems.items, {
                    clean: true,
                    arrayMode: 'all',
                });

                structuredContent.dataset = {
                    datasetId: run.defaultDatasetId,
                    itemCount: datasetItems.count,
                    schema: generatedSchema || { type: 'object', properties: {} },
                    previewItems: datasetItems.items,
                };
            }

            const statusText = run.status === 'SUCCEEDED' && structuredContent.dataset
                ? `Actor run ${runId} completed successfully with ${structuredContent.dataset.itemCount} items. View details in the widget below.`
                : `Actor run ${runId} status: ${run.status}. View progress in the widget below.`;

            return {
                content: [
                    {
                        type: 'text',
                        text: statusText,
                    } as TextContent,
                ],
                structuredContent,
                _meta: {
                    'openai/outputTemplate': 'ui://widget/actor-run.html',
                    'openai/widgetAccessible': true,
                    'openai/resultCanProduceWidget': true,
                    // TODO: replace with real CSP domains
                    'openai/widgetCSP': {
                        connect_domains: ['https://api.example.com'],
                        resource_domains: ['https://persistent.oaistatic.com'],
                    },
                    'openai/widgetDomain': 'https://chatgpt.com',
                },
            };
        } catch (error) {
            logHttpError(error, 'Failed to get Actor run status', { runId });
            return buildMCPResponse({
                texts: [`Failed to get Actor run status for '${runId}': ${error instanceof Error ? error.message : String(error)}.
Please verify the run ID and ensure that the run exists.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            }) as CallToolResult;
        }
    },
} as const;

/**
 * Asynchronous Actor call tool with widget UI.
 * Starts an Actor run and returns immediately with run ID for status polling.
 * Use get-actor-run-status tool to check progress and retrieve results.
 */
export const callActorWidget: ToolEntry = {
    type: 'internal',
    name: HelperTools.CALL_ACTOR_WIDGET,
    description: `Start an Actor run with progress UI (async).
**ASYNCHRONOUS + WIDGET**: Starts the Actor and RETURNS IMMEDIATELY with runId. Use ${HelperTools.GET_ACTOR_RUN_STATUS} to poll. Shows an interactive widget.

**DO NOT RESTART THIS TOOL** for the same task. Call it once, then poll with ${HelperTools.GET_ACTOR_RUN_STATUS} using the returned runId. If you already have a runId, never re-run ${HelperTools.CALL_ACTOR_WIDGET}; just poll status.

**WHEN TO USE THIS TOOL:**
- User mentions "start", "background", "async", "monitor progress", "widget", "UI"
- Long-running Actors where waiting would timeout
- User wants progress/status UI
- User doesn't need immediate results in the same response

**WHEN NOT TO USE THIS TOOL:**
- User wants immediate results (e.g., "get results now")
- User says "call/run" with no background/async/progress mention
- Quick tasks where waiting is fine
→ In these cases, use call-actor instead

This tool provides an asynchronous workflow - it starts the Actor run and returns immediately.
The widget displays:
- Actor run progress and status
- Runtime statistics
- Final results when complete

Use the ${HelperTools.GET_ACTOR_RUN_STATUS} tool to check progress and retrieve results when the run completes.

USAGE:
- Use when you want to start an Actor run without waiting for completion.
- Use for long-running Actors where you want to monitor progress in the UI.
- After starting, use ${HelperTools.GET_ACTOR_RUN_STATUS} to check progress and get results.

USAGE EXAMPLES:
- user_input: Start apify/rag-web-browser with query "artificial intelligence"
- user_input: Run apify/instagram-scraper for username "example"`,
    inputSchema: zodToJsonSchema(callActorWidgetArgs) as ToolInputSchema,
    ajvValidate: ajv.compile({
        ...zodToJsonSchema(callActorWidgetArgs),
        additionalProperties: true,
    }),
    _meta: {
        'openai/outputTemplate': 'ui://widget/actor-run.html',
        'openai/toolInvocation/invoking': 'Starting Actor run...',
        'openai/toolInvocation/invoked': 'Actor run started',
        'openai/widgetAccessible': true,
        'openai/resultCanProduceWidget': true,
        'openai/widgetCSP': {
            connect_domains: ['https://api.example.com'],
            resource_domains: ['https://persistent.oaistatic.com'],
        },
        'openai/widgetDomain': 'https://chatgpt.com',
    },
    annotations: {
        title: 'Start Actor run',
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
    },
    call: async (toolArgs: InternalToolArgs): Promise<CallToolResult> => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const { actor: actorName, input, callOptions } = callActorWidgetArgs.parse(args);

        try {
            // Create Apify client
            const apifyClient = apifyMcpServer.options.skyfireMode && typeof args['skyfire-pay-id'] === 'string'
                ? new ApifyClient({ skyfirePayId: args['skyfire-pay-id'] })
                : new ApifyClient({ token: apifyToken });

            // Get actor tools to validate input
            const [actor] = await getActorsAsTools([actorName], apifyClient);

            if (!actor) {
                return buildMCPResponse({
                    texts: [`Actor '${actorName}' was not found.
Please verify Actor ID or name format (e.g., "username/name" like "apify/rag-web-browser") and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`],
                    isError: true,
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                }) as CallToolResult;
            }

            if (!actor.ajvValidate(input)) {
                const { errors } = actor.ajvValidate;
                const content = [
                    `Input validation failed for Actor '${actorName}'. Please ensure your input matches the Actor's input schema.`,
                    `Input schema:\n\`\`\`json\n${JSON.stringify(actor.inputSchema)}\n\`\`\``,
                ];
                if (errors && errors.length > 0) {
                    content.push(`Validation errors: ${errors.map((e) => (e as { message?: string }).message).join(', ')}`);
                }
                return buildMCPResponse({
                    texts: content,
                    isError: true,
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                }) as CallToolResult;
            }

            // Start the actor (don't wait for completion)
            const actorClient = apifyClient.actor(actorName);
            const actorRun = await actorClient.start(input, callOptions);

            log.debug('Started Actor run', { actorName, runId: actorRun.id });

            // Return widget with initial run info
            const structuredContent = {
                runId: actorRun.id,
                actorName,
                status: actorRun.status,
                startedAt: actorRun.startedAt?.toISOString() || '',
                input,
            };

            return {
                content: [
                    {
                        type: 'text',
                        text: `Started Actor "${actorName}" (Run ID: ${actorRun.id}). Do not start another run for this task—reuse this runId. Use ${HelperTools.GET_ACTOR_RUN_STATUS} with runId "${actorRun.id}" to monitor progress and retrieve results.`,
                    } as TextContent,
                ],
                structuredContent,
                _meta: {
                    'openai/outputTemplate': 'ui://widget/actor-run.html',
                    'openai/widgetAccessible': true,
                    'openai/resultCanProduceWidget': true,
                    'openai/widgetDescription': `Actor run progress for ${actorName}`,
                    'openai/widgetCSP': {
                        connect_domains: ['https://api.example.com'],
                        resource_domains: ['https://persistent.oaistatic.com'],
                    },
                    'openai/widgetDomain': 'https://chatgpt.com',
                },
            };
        } catch (error) {
            logHttpError(error, 'Failed to call Actor', { actorName });
            return buildMCPResponse({
                texts: [`Failed to call Actor '${actorName}': ${error instanceof Error ? error.message : String(error)}.
Please verify the Actor name, input parameters, and ensure the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}, or get Actor details using: ${HelperTools.ACTOR_GET_DETAILS}.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            }) as CallToolResult;
        }
    },
} as const;
