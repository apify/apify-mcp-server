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
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ServerNotificationSchema,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import { type ActorCallOptions, ApifyApiError } from 'apify-client';

import log from '@apify/log';

import {
    SERVER_NAME,
    SERVER_VERSION,
} from '../const.js';
import { prompts } from '../prompts/index.js';
import { callActorGetDataset, defaultTools, getActorsAsTools, toolCategories } from '../tools/index.js';
import { decodeDotPropertyNames } from '../tools/utils.js';
import type { ActorMcpTool, ActorTool, HelperTool, ToolEntry } from '../types.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { createProgressTracker } from '../utils/progress.js';
import { getToolPublicFieldOnly } from '../utils/tools.js';
import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, LOG_LEVEL_MAP } from './const.js';
import { processParamsGetTools } from './utils.js';

type ToolsChangedHandler = (toolNames: string[]) => void;

/**
 * Create Apify MCP server
 */
export class ActorsMcpServer {
    public readonly server: Server;
    public readonly tools: Map<string, ToolEntry>;
    private toolsChangedHandler: ToolsChangedHandler | undefined;
    private sigintHandler: (() => Promise<void>) | undefined;
    private currentLogLevel = 'info';

    constructor(setupSigintHandler = true) {
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
            },
            {
                capabilities: {
                    tools: { listChanged: true },
                    /**
                     * Declaring prompts even though we are not using them
                     * to prevent clients like Claude desktop from failing.
                     */
                    resources: { },
                    prompts: { },
                    logging: {},
                },
            },
        );
        this.setupLoggingProxy();
        this.tools = new Map();
        this.setupErrorHandling(setupSigintHandler);
        this.setupLoggingHandlers();
        this.setupToolHandlers();
        this.setupPromptHandlers();
        /**
         * We need to handle resource requests to prevent clients like Claude desktop from failing.
         */
        this.setupResourceHandlers();
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
    public listActorToolNames(): string[] {
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
        const internalToolMap = new Map([
            ...defaultTools,
            ...Object.values(toolCategories).flat(),
        ].map((tool) => [tool.tool.name, tool]));

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
            await this.loadActorsAsTools(actorsToLoad, apifyToken);
        }
    }

    /**
     * Load actors as tools, upsert them to the server, and return the tool entries.
     * This is a public method that wraps getActorsAsTools and handles the upsert operation.
     * @param actorIdsOrNames - Array of actor IDs or names to load as tools
     * @param apifyToken - Apify API token for authentication
     * @returns Promise<ToolEntry[]> - Array of loaded tool entries
     */
    public async loadActorsAsTools(actorIdsOrNames: string[], apifyToken: string): Promise<ToolEntry[]> {
        const actorTools = await getActorsAsTools(actorIdsOrNames, apifyToken);
        if (actorTools.length > 0) {
            this.upsertTools(actorTools, true);
        }
        return actorTools;
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
            log.debug('Loading tools from query parameters');
            this.upsertTools(tools, false);
        }
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
            log.debug('Deleted tool', { toolName });
            return true;
        }
        return false;
    }

    private setupErrorHandling(setupSIGINTHandler = true): void {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error); // eslint-disable-line no-console
        };
        if (setupSIGINTHandler) {
            const handler = async () => {
                await this.server.close();
                process.exit(0);
            };
            process.once('SIGINT', handler);
            this.sigintHandler = handler; // Store the actual handler
        }
    }

    private setupLoggingProxy(): void {
        // Store original sendLoggingMessage
        const originalSendLoggingMessage = this.server.sendLoggingMessage.bind(this.server);

        // Proxy sendLoggingMessage to filter logs
        this.server.sendLoggingMessage = async (params: { level: string; data?: unknown; [key: string]: unknown }) => {
            const messageLevelValue = LOG_LEVEL_MAP[params.level] ?? -1; // Unknown levels get -1, discard
            const currentLevelValue = LOG_LEVEL_MAP[this.currentLogLevel] ?? LOG_LEVEL_MAP.info; // Default to info if invalid
            if (messageLevelValue >= currentLevelValue) {
                await originalSendLoggingMessage(params as Parameters<typeof originalSendLoggingMessage>[0]);
            }
        };
    }

    private setupLoggingHandlers(): void {
        this.server.setRequestHandler(SetLevelRequestSchema, (request) => {
            const { level } = request.params;
            if (LOG_LEVEL_MAP[level] !== undefined) {
                this.currentLogLevel = level;
            }
            // Sending empty result based on MCP spec
            return {};
        });
    }

    private setupResourceHandlers(): void {
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            // No resources available, return empty response
            return { resources: [] };
        });

        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
            // No resource templates available, return empty response
            return { resourceTemplates: [] };
        });
    }

    /**
     * Sets up MCP request handlers for prompts.
     */
    private setupPromptHandlers(): void {
        /**
         * Handles the prompts/list request.
         */
        this.server.setRequestHandler(ListPromptsRequestSchema, () => {
            return { prompts };
        });

        /**
         * Handles the prompts/get request.
         */
        this.server.setRequestHandler(GetPromptRequestSchema, (request) => {
            const { name, arguments: args } = request.params;
            const prompt = prompts.find((p) => p.name === name);
            if (!prompt) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Prompt ${name} not found. Available prompts: ${prompts.map((p) => p.name).join(', ')}`,
                );
            }
            if (!prompt.ajvValidate(args)) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Invalid arguments for prompt ${name}: args: ${JSON.stringify(args)} error: ${JSON.stringify(prompt.ajvValidate.errors)}`,
                );
            }
            return {
                description: prompt.description,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: prompt.render(args || {}),
                        },
                    },
                ],
            };
        });
    }

    private setupToolHandlers(): void {
        /**
         * Handles the request to list tools.
         * @param {object} request - The request object.
         * @returns {object} - The response object containing the tools.
         */
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = Array.from(this.tools.values()).map((tool) => getToolPublicFieldOnly(tool.tool));
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
            let { name, arguments: args, _meta: meta } = request.params;
            const { progressToken } = meta || {};
            const apifyToken = (request.params.apifyToken || process.env.APIFY_TOKEN) as string;
            const userRentedActorIds = request.params.userRentedActorIds as string[] | undefined;

            // Remove apifyToken from request.params just in case
            delete request.params.apifyToken;
            // Remove other custom params passed from apify-mcp-server
            delete request.params.userRentedActorIds;

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
                log.debug('Tool name with prefix detected', { toolName: name, lastPart: parts[parts.length - 1] });
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
            // Decode dot property names in arguments before validation,
            // since validation expects the original, non-encoded property names.
            args = decodeDotPropertyNames(args);
            log.debug('Validate arguments for tool', { toolName: tool.tool.name, input: args });
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

                    // Only create progress tracker for call-actor tool
                    const progressTracker = internalTool.name === 'call-actor'
                        ? createProgressTracker(progressToken, extra.sendNotification)
                        : null;

                    log.info('Calling internal tool', { name: internalTool.name, input: args });
                    const res = await internalTool.call({
                        args,
                        extra,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                        apifyToken,
                        userRentedActorIds,
                        progressTracker,
                    }) as object;

                    if (progressTracker) {
                        progressTracker.stop();
                    }

                    return { ...res };
                }

                if (tool.type === 'actor-mcp') {
                    const serverTool = tool.tool as ActorMcpTool;
                    let client: Client | undefined;
                    try {
                        client = await connectMCPClient(serverTool.serverUrl, apifyToken);

                        // Only set up notification handlers if progressToken is provided by the client
                        if (progressToken) {
                            // Set up notification handlers for the client
                            for (const schema of ServerNotificationSchema.options) {
                                const method = schema.shape.method.value;
                                // Forward notifications from the proxy client to the server
                                client.setNotificationHandler(schema, async (notification) => {
                                    log.debug('Sending MCP notification', {
                                        method,
                                        notification,
                                    });
                                    await extra.sendNotification(notification);
                                });
                            }
                        }

                        log.info('Calling Actor-MCP', { actorId: serverTool.actorId, toolName: serverTool.originToolName, input: args });
                        const res = await client.callTool({
                            name: serverTool.originToolName,
                            arguments: args,
                            _meta: {
                                progressToken,
                            },
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

                    // Create progress tracker if progressToken is available
                    const progressTracker = createProgressTracker(progressToken, extra.sendNotification);

                    const callOptions: ActorCallOptions = { memory: actorTool.memoryMbytes };

                    try {
                        log.info('Calling Actor', { actorName: actorTool.actorFullName, input: args });
                        const callResult = await callActorGetDataset(
                            actorTool.actorFullName,
                            args,
                            apifyToken as string,
                            callOptions,
                            progressTracker,
                            extra.signal,
                        );

                        if (!callResult) {
                            // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                            // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                            return { };
                        }

                        const content = buildActorResponseContent(actorTool.actorFullName, callResult);
                        return { content };
                    } finally {
                        if (progressTracker) {
                            progressTracker.stop();
                        }
                    }
                }
            } catch (error) {
                if (error instanceof ApifyApiError) {
                    log.error('Apify API error calling tool', { toolName: name, error });
                    return {
                        content: [
                            { type: 'text', text: `Apify API error calling tool ${name}: ${error.message}` },
                        ],
                    };
                }
                log.error('Error calling tool', { toolName: name, error });
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
        // Remove SIGINT handler
        if (this.sigintHandler) {
            process.removeListener('SIGINT', this.sigintHandler);
            this.sigintHandler = undefined;
        }
        // Clear all tools and their compiled schemas
        for (const tool of this.tools.values()) {
            if (tool.tool.ajvValidate && typeof tool.tool.ajvValidate === 'function') {
                (tool.tool as { ajvValidate: ValidateFunction<unknown> | null }).ajvValidate = null;
            }
        }
        this.tools.clear();
        // Unregister tools changed handler
        if (this.toolsChangedHandler) {
            this.unregisterToolsChangedHandler();
        }
        // Close server (which should also remove its event handlers)
        await this.server.close();
    }
}
