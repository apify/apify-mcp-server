import { z } from 'zod';

import { ApifyClient } from '../apify-client.js';
import { HelperTools, TOOL_STATUS } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { fetchActorDetails } from '../utils/actor-details.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { actorSchemaOutputSchema } from './structured-output-schemas.js';

const fetchActorSchemaArgsSchema = z.object({
    actor: z.string()
        .min(1)
        .describe('Actor ID or full name in the format "username/name", e.g., "apify/rag-web-browser".'),
});

export const fetchActorSchemaTool: ToolEntry = {
    type: 'internal',
    name: HelperTools.ACTOR_GET_SCHEMA,
    description: ` Fetch Actor input schema only.

Use this tool for helper/internal lookups before calling an Actor. 
It returns only the input schema needed for validation.`,
    inputSchema: z.toJSONSchema(fetchActorSchemaArgsSchema) as ToolInputSchema,
    outputSchema: actorSchemaOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchActorSchemaArgsSchema)),
    annotations: {
        title: 'Fetch Actor schema',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = fetchActorSchemaArgsSchema.parse(args);
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

        return buildMCPResponse({
            texts: [
                `Input schema for Actor '${parsed.actor}':`,
                `\`\`\`json\n${JSON.stringify(details.inputSchema)}\n\`\`\``,
            ],
            structuredContent: {
                inputSchema: details.inputSchema,
            },
        });
    },
};
