import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { fetchActorDetails, processActorDetailsForResponse } from '../utils/actor-details.js';
import { ajv } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';

const fetchActorDetailsWidgetToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});

/**
 * Tool for fetching actor details when called from the Actor Search Widget UI.
 * Shares the core logic with fetch-actor-details tool via processActorDetailsForResponse helper.
 * This tool is designed to be called from the Actor Search Widget UI by pressing the "View Details" button.
 */

export const fetchActorDetailsWidgetTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.FETCH_ACTOR_DETAILS_WIDGET,
    description: `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").
This tool is designed to be called from the Actor Search Widget UI.
It returns the Actor's title, description, URL, README (documentation), input schema, pricing/usage information, and basic stats.
Present the information in a user-friendly Actor card.

USAGE:
- Use when the Actor Search Widget UI requests actor details via the View Details button.

USAGE EXAMPLES:
- Called from widget with actor full name parameter`,
    inputSchema: zodToJsonSchema(fetchActorDetailsWidgetToolArgsSchema) as ToolInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(fetchActorDetailsWidgetToolArgsSchema)),
    _meta: {
        'openai/outputTemplate': 'ui://widget/search-actors.html',
        'openai/toolInvocation/invoking': 'Fetching Actor details...',
        'openai/toolInvocation/invoked': 'Actor details fetched',
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
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
    },
    call: async (toolArgs: InternalToolArgs) => {
        log.debug('Fetch actor details widget tool', {
            toolArgs,
        });
        const { args, apifyToken } = toolArgs;
        const parsed = fetchActorDetailsWidgetToolArgsSchema.parse(args);
        const apifyClient = new ApifyClient({ token: apifyToken });
        const details = await fetchActorDetails(apifyClient, parsed.actor);
        if (!details) {
            return buildMCPResponse({
                texts: [`Actor information for '${parsed.actor}' was not found.
Please verify Actor ID or name format and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }

        const { structuredContent, formattedReadme } = processActorDetailsForResponse(details);

        const result: CallToolResult = {
            content: [
                { type: 'text', text: `# Actor information\n${details.actorCard}` },
                { type: 'text', text: formattedReadme },
            ],
            structuredContent,
            _meta: {
                'openai/outputTemplate': 'ui://widget/search-actors.html',
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

        return result;
    },
} as const;
