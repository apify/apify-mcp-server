/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ActorCallOptions } from 'apify-client';

import log from '@apify/log';

import {
    ACTOR_OUTPUT_MAX_CHARS_PER_ITEM,
    ACTOR_OUTPUT_TRUNCATED_MESSAGE,
    SERVER_NAME,
    SERVER_VERSION,
} from './const.js';
import { actorDefinitionTool, callActorGetDataset, getActorsAsTools, searchTool } from './tools/index.js';
import type { ActorTool, HelperTool, ToolWrap } from './types.js';
import { defaults } from './const.js';
import { actorNameToToolName } from './tools/utils.js';
import { processParamsGetTools } from './actor/utils.js';

/**
 * Create Apify MCP server
 */
export class ActorsMcpServer {
    public server: Server;
    public tools: Map<string, ToolWrap>;

    constructor() {
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
            },
            {
                capabilities: {
                    tools: { listChanged: true },
                },
            },
        );
        this.tools = new Map();
        this.setupErrorHandling();
        this.setupToolHandlers();

        // Add default tools
        this.updateTools([searchTool, actorDefinitionTool]);
    }

    /**
     * Loads missing default tools.
     */
    public async loadDefaultTools() {
        const missingDefaultTools = defaults.actors.filter(name => !this.tools.has(actorNameToToolName(name)));
        const tools = await getActorsAsTools(missingDefaultTools);
        if (tools.length > 0) this.updateTools(tools);
    }

    /**
     * Loads tools from URL params.
     *
     * Used primarily for SSE.
     */
    public async loadToolsFromUrl(url: string) {
        const tools = await processParamsGetTools(url);
        if (tools.length > 0) this.updateTools(tools);
    }

    /**
     * Upsert new tools.
     * @param tools - Array of tool wrappers.
     * @returns Array of tool wrappers.
     */
    public updateTools(tools: ToolWrap[]) {
        for (const wrap of tools) {
            this.tools.set(wrap.tool.name, wrap);
            log.info(`Added/updated tool: ${wrap.tool.name}`);
        }
        return tools;
    }

    /**
     * Returns an array of tool names.
     * @returns {string[]} - An array of tool names.
     */
    public getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    private setupErrorHandling(): void {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error); // eslint-disable-line no-console
        };
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private setupToolHandlers(): void {
        /**
         * Handles the request to list tools.
         * @param {object} request - The request object.
         * @returns {object} - The response object containing the tools.
         */
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            // TODO if there is actor-mcp as a tool, also list the tools from that Actor
            const tools = Array.from(this.tools.values()).map((tool) => (tool.tool));
            return { tools };
        });

        /**
         * Handles the request to call a tool.
         * @param {object} request - The request object containing tool name and arguments.
         * @throws {Error} - Throws an error if the tool is unknown or arguments are invalid.
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const apifyToken = request.params.apifyToken || process.env.APIFY_TOKEN;

            // Validate token
            if (!apifyToken) {
                throw new Error('APIFY_TOKEN is required but not set in the environment variables or passed as a parameter.');
            }

            // Find tool by name or actor full name
            const tool = Array.from(this.tools.values())
                .find((t) => t.tool.name === name || (t.type === 'actor' && (t.tool as ActorTool).actorFullName === name));
            if (!tool) {
                // TODO: handle errors better, server.sendLoggingMessage (   )
                throw new Error(`Unknown tool: ${name}`);
            }
            if (!args) {
                throw new Error(`Missing arguments for tool: ${name}`);
            }
            log.info(`Validate arguments for tool: ${tool.tool.name} with arguments: ${JSON.stringify(args)}`);
            if (!tool.tool.ajvValidate(args)) {
                throw new Error(`Invalid arguments for tool ${tool.tool.name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(tool?.tool.ajvValidate.errors)}`);
            }

            try {
                // Handle internal tool
                if (tool.type === 'internal') {
                    const internalTool = tool.tool as HelperTool;
                    const res = await internalTool.call({
                        args,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                    }) as object;

                    return { ...res };
                }

                // Handle actor tool
                if (tool.type === 'actor') {
                    const actorTool = tool.tool as ActorTool;

                    const callOptions: ActorCallOptions = {
                        memory: actorTool.memoryMbytes,
                    };

                    const items = await callActorGetDataset(actorTool.actorFullName, args, apifyToken as string, callOptions);

                    const content = items.map((item) => {
                        const text = JSON.stringify(item).slice(0, ACTOR_OUTPUT_MAX_CHARS_PER_ITEM);
                        return text.length === ACTOR_OUTPUT_MAX_CHARS_PER_ITEM
                            ? { type: 'text', text: `${text} ... ${ACTOR_OUTPUT_TRUNCATED_MESSAGE}` }
                            : { type: 'text', text };
                    });
                    return { content };
                }
            } catch (error) {
                log.error(`Error calling tool: ${error}`);
                throw new Error(`Error calling tool: ${error}`);
            }

            throw new Error(`Tool ${name} is not implemented`);
        });
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }
}
