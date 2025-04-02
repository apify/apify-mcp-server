import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { InternalTools } from '../const.js';
import type { ActorTool, InternalTool, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

export const AddActorToToolsArgsSchema = z.object({
    actorName: z.string()
        .describe('Add an Actor to available tools by Actor ID or Actor full name.'
            + 'Actor name is always composed from `username/name`'),
});

export const addActorToTools: ToolWrap = {
    type: 'internal',
    tool: {
        name: InternalTools.ADD_ACTOR_TO_TOOLS,
        description: 'Add an Actor to available tools by Actor ID or Actor name. '
            + 'Do not execute the Actor, only add it and list it in available tools. '
            + 'Never run the tool without user consent! '
            + 'For example, add a tool with username/name when user wants to scrape data from a website.',
        inputSchema: zodToJsonSchema(AddActorToToolsArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(AddActorToToolsArgsSchema)),
        call: async (toolArgs) => {
            const { apifyMcpServer, mcpServer, args } = toolArgs;
            const parsed = AddActorToToolsArgsSchema.parse(args);
            const toolsAdded = await apifyMcpServer.addToolsFromActors([parsed.actorName]);
            await mcpServer.notification({ method: 'notifications/tools/list_changed' });

            return { content: [{
                type: 'text',
                text: `Actor added: ${toolsAdded.map((t) => `${(t.tool as ActorTool).actorFullName} (tool name: ${t.tool.name})`).join(', ')}`,
            }] };
        },
    } as InternalTool,
};
