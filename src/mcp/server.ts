/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { type ActorCallOptions, ApifyApiError } from 'apify-client';

import log from '@apify/log';

import {
    ACTOR_OUTPUT_MAX_CHARS_PER_ITEM,
    ACTOR_OUTPUT_TRUNCATED_MESSAGE,
    defaults,
    SERVER_NAME,
    SERVER_VERSION,
} from '../const.js';
import { addRemoveTools, callActorGetDataset, defaultTools, getActorsAsTools } from '../tools/index.js';
import { actorNameToToolName } from '../tools/utils.js';
import type { ActorMcpTool, ActorTool, HelperTool, ToolEntry } from '../types.js';
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
    public readonly tools: Map<string, ToolEntry>;
    private options: ActorsMcpServerOptions;
    private toolsChangedHandler: ToolsChangedHandler | undefined;

    constructor(options: ActorsMcpServerOptions = {}, setupSigintHandler = true) {
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
        this.setupErrorHandling(setupSigintHandler);
        this.setupToolHandlers();

        // Add default tools
        this.upsertTools(defaultTools);

        // Add tools to dynamically load Actors
        if (this.options.enableAddingActors) {
            this.enableDynamicActorTools();
        }

        // Initialize automatically for backward compatibility
        this.initialize().catch((error) => {
            log.error('Failed to initialize server:', error);
        });
    }

    /**
     * Returns an array of tool names.
     * @returns {string[]} - An array of tool names.
     */
    public listToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
    * Register handler to get notified when tools change.
    * The handler receives an array of tool names that the server has after the change.
    * This is primarily used to store the tools in shared state (e.g., Redis) for recovery
    * when the server loses local state.
    * @throws {Error} - If a handler is already registered.
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
    * @throws {Error} - If no handler is currently registered.
    */
    public unregisterToolsChangedHandler() {
        if (!this.toolsChangedHandler) {
            throw new Error('Tools changed handler is not registered.');
        }
        this.toolsChangedHandler = undefined;
    }

    /**
     * Returns the list of all internal tool names
     * @returns {string[]} - Array of loaded tool IDs (e.g., 'apify/rag-web-browser')
     */
    private listInternalToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === 'internal')
            .map((tool) => (tool.tool as HelperTool).name);
    }

    /**
     * Returns the list of all currently loaded Actor tool IDs.
     * @returns {string[]} - Array of loaded Actor tool IDs (e.g., 'apify/rag-web-browser')
     */
    private listActorToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === 'actor')
            .map((tool) => (tool.tool as ActorTool).actorFullName);
    }

    /**
     * Returns a list of Actor IDs that are registered as MCP servers.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    private listActorMcpServerToolIds(): string[] {
        const ids = Array.from(this.tools.values())
            .filter((tool: ToolEntry) => tool.type === 'actor-mcp')
            .map((tool: ToolEntry) => (tool.tool as ActorMcpTool).actorId);
        // Ensure uniqueness
        return Array.from(new Set(ids));
    }

    /**
     * Returns a list of Actor name and MCP server tool IDs.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    public listAllToolNames(): string[] {
        return [...this.listInternalToolNames(), ...this.listActorToolNames(), ...this.listActorMcpServerToolIds()];
    }

    /**
    * Loads missing toolNames from a provided list of tool names.
    * Skips toolNames that are already loaded and loads only the missing ones.
    * @param toolNames - Array of tool names to ensure are loaded
    * @param apifyToken - Apify API token for authentication
    */
    public async loadToolsByName(toolNames: string[], apifyToken: string) {
        const loadedTools = this.listAllToolNames();
        const actorsToLoad: string[] = [];
        const toolsToLoad: ToolEntry[] = [];
        const internalToolMap = new Map([...defaultTools, ...addRemoveTools].map((tool) => [tool.tool.name, tool]));

        for (const tool of toolNames) {
            // Skip if the tool is already loaded
            if (loadedTools.includes(tool)) continue;
            // Load internal tool
            if (internalToolMap.has(tool)) {
                toolsToLoad.push(internalToolMap.get(tool) as ToolEntry);
            // Load Actor
            } else {
                actorsToLoad.push(tool);
            }
        }
        if (toolsToLoad.length > 0) {
            this.upsertTools(toolsToLoad);
        }

        if (actorsToLoad.length > 0) {
            const actorTools = await getActorsAsTools(actorsToLoad, apifyToken);
            if (actorTools.length > 0) {
                this.upsertTools(actorTools);
            }
        }
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
        this.upsertTools(defaultTools);
        if (this.options.enableAddingActors) {
            this.enableDynamicActorTools();
        }
        // Initialize automatically for backward compatibility
        await this.initialize();
    }

    /**
     * Initialize the server with default tools if enabled
     */
    public async initialize(): Promise<void> {
        if (this.options.enableDefaultActors) {
            await this.loadDefaultActors(process.env.APIFY_TOKEN as string);
        }
    }

    /**
     * Loads default tools if not already loaded.
     * @param apifyToken - Apify API token for authentication
     * @returns {Promise<void>} - A promise that resolves when the tools are loaded
     */
    public async loadDefaultActors(apifyToken: string): Promise<void> {
        const missingActors = defaults.actors.filter((name) => !this.tools.has(actorNameToToolName(name)));
        const tools = await getActorsAsTools(missingActors, apifyToken);
        if (tools.length > 0) {
            log.info('Loading default tools...');
            this.upsertTools(tools);
        }
    }

    /**
     * @deprecated Use `loadDefaultActors` instead.
     * Loads default tools if not already loaded.
     */
    public async loadDefaultTools(apifyToken: string) {
        await this.loadDefaultActors(apifyToken);
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
            this.upsertTools(tools, false);
        }
    }

    /**
     * Add Actors to server dynamically
     */
    public enableDynamicActorTools() {
        this.options.enableAddingActors = true;
        this.upsertTools(addRemoveTools, false);
    }

    public disableDynamicActorTools() {
        this.options.enableAddingActors = false;
        this.removeToolsByName(addRemoveTools.map((tool) => tool.tool.name));
    }

    /** Delete tools from the server and notify the handler.
     */
    public removeToolsByName(toolNames: string[], shouldNotifyToolsChangedHandler = false): string[] {
        const removedTools: string[] = [];
        for (const toolName of toolNames) {
            if (this.removeToolByName(toolName)) {
                removedTools.push(toolName);
            }
        }
        if (removedTools.length > 0) {
            if (shouldNotifyToolsChangedHandler) this.notifyToolsChangedHandler();
        }
        return removedTools;
    }

    /**
     * Upsert new tools.
     * @param tools - Array of tool wrappers to add or update
     * @param shouldNotifyToolsChangedHandler - Whether to notify the tools changed handler
     * @returns Array of added/updated tool wrappers
     */
    public upsertTools(tools: ToolEntry[], shouldNotifyToolsChangedHandler = false) {
        for (const wrap of tools) {
            this.tools.set(wrap.tool.name, wrap);
            log.info(`Added/updated tool: ${wrap.tool.name}`);
        }
        if (shouldNotifyToolsChangedHandler) this.notifyToolsChangedHandler();
        return tools;
    }

    private notifyToolsChangedHandler() {
        // If no handler is registered, do nothing
        if (!this.toolsChangedHandler) return;

        // Get the list of tool names
        this.toolsChangedHandler(this.listAllToolNames());
    }

    private removeToolByName(toolName: string): boolean {
        if (this.tools.has(toolName)) {
            this.tools.delete(toolName);
            log.info(`Deleted tool: ${toolName}`);
            return true;
        }
        return false;
    }

    private setupErrorHandling(setupSIGINTHandler = true): void {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error); // eslint-disable-line no-console
        };
        // Allow disabling of the SIGINT handler to prevent max listeners warning
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
         * @param {object} extra - Extra data given to the request handler, such as sendNotification function.
         * @throws {McpError} - based on the McpServer class code from the typescript MCP SDK
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            // eslint-disable-next-line prefer-const
            let { name, arguments: args } = request.params;
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

            // Claude is saving tool names with 'local__' prefix, name is local__apify-actors__compass-slash-crawler-google-places
            // We are interested in the Actor name only, so we remove the 'local__apify-actors__' prefix
            if (name.startsWith('local__')) {
                // we split the name by '__' and take the last part, which is the actual Actor name
                const parts = name.split('__');
                log.info(`Tool name with prefix detected: ${name}, using last part: ${parts[parts.length - 1]}`);
                if (parts.length > 1) {
                    name = parts[parts.length - 1];
                }
            }
            // TODO - if connection is /mcp client will not receive notification on tool change
            // Find tool by name or actor full name
            const tool = Array.from(this.tools.values())
                .find((t) => t.tool.name === name || (t.type === 'actor' && (t.tool as ActorTool).actorFullName === name));
            if (!tool) {
                const msg = `Tool ${name} not found. Available tools: ${this.listToolNames().join(', ')}`;
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
                        extra,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                        apifyToken,
                    }) as object;

                    return { ...res };
                }

                if (tool.type === 'actor-mcp') {
                    const serverTool = tool.tool as ActorMcpTool;
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

                    const callOptions: ActorCallOptions = { memory: actorTool.memoryMbytes };
                    const { actorRun, datasetInfo, items } = await callActorGetDataset(
                        actorTool.actorFullName,
                        args,
                        apifyToken as string,
                        callOptions,
                    );
                    const content = [
                        { type: 'text', text: `Actor finished with run information: ${JSON.stringify(actorRun)}` },
                        { type: 'text', text: `Dataset information: ${JSON.stringify(datasetInfo)}` },
                    ];

                    const itemContents = items.items.map((item: Record<string, unknown>) => {
                        const text = JSON.stringify(item).slice(0, ACTOR_OUTPUT_MAX_CHARS_PER_ITEM);
                        return text.length === ACTOR_OUTPUT_MAX_CHARS_PER_ITEM
                            ? { type: 'text', text: `${text} ... ${ACTOR_OUTPUT_TRUNCATED_MESSAGE}` }
                            : { type: 'text', text };
                    });
                    content.push(...itemContents);
                    return { content };
                }
            } catch (error) {
                if (error instanceof ApifyApiError) {
                    log.error(`Apify API error calling tool ${name}: ${error.message}`);
                    return {
                        content: [
                            { type: 'text', text: `Apify API error calling tool ${name}: ${error.message}` },
                        ],
                    };
                }
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
