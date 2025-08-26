import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { ajv } from '../utils/ajv.js';

const fetchActorDetailsToolArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe(`Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".`),
});

export const fetchActorDetailsTool: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_GET_DETAILS,
        description: `Get detailed information about an Actor by its ID or full name.\n`
            + `This tool returns title, description, URL, README (Actor's documentation), input schema, and usage statistics. \n`
            + `The Actor name is always composed of "username/name", for example, "apify/rag-web-browser".\n`
            + `Present Actor information in user-friendly format as an Actor card.\n`
            + `USAGE:\n`
            + `- Use when user asks about an Actor its details, description, input schema, etc.\n`
            + `EXAMPLES:\n`
            + `- user_input: How to use apify/rag-web-browser\n`
            + `- user_input: What is the input schema for apify/rag-web-browser`,
        inputSchema: zodToJsonSchema(fetchActorDetailsToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(fetchActorDetailsToolArgsSchema)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = fetchActorDetailsToolArgsSchema.parse(args);
            const details = await fetchActorDetails(apifyToken, parsed.actor);
            if (!details) {
                return {
                    content: [{ type: 'text', text: `Actor information for '${parsed.actor}' was not found. Please check the Actor ID or name and ensure the Actor exists.` }],
                };
            }
            return {
                content: [
                    { type: 'text', text: `**Actor card**:\n${details.actorCard}` },
                    { type: 'text', text: `**README:**\n${details.readme}` },
                    { type: 'text', text: `**Input Schema:**\n${JSON.stringify(details.inputSchema, null, 0)}` },
                ],
            };
        },
    } as InternalTool,
};
