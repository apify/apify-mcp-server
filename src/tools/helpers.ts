import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { HelperTools } from '../const.js';
import type { ActorTool, InternalTool, ToolWrap } from '../types';
import { getActorsAsTools } from './actor.js';
import { actorNameToToolName } from './utils.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });
export const AddToolArgsSchema = z.object({
    actorName: z.string()
        .describe('Add a tool, Actor or MCP-Server to available tools by Actor ID or tool full name.'
            + 'Tool name is always composed from `username/name`'),
});
export const addTool: ToolWrap = {
    type: 'internal',
    tool: {
        name: HelperTools.ADD_TOOL,
        description: 'Add a tool, Actor or MCP-Server to available tools by Actor ID or Actor name. '
            + 'A tool is an Actor or MCP-Server that can be called by the user'
            + 'Do not execute the tool, only add it and list it in available tools. '
            + 'For example, add a tool with username/name when user wants to scrape data from a website.',
        inputSchema: zodToJsonSchema(AddToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(AddToolArgsSchema)),
        // TODO: I don't like that we are passing apifyMcpServer and mcpServer to the tool
        call: async (toolArgs) => {
            const { apifyMcpServer, mcpServer, apifyToken, args } = toolArgs;
            const parsed = AddToolArgsSchema.parse(args);
            const tools = await getActorsAsTools([parsed.actorName], apifyToken);
            const toolsAdded = apifyMcpServer.updateTools(tools);
            await mcpServer.notification({ method: 'notifications/tools/list_changed' });

            return {
                content: [{
                    type: 'text',
                    text: `Actor added: ${toolsAdded.map((t) => `${(t.tool as ActorTool).actorFullName} (tool name: ${t.tool.name})`).join(', ')}`,
                }],
            };
        },
    } as InternalTool,
};
export const RemoveToolArgsSchema = z.object({
    toolName: z.string()
        .describe('Tool name to remove from available tools.')
        .transform((val) => actorNameToToolName(val)),
});
export const removeTool: ToolWrap = {
    type: 'internal',
    tool: {
        name: HelperTools.REMOVE_TOOL,
        description: 'Remove a tool, an Actor or MCP-Server by name from available tools. '
            + 'For example, when user says, I do not need a tool username/name anymore',
        inputSchema: zodToJsonSchema(RemoveToolArgsSchema),
        ajvValidate: ajv.compile(zodToJsonSchema(RemoveToolArgsSchema)),
        // TODO: I don't like that we are passing apifyMcpServer and mcpServer to the tool
        call: async (toolArgs) => {
            const { apifyMcpServer, mcpServer, args } = toolArgs;

            const parsed = RemoveToolArgsSchema.parse(args);
            apifyMcpServer.tools.delete(parsed.toolName);
            await mcpServer.notification({ method: 'notifications/tools/list_changed' });
            return { content: [{ type: 'text', text: `Tool ${parsed.toolName} was removed` }] };
        },
    } as InternalTool,
};
