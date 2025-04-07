/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ActorCallOptions } from 'apify-client';

import { callActorGetDataset } from './actors/call.js';
import {
    getActorsAsTools,
} from './actors/tools.js';
import {
    ACTOR_OUTPUT_MAX_CHARS_PER_ITEM,
    ACTOR_OUTPUT_TRUNCATED_MESSAGE,
    defaults,
    SERVER_NAME,
    SERVER_VERSION,
} from './const.js';
import { log } from './logger.js';
import { getActorAutoLoadingTools } from './tools/index.js';
import type { ActorTool, ToolWrap, InternalTool } from './types.js';
import { parseInputParamsFromUrl } from './utils.js';

/**
 * Create Apify MCP server
 */
export class ApifyMcpServer {
    private server: Server;
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
    }

    public async addToolsFromActors(actors: string[]) {
        const tools = await getActorsAsTools(actors);
        this.updateTools(tools);
        return tools;
    }

    public async addToolsFromDefaultActors() {
        await this.addToolsFromActors(defaults.actors);
    }

    public updateTools(tools: ToolWrap[]): void {
        for (const wrap of tools) {
            this.tools.set(wrap.tool.name, wrap);
            log.info(`Added/Updated tool: ${wrap.tool.name}`);
        }
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

    public enableActorAutoLoading() {
        this.updateTools(getActorAutoLoadingTools());
        log.debug('Enabled Actor auto-loading tools');
    }

    /**
     * Process input parameters and update tools
     * If URL contains query parameter `actors`, add tools from Actors.
     * If URL contains query parameter `enableActorAutoLoading`, enable auto-loading of Actors.
     * @param url
     */
    public async processParamsAndUpdateTools(url: string) {
        const input = parseInputParamsFromUrl(url);
        if (input.actors) {
            await this.addToolsFromActors(input.actors as string[]);
        }
        if (input.enableActorAutoLoading) {
            this.enableActorAutoLoading();
        }

        log.debug(`Server is running in STANDBY mode with Actors: ${this.getToolNames()}. `
            + 'To use different Actors, provide them in "actors" query param or Actor Task input.');
    }

    private setupToolHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
            if (!apifyToken) {
                throw new Error('APIFY_TOKEN is required but not set in the environment variables or passed as a parameter.');
            }

            const tool = Array.from(this.tools.values())
                .find((t) => t.tool.name === name || (t.type === 'actor' && (t.tool as ActorTool).actorFullName === name));
            if (!tool) {
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
                if (tool.type === 'internal') {
                    const internalTool = tool.tool as InternalTool;
                    const res = await internalTool.call({
                        args,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                    }) as object;
                    return {
                        ...res,
                    };
                }

                if (tool.type === 'actor') {
                    const actorTool = tool.tool as ActorTool;

                    const items = await callActorGetDataset(actorTool.actorFullName, args, apifyToken as string, {
                        memory: actorTool.memoryMbytes,
                    } as ActorCallOptions);
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
