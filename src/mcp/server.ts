/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ActorCallOptions } from 'apify-client';

import log from '@apify/log';

import {
    ACTOR_OUTPUT_MAX_CHARS_PER_ITEM,
    ACTOR_OUTPUT_TRUNCATED_MESSAGE,
    defaults,
    SERVER_NAME,
    SERVER_VERSION,
} from '../const.js';
import { internalToolsMap } from '../toolmap.js';
import { helpTool } from '../tools/helpers.js';
import {
    actorDefinitionTool,
    addTool,
    callActorGetDataset,
    getActorsAsTools,
    removeTool,
    searchTool,
} from '../tools/index.js';
import { actorNameToToolName } from '../tools/utils.js';
import type { ActorMCPTool, ActorTool, HelperTool, ToolWrap } from '../types.js';
import { createMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from './const.js';
import { processParamsGetTools } from './utils.js';

type ActorsMcpServerOptions = {
    enableAddingActors?: boolean;
    enableDefaultActors?: boolean;
};

type ToolsChangedHandler = (toolNames: string[]) => void;

/**
 * Create Apify MCP server
 */
export class ActorsMcpServer {
    public readonly server: Server;
    public readonly tools: Map<string, ToolWrap>;
    private readonly options: ActorsMcpServerOptions;
    private toolsChangedHandler: ToolsChangedHandler | undefined;

    constructor(options: ActorsMcpServerOptions = {}, setupSIGINTHandler = true) {
        this.options = {
            enableAddingActors: options.enableAddingActors ?? false,
            enableDefaultActors: options.enableDefaultActors ?? true, // Default to true for backward compatibility
        };
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
            },
            {
                capabilities: {
                    tools: { listChanged: true },
                    logging: {},
                },
            },
        );
        this.tools = new Map();
        this.setupErrorHandling(setupSIGINTHandler);
        this.setupToolHandlers();

        // Add default tools
        this.updateTools([searchTool, actorDefinitionTool, helpTool], false);

        // Add tools to dynamically load Actors
        if (this.options.enableAddingActors) {
            this.loadToolsToAddActors();
        }

        // Initialize automatically for backward compatibility
        this.initialize().catch((error) => {
            log.error('Failed to initialize server:', error);
        });
    }

    /**
    * Returns list of added Actor MCP servers.
    * @returns {string[]} - An array of Actor MCP server Actor IDs.
    */
    public getToolMCPServerActors(): string[] {
        const mcpServerActors: Set<string> = new Set();
        for (const tool of this.tools.values()) {
            if (tool.type === 'actor-mcp') {
                mcpServerActors.add((tool.tool as ActorMCPTool).actorID);
            }
        }

        return Array.from(mcpServerActors);
    }

    /**
    * Register handler to get notified when tools change.
    * The handler receives Actor IDs of the tools that server has after the change.
    * This is primarily used to store the tools in the shared state (Redis) so
    * we can recover them when the server loses local state.
    * @throws {Error} - If the handler is already registered.
    * @param handler - The handler function to be called when tools change.
    */
    public registerToolsChangedHandler(handler: (toolNames: string[]) => void) {
        if (this.toolsChangedHandler) {
            throw new Error('Tools changed handler is already registered.');
        }
        this.toolsChangedHandler = handler;
    }

    /**
    * Unregister the handler for tools changed event.
    * @throws {Error} - If the handler is not registered.
    */
    public unregisterToolsChangedHandler() {
        if (!this.toolsChangedHandler) {
            throw new Error('Tools changed handler is not registered.');
        }
        this.toolsChangedHandler = undefined;
    }

    /**
    * Loads missing tools from the tools list.
    * @param tools
    * @param apifyToken
    */
    public async loadToolsFromToolsList(tools: string[], apifyToken: string) {
        const loadedTools = this.getLoadedActorToolsList();
        const actorsToLoad: string[] = [];

        for (const tool of tools) {
            // Skip if the tool is already loaded
            if (loadedTools.includes(tool)) {
                continue;
            }

            // Load internal tool
            if (internalToolsMap.has(tool)) {
                const toolWrap = internalToolsMap.get(tool) as ToolWrap;
                this.tools.set(tool, toolWrap);
                log.info(`Added internal tool: ${tool}`);
                // Handler Actor tool
            } else {
                actorsToLoad.push(tool);
            }
        }

        if (actorsToLoad.length > 0) {
            const actorTools = await getActorsAsTools(actorsToLoad, apifyToken);
            if (actorTools.length > 0) {
                this.updateTools(actorTools);
            }
            log.info(`Loaded tools: ${actorTools.map((t) => t.tool.name).join(', ')}`);
        }
    }

    /**
    * Returns the list of loaded Actor tool IDs - for example: apify/actors-mcp-server
    * @returns {string[]} - The list of loaded Actor tool IDs.
    */
    public getLoadedActorToolsList(): string[] {
        // Get the list of tool names
        const tools: string[] = [];
        for (const tool of this.tools.values()) {
            if (tool.type === 'actor') {
                tools.push((tool.tool as ActorTool).actorFullName);
            // Skip Actorized MCP servers since there may be multiple tools from the same Actor MCP server
            // so we skip and then get unique list of Actor MCP servers separately
            } else if (tool.type === 'actor-mcp') {
                continue;
            } else {
                tools.push(tool.tool.name);
            }
        }
        // Add unique list Actorized MCP servers original Actor IDs - for example: apify/actors-mcp-server
        tools.push(...this.getToolMCPServerActors());

        return tools;
    }

    private notifyToolsChangedHandler() {
        // If no handler is registered, do nothing
        if (!this.toolsChangedHandler) return;

        // Get the list of tool names
        const tools: string[] = this.getLoadedActorToolsList();

        this.toolsChangedHandler(tools);
    }

    /**
    * Resets the server to the default state.
    * This method clears all tools and loads the default tools.
    * Used primarily for testing purposes.
    */
    public async reset(): Promise<void> {
        this.tools.clear();
        // Unregister the tools changed handler
        if (this.toolsChangedHandler) {
            this.unregisterToolsChangedHandler();
        }
        this.updateTools([searchTool, actorDefinitionTool, helpTool]);
        if (this.options.enableAddingActors) {
            this.loadToolsToAddActors();
        }

        // Initialize automatically for backward compatibility
        await this.initialize();
    }

    /**
     * Initialize the server with default tools if enabled
     */
    public async initialize(): Promise<void> {
        if (this.options.enableDefaultActors) {
            await this.loadDefaultTools(process.env.APIFY_TOKEN as string);
        }
    }

    /**
     * Loads default tools if not already loaded.
     */
    public async loadDefaultTools(apifyToken: string) {
        const missingDefaultTools = defaults.actors.filter((name) => !this.tools.has(actorNameToToolName(name)));
        const tools = await getActorsAsTools(missingDefaultTools, apifyToken);
        if (tools.length > 0) {
            log.info('Loading default tools...');
            this.updateTools(tools);
        }
    }

    /**
     * Loads tools from URL params.
     *
     * This method also handles enabling of Actor autoloading via the processParamsGetTools.
     *
     * Used primarily for SSE.
     */
    public async loadToolsFromUrl(url: string, apifyToken: string) {
        const tools = await processParamsGetTools(url, apifyToken);
        if (tools.length > 0) {
            log.info('Loading tools from query parameters...');
            this.updateTools(tools, false);
        }
    }

    /**
     * Add Actors to server dynamically
     */
    public loadToolsToAddActors() {
        this.updateTools([addTool, removeTool], false);
    }

    /**
     * Upsert new tools.
     * @param tools - Array of tool wrappers.
     * @returns Array of tool wrappers.
     */
    public updateTools(tools: ToolWrap[], notifyToolsChangedHandler = true) {
        for (const wrap of tools) {
            this.tools.set(wrap.tool.name, wrap);
            log.info(`Added/updated tool: ${wrap.tool.name}`);
        }
        if (notifyToolsChangedHandler) this.notifyToolsChangedHandler();
        return tools;
    }

    /**
    * Delete tools by name.
    * @param toolNames - Array of tool names to delete.
    * @returns Array of tool names that were deleted.
    */
    public deleteTools(toolNames: string[]): string[] {
        const notFoundTools: string[] = [];
        // Delete the tools
        for (const toolName of toolNames) {
            if (this.tools.has(toolName)) {
                this.tools.delete(toolName);
                log.info(`Deleted tool: ${toolName}`);
            } else {
                notFoundTools.push(toolName);
            }
        }

        if (toolNames.length > notFoundTools.length) {
            this.notifyToolsChangedHandler();
        }
        // Return the list of tools that were removed
        return toolNames.filter((toolName) => !notFoundTools.includes(toolName));
    }

    /**
     * Returns an array of tool names.
     * @returns {string[]} - An array of tool names.
     */
    public getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    private setupErrorHandling(setupSIGINTHandler = true): void {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error); // eslint-disable-line no-console
        };
        // Allow disable of SIGINT handler to prevent max listeners warning
        if (setupSIGINTHandler) {
            process.on('SIGINT', async () => {
                await this.server.close();
                process.exit(0);
            });
        }
    }

    private setupToolHandlers(): void {
        /**
         * Handles the request to list tools.
         * @param {object} request - The request object.
         * @returns {object} - The response object containing the tools.
         */
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = Array.from(this.tools.values()).map((tool) => (tool.tool));
            return { tools };
        });

        /**
         * Handles the request to call a tool.
         * @param {object} request - The request object containing tool name and arguments.
         * @throws {McpError} - based on the McpServer class code from the typescript MCP SDK
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const apifyToken = (request.params.apifyToken || process.env.APIFY_TOKEN) as string;

            // Remove apifyToken from request.params just in case
            delete request.params.apifyToken;

            // Validate token
            if (!apifyToken) {
                const msg = 'APIFY_TOKEN is required. It must be set in the environment variables or passed as a parameter in the body.';
                log.error(msg);
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }

            // TODO - if connection is /mcp client will not receive notification on tool change

            // Find tool by name or actor full name
            const tool = Array.from(this.tools.values())
                .find((t) => t.tool.name === name || (t.type === 'actor' && (t.tool as ActorTool).actorFullName === name));
            if (!tool) {
                const msg = `Tool ${name} not found. Available tools: ${this.getToolNames().join(', ')}`;
                log.error(msg);
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            if (!args) {
                const msg = `Missing arguments for tool ${name}`;
                log.error(msg);
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            log.info(`Validate arguments for tool: ${tool.tool.name} with arguments: ${JSON.stringify(args)}`);
            if (!tool.tool.ajvValidate(args)) {
                const msg = `Invalid arguments for tool ${tool.tool.name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(tool?.tool.ajvValidate.errors)}`;
                log.error(msg);
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }

            try {
                // Handle internal tool
                if (tool.type === 'internal') {
                    const internalTool = tool.tool as HelperTool;
                    const res = await internalTool.call({
                        args,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                        apifyToken,
                    }) as object;

                    return { ...res };
                }

                if (tool.type === 'actor-mcp') {
                    const serverTool = tool.tool as ActorMCPTool;
                    let client: Client | undefined;
                    try {
                        client = await createMCPClient(serverTool.serverUrl, apifyToken);
                        const res = await client.callTool({
                            name: serverTool.originToolName,
                            arguments: args,
                        }, CallToolResultSchema, {
                            timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
                        });

                        return { ...res };
                    } finally {
                        if (client) await client.close();
                    }
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
                log.error(`Error calling tool ${name}: ${error}`);
                throw new McpError(
                    ErrorCode.InternalError,
                    `An error occurred while calling the tool.`,
                );
            }

            const msg = `Unknown tool: ${name}`;
            log.error(msg);
            await this.server.sendLoggingMessage({
                level: 'error',
                data: msg,
            });
            throw new McpError(
                ErrorCode.InvalidParams,
                msg,
            );
        });
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }

    async close(): Promise<void> {
        await this.server.close();
    }
}
