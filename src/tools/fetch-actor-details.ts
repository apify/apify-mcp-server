import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { ajv } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorDetailsOutputSchema } from './schemas.js';

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
    inputSchema: zodToJsonSchema(fetchActorDetailsToolArgsSchema) as ToolInputSchema,
    outputSchema: actorDetailsOutputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(fetchActorDetailsToolArgsSchema)),
    annotations: {
        title: 'Fetch Actor details',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = fetchActorDetailsToolArgsSchema.parse(args);
        const apifyClient = new ApifyClient({ token: apifyToken });
        const details = await fetchActorDetails(apifyClient, parsed.actor);
        if (!details) {
            const texts = [`Actor information for '${parsed.actor}' was not found.
Please verify Actor ID or name format and ensure that the Actor exists.
You can search for available Actors using the tool: ${HelperTools.STORE_SEARCH}.`,
            ];
            return buildMCPResponse({ texts, isError: true });
        }

        const actorUrl = `https://apify.com/${details.actorInfo.username}/${details.actorInfo.name}`;
        // Add link to README title
        details.readme = details.readme.replace(/^# /, `# [README](${actorUrl}/readme): `);

        const texts = [
            `# Actor information\n${details.actorCard}`,
            `${details.readme}`,
        ];

        // Include input schema if it has properties
        if (details.inputSchema.properties || Object.keys(details.inputSchema.properties).length !== 0) {
            texts.push(`# [Input schema](${actorUrl}/input)\n\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``);
        }
        // Return the actor card, README, and input schema (if it has non-empty properties) as separate text blocks
        // This allows better formatting in the final output
        const structuredContent = {
            actorInfo: details.actorCardStructured,
            readme: details.readme,
            inputSchema: details.inputSchema,
        };
        return buildMCPResponse({ texts, structuredContent });
    },
} as const;
