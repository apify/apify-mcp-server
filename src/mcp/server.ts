/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
    ReadResourceRequestSchema,
    ServerNotificationSchema,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import { type ActorCallOptions } from 'apify-client';

import log from '@apify/log';

import { ApifyClient } from '../apify-client.js';
import {
    HelperTools,
    SERVER_NAME,
    SERVER_VERSION,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_README_CONTENT,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../const.js';
import { prompts } from '../prompts/index.js';
import { getTelemetryEnv, trackToolCall } from '../telemetry.js';
import { callActorGetDataset, defaultTools, getActorsAsTools, toolCategories } from '../tools/index.js';
import { decodeDotPropertyNames } from '../tools/utils.js';
import type {
    ActorMcpTool,
    ActorsMcpServerOptions,
    ActorTool,
    HelperTool,
    ToolCallTelemetryProperties,
    ToolEntry,
} from '../types.js';
import { buildActorResponseContent } from '../utils/actor-response.js';
import { parseBooleanFromString } from '../utils/generic.js';
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { createProgressTracker } from '../utils/progress.js';
import { cloneToolEntry, getToolPublicFieldOnly } from '../utils/tools.js';
import { getUserIdFromToken } from '../utils/user-cache.js';
import { getPackageVersion } from '../utils/version.js';
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
    public readonly options: ActorsMcpServerOptions;
    // In-memory storage for tool call counters (used when toolCallCounterStore is not provided)
    private sessionToolCallCounters = new Map<string, number>();

    constructor(options: ActorsMcpServerOptions = {}) {
        this.options = options;

        const { setupSigintHandler = true } = options;
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
            },
            {
                capabilities: {
                    tools: { listChanged: true },
                    /**
                     * Declaring resources even though we are not using them
                     * to prevent clients like Claude desktop from failing.
                     */
                    resources: { },
                    prompts: { },
                    logging: {},
                },
            },
        );
        this.setupTelemetry();
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
     * Gets and increments the tool call counter for a session.
     * @param sessionId - The session ID
     * @returns Promise resolving to the new counter value (after increment)
     */
    private async getAndIncrementToolCallCounter(sessionId: string): Promise<number> {
        return await this.options.telemetry!.toolCallCountStore!.getAndIncrement(sessionId);
    }

    /**
     * Telemetry configuration with precedence: explicit options > env vars > defaults
     */
    private setupTelemetry() {
        // Initialize telemetry object if not present
        if (!this.options.telemetry) {
            this.options.telemetry = {};
        }

        // Configure telemetryEnabled: explicit option > env var > default (true)
        if (this.options.telemetry.enabled === undefined) {
            const envEnabled = parseBooleanFromString(process.env.TELEMETRY_ENABLED);
            this.options.telemetry.enabled = envEnabled !== undefined ? envEnabled : true;
        }

        // Configure telemetryEnv: explicit option > env var > default ('prod')
        // getTelemetryEnv always returns a value (defaults to 'prod'), so no need for undefined check
        const envVarEnv = process.env.TELEMETRY_ENV;
        const explicitEnv = this.options.telemetry.env;
        this.options.telemetry.env = getTelemetryEnv(explicitEnv ?? envVarEnv);

        // If telemetry is enabled, ensure telemetryEnv is set
        if (this.options.telemetry.enabled && this.options.telemetry.env === undefined) {
            this.options.telemetry.env = getTelemetryEnv(undefined);
        }

        // Provide default in-memory store if not provided
        if (!this.options.telemetry.toolCallCountStore) {
            this.options.telemetry.toolCallCountStore = {
                getAndIncrement: async (sessionId: string): Promise<number> => {
                    const current = this.sessionToolCallCounters.get(sessionId) || 0;
                    const newValue = current + 1;
                    this.sessionToolCallCounters.set(sessionId, newValue);
                    return newValue;
                },
            };
        }
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
            .map((tool) => tool.name);
    }

    /**
     * Returns the list of all currently loaded Actor tool IDs.
     * @returns {string[]} - Array of loaded Actor tool IDs (e.g., 'apify/rag-web-browser')
     */
    public listActorToolNames(): string[] {
        return Array.from(this.tools.values())
            .filter((tool) => tool.type === 'actor')
            .map((tool) => tool.actorFullName);
    }

    /**
     * Returns a list of Actor IDs that are registered as MCP servers.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    private listActorMcpServerToolIds(): string[] {
        const ids = Array.from(this.tools.values())
            .filter((tool: ToolEntry) => tool.type === 'actor-mcp')
            .map((tool) => tool.actorId);
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
    * @param apifyClient
    */
    public async loadToolsByName(toolNames: string[], apifyClient: ApifyClient) {
        const loadedTools = this.listAllToolNames();
        const actorsToLoad: string[] = [];
        const toolsToLoad: ToolEntry[] = [];
        const internalToolMap = new Map([
            ...defaultTools,
            ...Object.values(toolCategories).flat(),
        ].map((tool) => [tool.name, tool]));

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
            await this.loadActorsAsTools(actorsToLoad, apifyClient);
        }
    }

    /**
     * Load actors as tools, upsert them to the server, and return the tool entries.
     * This is a public method that wraps getActorsAsTools and handles the upsert operation.
     * @param actorIdsOrNames - Array of actor IDs or names to load as tools
     * @param apifyClient
     * @returns Promise<ToolEntry[]> - Array of loaded tool entries
     */
    public async loadActorsAsTools(actorIdsOrNames: string[], apifyClient: ApifyClient): Promise<ToolEntry[]> {
        const actorTools = await getActorsAsTools(actorIdsOrNames, apifyClient);
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
    public async loadToolsFromUrl(url: string, apifyClient: ApifyClient) {
        const tools = await processParamsGetTools(url, apifyClient);
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
        if (this.options.skyfireMode) {
            for (const wrap of tools) {
                // Clone the tool before modifying it to avoid affecting shared objects
                const clonedWrap = cloneToolEntry(wrap);
                let modified = false;

                // Handle Skyfire mode modifications
                if (this.options.skyfireMode && (wrap.type === 'actor'
                    || (wrap.type === 'internal' && wrap.name === HelperTools.ACTOR_CALL)
                    || (wrap.type === 'internal' && wrap.name === HelperTools.ACTOR_OUTPUT_GET))) {
                    // Add Skyfire instructions to description if not already present
                    if (clonedWrap.description && !clonedWrap.description.includes(SKYFIRE_TOOL_INSTRUCTIONS)) {
                        clonedWrap.description += `\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`;
                    }
                    // Add skyfire-pay-id property if not present
                    if (clonedWrap.inputSchema && 'properties' in clonedWrap.inputSchema) {
                        const props = clonedWrap.inputSchema.properties as Record<string, unknown>;
                        if (!props['skyfire-pay-id']) {
                            props['skyfire-pay-id'] = {
                                type: 'string',
                                description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
                            };
                        }
                    }
                    modified = true;
                }

                // Store the cloned and modified tool only if modifications were made
                this.tools.set(clonedWrap.name, modified ? clonedWrap : wrap);
            }
        } else {
            // No skyfire mode - store tools as-is
            for (const tool of tools) {
                this.tools.set(tool.name, tool);
            }
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
            /**
             * Return the usage guide resource only if Skyfire mode is enabled. No resources otherwise for normal mode.
             */
            if (this.options.skyfireMode) {
                return {
                    resources: [
                        {
                            uri: 'file://readme.md',
                            name: 'readme',
                            description: `Apify MCP Server usage guide. Read this to understand how to use the server, especially in Skyfire mode before interacting with it.`,
                            mimeType: 'text/markdown',
                        },
                    ],
                };
            }
            return { resources: [] };
        });

        if (this.options.skyfireMode) {
            this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
                const { uri } = request.params;
                if (uri === 'file://readme.md') {
                    return {
                        contents: [{
                            uri: 'file://readme.md',
                            mimeType: 'text/markdown',
                            text: SKYFIRE_README_CONTENT,
                        }],
                    };
                }
                return {
                    contents: [{
                        uri, mimeType: 'text/plain', text: `Resource ${uri} not found`,
                    }],
                };
            });
        }

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
            const tools = Array.from(this.tools.values()).map((tool) => getToolPublicFieldOnly(tool));
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
            const apifyToken = (request.params.apifyToken || this.options.token || process.env.APIFY_TOKEN) as string;
            const userRentedActorIds = request.params.userRentedActorIds as string[] | undefined;
            // mcpSessionId was injected upstream by stdio; optional (for telemetry purposes only)
            const mcpSessionId = typeof request.params.mcpSessionId === 'string' ? request.params.mcpSessionId : undefined;
            // Remove apifyToken from request.params just in case
            delete request.params.apifyToken;
            // Remove other custom params passed from apify-mcp-server
            delete request.params.userRentedActorIds;
            // Remove mcpSessionId
            delete request.params.mcpSessionId;

            // Validate token
            if (!apifyToken && !this.options.skyfireMode) {
                const msg = `APIFY_TOKEN is required but was not provided.
Please set the APIFY_TOKEN environment variable or pass it as a parameter in the request body.
You can obtain your Apify token from https://console.apify.com/account/integrations.`;
                log.softFail(msg, { statusCode: 400 });
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
                .find((t) => t.name === name || (t.type === 'actor' && t.actorFullName === name));
            if (!tool) {
                const availableTools = this.listToolNames();
                const msg = `Tool "${name}" was not found.
Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
Please verify the tool name is correct. You can list all available tools using the tools/list request.`;
                log.softFail(msg, { statusCode: 404 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            if (!args) {
                const msg = `Missing arguments for tool "${name}".
Please provide the required arguments for this tool. Check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool to see what parameters are required.`;
                log.softFail(msg, { statusCode: 400 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            // Decode dot property names in arguments before validation,
            // since validation expects the original, non-encoded property names.
            args = decodeDotPropertyNames(args);
            log.debug('Validate arguments for tool', { toolName: tool.name, input: args });
            if (!tool.ajvValidate(args)) {
                const errors = tool?.ajvValidate.errors || [];
                const errorMessages = errors.map((e: { message?: string; instancePath?: string }) => `${e.instancePath || 'root'}: ${e.message || 'validation error'}`).join('; ');
                const msg = `Invalid arguments for tool "${tool.name}".
Validation errors: ${errorMessages}.
Please check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool and ensure all required parameters are provided with correct types and values.`;
                log.softFail(msg, { statusCode: 400 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            const { telemetryData, userId } = await this.prepareTelemetryData(tool, mcpSessionId, apifyToken);

            const startTime = Date.now();
            let toolStatus: 'succeeded' | 'failed' | 'aborted' = 'succeeded';

            try {
                // Handle internal tool
                if (tool.type === 'internal') {
                    // Only create progress tracker for call-actor tool
                    const progressTracker = tool.name === 'call-actor'
                        ? createProgressTracker(progressToken, extra.sendNotification)
                        : null;

                    log.info('Calling internal tool', { name: tool.name, input: args });
                    const res = await tool.call({
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
                    let client: Client | null = null;
                    try {
                        client = await connectMCPClient(tool.serverUrl, apifyToken);
                        if (!client) {
                            const msg = `Failed to connect to MCP server at "${tool.serverUrl}".
Please verify the server URL is correct and accessible, and ensure you have a valid Apify token with appropriate permissions.`;
                            log.softFail(msg, { statusCode: 408 }); // 408 Request Timeout
                            await this.server.sendLoggingMessage({ level: 'error', data: msg });
                            return buildMCPResponse([msg], true);
                        }

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

                        log.info('Calling Actor-MCP', { actorId: tool.actorId, toolName: tool.originToolName, input: args });
                        const res = await client.callTool({
                            name: tool.originToolName,
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
                    if (this.options.skyfireMode && args['skyfire-pay-id'] === undefined) {
                        return buildMCPResponse([SKYFIRE_TOOL_INSTRUCTIONS]);
                    }

                    // Create progress tracker if progressToken is available
                    const progressTracker = createProgressTracker(progressToken, extra.sendNotification);

                    const callOptions: ActorCallOptions = { memory: tool.memoryMbytes };

                    /**
                     * Create Apify token, for Skyfire mode use `skyfire-pay-id` and for normal mode use `apifyToken`.
                     */
                    const { 'skyfire-pay-id': skyfirePayId, ...actorArgs } = args as Record<string, unknown>;
                    const apifyClient = this.options.skyfireMode && typeof skyfirePayId === 'string'
                        ? new ApifyClient({ skyfirePayId })
                        : new ApifyClient({ token: apifyToken });

                    try {
                        log.info('Calling Actor', { actorName: tool.actorFullName, input: actorArgs });
                        const callResult = await callActorGetDataset(
                            tool.actorFullName,
                            actorArgs,
                            apifyClient,
                            callOptions,
                            progressTracker,
                            extra.signal,
                        );

                        if (!callResult) {
                            toolStatus = 'aborted';
                            // Receivers of cancellation notifications SHOULD NOT send a response for the cancelled request
                            // https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation#behavior-requirements
                            return { };
                        }

                        const content = buildActorResponseContent(tool.actorFullName, callResult);
                        return { content };
                    } finally {
                        if (progressTracker) {
                            progressTracker.stop();
                        }
                    }
                }
            } catch (error) {
                toolStatus = extra.signal?.aborted ? 'aborted' : 'failed';
                logHttpError(error, 'Error occurred while calling tool', { toolName: name });
                const errorMessage = (error instanceof Error) ? error.message : 'Unknown error';
                return buildMCPResponse([
                    `Error calling tool "${name}": ${errorMessage}.
Please verify the tool name, input parameters, and ensure all required resources are available.`,
                ], true);
            } finally {
                this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
            }

            const availableTools = this.listToolNames();
            const msg = `Unknown tool type for "${name}".
Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
Please verify the tool name and ensure the tool is properly registered.`;
            log.softFail(msg, { statusCode: 404 });
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

    /**
     * Finalizes and tracks telemetry for a tool call.
     * Calculates execution time, sets final status, and sends the telemetry event.
     *
     * @param telemetryData - Telemetry data to finalize and track (null if telemetry is disabled)
     * @param userId - Apify user ID
     * @param startTime - Timestamp when the tool call started
     * @param toolStatus - Final status of the tool call ('succeeded', 'failed', or 'aborted')
     */
    private finalizeAndTrackTelemetry(
        telemetryData: ToolCallTelemetryProperties | null,
        userId: string,
        startTime: number,
        toolStatus: 'succeeded' | 'failed' | 'aborted',
    ): void {
        if (!telemetryData) {
            return;
        }

        const execTime = Date.now() - startTime;
        const finalizedTelemetryData: ToolCallTelemetryProperties = {
            ...telemetryData,
            tool_status: toolStatus,
            tool_exec_time_ms: execTime,
        };
        trackToolCall(userId, finalizedTelemetryData);
    }

    /*
    * Creates telemetry data for a tool call.
    */
    private async prepareTelemetryData(
        tool: HelperTool | ActorTool | ActorMcpTool, mcpSessionId: string | undefined, apifyToken: string,
    ): Promise<{ telemetryData: ToolCallTelemetryProperties | null; userId: string }> {
        if (this.options.telemetry?.enabled !== true) {
            return { telemetryData: null, userId: '' };
        }

        const toolFullName = tool.type === 'actor' ? tool.actorFullName : tool.name;

        // Get or increment tool call counter for this session
        let toolCallNumber = 0;
        if (mcpSessionId) {
            try {
                toolCallNumber = await this.getAndIncrementToolCallCounter(mcpSessionId);
            } catch (error) {
                log.warning('Failed to get tool call counter', { mcpSessionId, error: String(error) });
            }
        }

        // Get userId from cache or fetch from API
        let userId = '';
        if (apifyToken) {
            const apifyClient = new ApifyClient({ token: apifyToken });
            const userInfo = await getUserIdFromToken(apifyToken, apifyClient);
            userId = userInfo?.id || '';
            log.debug('Telemetry: fetched user info', { userId, userFound: !!userInfo });
        }

        const capabilities = this.options.initializeRequestData?.params?.capabilities;
        const params = this.options.initializeRequestData?.params as InitializeRequest['params'];
        const telemetryData: ToolCallTelemetryProperties = {
            app_name: 'apify-mcp-server',
            app_version: getPackageVersion() || '',
            mcp_client_name: params?.clientInfo?.name || '',
            mcp_client_version: params?.clientInfo?.version || '',
            mcp_protocol_version: params?.protocolVersion || '',
            mcp_capabilities: capabilities ? JSON.stringify(capabilities) : '',
            mcp_session_id: mcpSessionId || '',
            transport_type: this.options.transportType || '',
            tool_name: toolFullName,
            tool_status: 'succeeded', // Will be updated in finally
            tool_exec_time_ms: 0, // Will be calculated in finally
            tool_call_number: toolCallNumber,
        };

        return { telemetryData, userId };
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
            if (tool.ajvValidate && typeof tool.ajvValidate === 'function') {
                (tool as { ajvValidate: ValidateFunction<unknown> | null }).ajvValidate = null;
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
