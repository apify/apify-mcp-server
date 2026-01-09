import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { fetchActorDetails, processActorDetailsForResponse } from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorDetailsOutputSchema } from './structured-output-schemas.js';

const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});

export const fetchActorDetailsTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_DETAILS,
    description: `Get detailed information about an Actor by its ID or full name (format: "username/name", e.g., "apify/rag-web-browser").
This returns the Actor's title, description, URL, README (documentation), input schema, pricing/usage information, and basic stats.
Present the information in a user-friendly Actor card.

USAGE:
- Use when a user asks about an Actor’s details, input schema, README, or how to use it.

USAGE EXAMPLES:
- user_input: How to use apify/rag-web-browser
- user_input: What is the input schema for apify/rag-web-browser?
- user_input: What is the pricing for apify/instagram-scraper?`,
    inputSchema: z.toJSONSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorDetailsToolArgsSchema)),
    annotations: {
        title: 'Fetch Actor details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = fetchActorDetailsToolArgsSchema.parse(args);
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

        const { structuredContent: processedStructuredContent, formattedReadme, actorUrl } = processActorDetailsForResponse(details);

        const structuredContent = {
            actorInfo: details.actorCardStructured,
            readme: formattedReadme,
            inputSchema: details.inputSchema,
        };

        if (apifyMcpServer.options.uiMode === 'openai') {
            const widgetStructuredContent = {
                ...structuredContent,
                actorDetails: processedStructuredContent.actorDetails,
            };

            const texts = [`
# Actor information:
- **Actor:** ${parsed.actor}
- **URL:** ${actorUrl}

View the interactive widget below for detailed Actor information.
`];

            return buildMCPResponse({
                texts,
                structuredContent: widgetStructuredContent,
                _meta: {
                    'openai/outputTemplate': 'ui://widget/search-actors.html',
                    'openai/widgetAccessible': true,
                    'openai/resultCanProduceWidget': true,
                    'openai/widgetDescription': `Actor details for ${parsed.actor} from Apify Store`,
                    // TODO: replace with real CSP domains
                    'openai/widgetCSP': {
                        connect_domains: ['https://api.example.com'],
                        resource_domains: ['https://persistent.oaistatic.com'],
                    },
                    'openai/widgetDomain': 'https://chatgpt.com',
                },
            });
        }

        const texts = [
            `# Actor information\n${details.actorCard}`,
            formattedReadme,
        ];

        // Include input schema if it has properties
        if (details.inputSchema.properties || Object.keys(details.inputSchema.properties).length !== 0) {
            texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
        }
        return buildMCPResponse({ texts, structuredContent });
    },
} as const;
