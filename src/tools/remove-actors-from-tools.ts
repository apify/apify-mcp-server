import { Ajv } from 'ajv';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { actorNameToToolName } from '../actors.js';
import { InternalTools } from '../const.js';
import type { InternalTool, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

export const RemoveActorToolArgsSchema = z.object({
    toolName: z.string()
        .describe('Tool name to remove from available tools.')
        .transform((val) => actorNameToToolName(val)),
});

export const removeActorFromTools: ToolWrap = {
    type: 'internal',
    tool: {
        name: InternalTools.REMOVE_ACTOR_FROM_TOOLS,
        description: 'Remove tool by name from available tools. '
            + 'For example, when user says, I do not need a tool username/name anymore',
        inputSchema: zodToJsonSchema(RemoveActorToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(RemoveActorToolArgsSchema)),
        call: async (toolArgs) => {
            const { apifyMcpServer, mcpServer, args } = toolArgs;

            const parsed = RemoveActorToolArgsSchema.parse(args);
            apifyMcpServer.tools.delete(parsed.toolName);
            await mcpServer.notification({ method: 'notifications/tools/list_changed' });
            return { content: [{ type: 'text', text: `Tool ${parsed.toolName} was removed` }] };
        },
    } as InternalTool,
};
