import type { Actor, Build } from 'apify-client';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { IActorInputSchema, InternalTool, ToolEntry } from '../types.js';
import { formatActorToActorCard } from '../utils/actor-card.js';
import { ajv } from '../utils/ajv.js';
import { filterSchemaProperties, shortenProperties } from './utils.js';

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

            // Use the actor formatter to get the main actor details
            const actorCard = formatActorToActorCard(actorInfo);

            return {
                content: [
                    { type: 'text', text: `**Actor card**:\n${actorCard}` },
                    { type: 'text', text: `**README:**\n${buildInfo.actorDefinition.readme || 'No README provided.'}` },
                    { type: 'text', text: `**Input Schema:**\n${JSON.stringify(inputSchema, null, 0)}` },
                ],
            };
        },
    } as InternalTool,
};
