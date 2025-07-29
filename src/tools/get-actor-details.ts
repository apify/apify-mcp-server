import type { Actor, Build } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { APIFY_STORE_URL, HelperTools } from '../const.js';
import type { ExtendedPricingInfo, IActorInputSchema, InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';
import { getCurrentPricingInfo, pricingInfoToString } from '../utils/pricing-info.js';
import { filterSchemaProperties, shortenProperties } from './utils.js';

const getActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});

// Helper function to format categories from uppercase with underscores to proper case
function formatCategories(categories?: string[]): string[] {
    if (!categories) return [];

    return categories.map((category) => {
        const formatted = category
            .toLowerCase()
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        // Special case for MCP server, AI, and SEO tools
        return formatted.replace('Mcp Server', 'MCP Server').replace('Ai', 'AI').replace('Seo', 'SEO');
    });
}

export const getActorDetailsTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_GET_DETAILS,
        description: `Retrieve comprehensive details about an Actor using its ID or full name.\n`
            + `This tool provides the Actor's title, description, URL, documentation (README), input schema, categories, pricing, and usage statistics.\n`
            + `Specify the Actor name in the format "username/name" (e.g., "apify/rag-web-browser").\n`
            + `The response is formatted in markdown and should be rendered as-is.\n`
            + `USAGE:\n`
            + `- Use when a user requests information about an Actor, such as its details, description, input schema, or documentation.\n`
            + `EXAMPLES:\n`
            + `- user_input: How to use apify/rag-web-browser\n`
            + `- user_input: What is the input schema for apify/rag-web-browser`,
        inputSchema: zodToJsonSchema(getActorDetailsToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(getActorDetailsToolArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;

            const parsed = getActorDetailsToolArgsSchema.parse(args);
            const client = new ApifyClient({ token: apifyToken });

            const [actorInfo, buildInfo]: [Actor | undefined, Build | undefined] = await Promise.all([
                client.actor(parsed.actor).get(),
                client.actor(parsed.actor).defaultBuild().then(async (build) => build.get()),
            ]);

            if (!actorInfo || !buildInfo || !buildInfo.actorDefinition) {
                return {
                    content: [{ type: 'text', text: `Actor information for '${parsed.actor}' was not found. Please check the Actor ID or name and ensure the Actor exists.` }],
                };
            }

            const inputSchema = (buildInfo.actorDefinition.input || {
                type: 'object',
                properties: {},
            }) as IActorInputSchema;
            inputSchema.properties = filterSchemaProperties(inputSchema.properties);
            inputSchema.properties = shortenProperties(inputSchema.properties);

            const currentPricingInfo = getCurrentPricingInfo(actorInfo.pricingInfos || [], new Date());

            // Format categories for display
            const formattedCategories = formatCategories(actorInfo.categories);

            // Note: In the public API, we are missing maintainedByApify property, so we cannot use it here.
            // Note: Actor rating is not in public API, we need to add it (actorUtils.getActorReviewRatingNumber(actorId))
            const actorFullName = `${actorInfo.username}/${actorInfo.name}`;
            const markdownLines = [
                `Actor details (always present Actor information in this format, always include URL):\n`,
                `# [${actorInfo.title}](${APIFY_STORE_URL}/${actorFullName}) (${actorFullName})`,
                `**Developed by:** ${actorInfo.username} Maintained by ${actorInfo.username === 'apify' ? '(Apify)' : '(community)'}`,
                `**Description:** ${actorInfo.description || 'No description provided.'}`,
                `**Categories:** ${formattedCategories.length ? formattedCategories.join(', ') : 'Uncategorized'}`,
                `**Pricing:** ${pricingInfoToString(currentPricingInfo as (ExtendedPricingInfo | null))}`,
                `**Stats:** ${actorInfo.stats.totalUsers.toLocaleString()} total users, ${actorInfo.stats.totalUsers30Days.toLocaleString()} monthly users`,
                `Last modified: ${actorInfo.modifiedAt.toISOString()}`,
            ];
            if (actorInfo.isDeprecated) {
                markdownLines.push('\n>This Actor is deprecated and may not be maintained anymore.');
            }
            const actorCard = markdownLines.join('\n');

            return {
                content: [
                    { type: 'text', text: actorCard },
                    // LLM properly format Actor card, if README and input schema are separate text blocks
                    { type: 'text', text: `**README**:\n\n${buildInfo.actorDefinition.readme || 'No README provided.'}` },
                    { type: 'text', text: `**Input Schema**:\n\n${JSON.stringify(inputSchema, null, 0)}` },
                ],
            };
        },
    } as InternalTool,
};
