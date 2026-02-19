/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { randomUUID } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelTaskRequestSchema,
    ErrorCode,
    GetPromptRequestSchema,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListTasksRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
    ServerNotificationSchema,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient, createApifyClientWithSkyfireSupport } from '../apify-client.js';
import {
    ALLOWED_TASK_TOOL_EXECUTION_MODES,
    APIFY_MCP_URL,
    DEFAULT_TELEMETRY_ENABLED,
    DEFAULT_TELEMETRY_ENV,
    HelperTools,
    SERVER_NAME,
    SERVER_VERSION,
    SKYFIRE_ENABLED_TOOLS,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_TOOL_INSTRUCTIONS,
    TOOL_STATUS,
} from '../const.js';
import { prompts } from '../prompts/index.js';
import { createResourceService } from '../resources/resource_service.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';
import { getTelemetryEnv, trackToolCall } from '../telemetry.js';
import { defaultActorExecutor } from '../tools/default/actor-executor.js';
import { defaultTools, getActorsAsTools, toolCategories } from '../tools/index.js';
import { openaiActorExecutor } from '../tools/openai/actor-executor.js';
import { decodeDotPropertyNames } from '../tools/utils.js';
import type {
    ActorExecutor,
    ActorMcpTool,
    ActorsMcpServerOptions,
    ActorStore,
    ActorTool,
    ApifyRequestParams,
    HelperTool,
    TelemetryEnv,
    ToolCallTelemetryProperties,
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { logHttpError, redactSkyfirePayId } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { createProgressTracker } from '../utils/progress.js';
import { getServerInstructions } from '../utils/server-instructions.js';
import { validateSkyfirePayId } from '../utils/skyfire.js';
import { getToolStatusFromError } from '../utils/tool-status.js';
import { cloneToolEntry, getToolPublicFieldOnly } from '../utils/tools.js';
import { getUserIdFromTokenCached } from '../utils/userid-cache.js';
import { getPackageVersion } from '../utils/version.js';
import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, LOG_LEVEL_MAP } from './const.js';
import { isTaskCancelled, processParamsGetTools } from './utils.js';

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
    public readonly taskStore: TaskStore;
    public readonly actorStore?: ActorStore;
    /** Mode-specific executor for direct actor tools (`type: 'actor'`). */
    private readonly actorExecutor: ActorExecutor;

    // Telemetry configuration (resolved from options and env vars in setupTelemetry)
    private telemetryEnabled: boolean | null = null;
    private telemetryEnv: TelemetryEnv = DEFAULT_TELEMETRY_ENV;

    // List of widgets that are ready to be served
    private availableWidgets: Map<string, AvailableWidget> = new Map();

    constructor(options: ActorsMcpServerOptions = {}) {
        this.options = options;

        // for stdio use in memory task store if not provided, otherwise use provided task store
        if (this.options.transportType === 'stdio' && !this.options.taskStore) {
            this.taskStore = new InMemoryTaskStore();
        } else if (this.options.taskStore) {
            this.taskStore = this.options.taskStore;
        } else {
            throw new Error('Task store must be provided for non-stdio transport types');
        }
        this.actorStore = options.actorStore;
        this.actorExecutor = options.uiMode === 'openai'
            ? openaiActorExecutor
            : defaultActorExecutor;

        const { setupSigintHandler = true } = options;
        this.server = new Server(
            {
                name: SERVER_NAME,
                version: SERVER_VERSION,
                websiteUrl: APIFY_MCP_URL,
            },
            {
                capabilities: {
                    tools: {
                        listChanged: true,
                    },
                    // Declare long-running task support
                    tasks: {
                        list: {},
                        cancel: {},
                        requests: {
                            tools: {
                                call: {},
                            },
                        },
                    },
                    /**
                     * Declaring resources even though we are not using them
                     * to prevent clients like Claude desktop from failing.
                     */
                    resources: { },
                    prompts: { },
                    logging: {},
                },
                instructions: getServerInstructions(options.uiMode),
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
        this.setupTaskHandlers();
    }

    /**
     * Telemetry configuration with precedence: explicit options > env vars > defaults
     */
    private setupTelemetry() {
        const explicitEnabled = parseBooleanOrNull(this.options.telemetry?.enabled);
        if (explicitEnabled !== null) {
            this.telemetryEnabled = explicitEnabled;
        } else {
            const envEnabled = parseBooleanOrNull(process.env.TELEMETRY_ENABLED);
            this.telemetryEnabled = envEnabled ?? DEFAULT_TELEMETRY_ENABLED;
        }

        // Configure telemetryEnv: explicit option > env var > default ('PROD')
        if (this.telemetryEnabled) {
            this.telemetryEnv = getTelemetryEnv(this.options.telemetry?.env ?? process.env.TELEMETRY_ENV);
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
        const actorTools = await getActorsAsTools(actorIdsOrNames, apifyClient, { actorStore: this.actorStore });
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
        const tools = await processParamsGetTools(url, apifyClient, this.options.uiMode, this.actorStore);
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
                    || (wrap.type === 'internal' && SKYFIRE_ENABLED_TOOLS.has(wrap.name as HelperTools)))) {
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
        const resourceService = createResourceService({
            skyfireMode: this.options.skyfireMode,
            uiMode: this.options.uiMode,
            getAvailableWidgets: () => this.availableWidgets,
        });

        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return await resourceService.listResources();
        });

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return await resourceService.readResource(request.params.uri);
        });

        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
            return await resourceService.listResourceTemplates();
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

    /**
      * Sets up MCP request handlers for long-running tasks.
      */
    private setupTaskHandlers(): void {
        // List tasks
        this.server.setRequestHandler(ListTasksRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { cursor?: string };
            const { cursor } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[ListTasksRequestSchema] Listing tasks', { mcpSessionId });
            const result = await this.taskStore.listTasks(cursor, mcpSessionId);
            return { tasks: result.tasks, nextCursor: result.nextCursor };
        });

        // Get task status
        this.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskRequestSchema] Getting task status', { taskId, mcpSessionId });
            const task = await this.taskStore.getTask(taskId, mcpSessionId);
            if (task) return task;

            // logging as this may not be just a soft fail but related to issue with the task store
            log.error('[GetTaskRequestSchema] Task not found', { taskId, mcpSessionId });
            throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found`);
        });

        // Get task result payload
        this.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskPayloadRequestSchema] Getting task result', { taskId, mcpSessionId });
            const task = await this.taskStore.getTask(taskId, mcpSessionId);
            if (!task) {
                // logging as this may not be just a soft fail but related to issue with the task store
                log.error('[GetTaskPayloadRequestSchema] Task not found', { taskId, mcpSessionId });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" not found`,
                );
            }
            if (task.status !== 'completed' && task.status !== 'failed') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" is not completed yet. Current status: ${task.status}`,
                );
            }
            return await this.taskStore.getTaskResult(taskId, mcpSessionId);
        });

        // Cancel task
        this.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
            // mcpSessionId is injected at transport layer for session isolation in task stores
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[CancelTaskRequestSchema] Cancelling task', { taskId, mcpSessionId });

            const task = await this.taskStore.getTask(taskId, mcpSessionId);
            if (!task) {
                // logging as this may not be just a soft fail but related to issue with the task store
                log.error('[CancelTaskRequestSchema] Task not found', { taskId, mcpSessionId });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" not found`,
                );
            }
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
                log.error('[CancelTaskRequestSchema] Task already in terminal state', {
                    taskId,
                    mcpSessionId,
                    status: task.status,
                });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Cannot cancel task "${taskId}" with status "${task.status}"`,
                );
            }
            await this.taskStore.updateTaskStatus(taskId, 'cancelled', 'Cancelled by client', mcpSessionId);
            const updatedTask = await this.taskStore.getTask(taskId, mcpSessionId);
            log.debug('[CancelTaskRequestSchema] Task cancelled successfully', { taskId, mcpSessionId });
            return updatedTask!;
        });
    }

    private setupToolHandlers(): void {
        /**
         * Handles the request to list tools.
         * @param {object} request - The request object.
         * @returns {object} - The response object containing the tools.
         */
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = Array.from(this.tools.values()).map((tool) => getToolPublicFieldOnly(tool, {
                uiMode: this.options.uiMode,
                filterOpenAiMeta: true,
            }));
            return { tools };
        });

        /**
         * Handles the request to call a tool.
         * @param {object} request - The request object containing tool name and arguments.
         * @param {object} extra - Extra data given to the request handler, such as sendNotification function.
         * @throws {McpError} - based on the McpServer class code from the typescript MCP SDK
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const params = request.params as ApifyRequestParams & { name: string; arguments?: Record<string, unknown> };
            // eslint-disable-next-line prefer-const
            let { name, arguments: args, _meta: meta } = params;
            const progressToken = meta?.progressToken;
            const metaApifyToken = meta?.apifyToken;
            const apifyToken = (metaApifyToken || this.options.token || process.env.APIFY_TOKEN) as string;
            const userRentedActorIds = meta?.userRentedActorIds;
            // mcpSessionId was injected upstream it is important and required for long running tasks as the store uses it and there is not other way to pass it
            const mcpSessionId = meta?.mcpSessionId;
            if (!mcpSessionId) {
                log.error('MCP Session ID is missing in tool call request. This should never happen.');
                throw new Error('MCP Session ID is required for tool calls');
            }

            // Validate token
            if (!apifyToken && !this.options.skyfireMode && !this.options.allowUnauthMode) {
                const msg = `Apify API token is required but was not provided.
Please set the APIFY_TOKEN environment variable or pass it as a parameter in the request header as Authorization Bearer <token>.
You can obtain your Apify token from https://console.apify.com/account/integrations.`;
                log.softFail(msg, { mcpSessionId, statusCode: 400 });
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
                log.debug('Tool name with prefix detected', { toolName: name, lastPart: parts[parts.length - 1], mcpSessionId });
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
                log.softFail(msg, { mcpSessionId, statusCode: 404 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            if (!args) {
                const msg = `Missing arguments for tool "${name}".
Please provide the required arguments for this tool. Check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool to see what parameters are required.`;
                log.softFail(msg, { mcpSessionId, statusCode: 400 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            // Decode dot property names in arguments before validation,
            // since validation expects the original, non-encoded property names.
            args = decodeDotPropertyNames(args as Record<string, unknown>) as Record<string, unknown>;
            log.debug('Validate arguments for tool', { toolName: tool.name, mcpSessionId, input: args });
            if (!tool.ajvValidate(args)) {
                const errors = tool?.ajvValidate.errors || [];
                const errorMessages = errors.map((e: { message?: string; instancePath?: string }) => `${e.instancePath || 'root'}: ${e.message || 'validation error'}`).join('; ');
                const msg = `Invalid arguments for tool "${tool.name}".
Validation errors: ${errorMessages}.
Please check the tool's input schema using ${HelperTools.ACTOR_GET_DETAILS} tool and ensure all required parameters are provided with correct types and values.`;
                log.softFail(msg, { mcpSessionId, statusCode: 400 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }
            // TODO: we should split this huge method into smaller parts as it is slowly getting out of hand
            // Check if tool call is a long running task and the tool supports that
            // Cast to allowed task mode types ('optional' | 'required') for type-safe includes() check
            const taskSupport = tool.execution?.taskSupport as typeof ALLOWED_TASK_TOOL_EXECUTION_MODES[number];
            if (request.params.task && !ALLOWED_TASK_TOOL_EXECUTION_MODES.includes(taskSupport)) {
                const msg = `Tool "${tool.name}" does not support long running task calls.
Please remove the "task" parameter from the tool call request or use a different tool that supports long running tasks.`;
                log.softFail(msg, { mcpSessionId, statusCode: 400 });
                await this.server.sendLoggingMessage({ level: 'error', data: msg });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    msg,
                );
            }

            // Handle long-running task request
            if (request.params.task) {
                const task = await this.taskStore.createTask(
                    {
                        ttl: request.params.task.ttl,
                    },
                    `call-tool-${name}-${randomUUID()}`,
                    request,
                );
                log.debug('Created task for tool execution', { taskId: task.taskId, toolName: tool.name, mcpSessionId });

                // Execute the tool asynchronously and update task status
                setImmediate(async () => {
                    await this.executeToolAndUpdateTask({
                        taskId: task.taskId,
                        tool,
                        args,
                        apifyToken,
                        progressToken,
                        extra,
                        mcpSessionId,
                        userRentedActorIds,
                    });
                });

                // Return task immediately; execution continues asynchronously
                return { task };
            }

            const { telemetryData, userId } = await this.prepareTelemetryData(tool, mcpSessionId, apifyToken);

            const startTime = Date.now();
            let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;

            try {
                // Centralized skyfire validation for tools that require it
                if (tool.requiresSkyfirePayId) {
                    const skyfireError = validateSkyfirePayId(this, args);
                    if (skyfireError) {
                        toolStatus = TOOL_STATUS.SOFT_FAIL;
                        return skyfireError;
                    }
                }

                // Handle internal tool
                if (tool.type === 'internal') {
                    // Only create progress tracker for call-actor tool
                    const progressTracker = tool.name === 'call-actor'
                        ? createProgressTracker(progressToken, extra.sendNotification)
                        : null;

                    log.info('Calling internal tool', { name: tool.name, mcpSessionId, input: redactSkyfirePayId(args) });
                    const res = await tool.call({
                        args,
                        extra,
                        apifyMcpServer: this,
                        mcpServer: this.server,
                        apifyToken,
                        userRentedActorIds,
                        progressTracker,
                        mcpSessionId,
                    }) as object;

                    if (progressTracker) {
                        progressTracker.stop();
                    }

                    // If tool provided internal status, use it; otherwise infer from isError flag
                    const { internalToolStatus, ...rest } = res as { internalToolStatus?: ToolStatus; isError?: boolean };
                    if (internalToolStatus !== undefined) {
                        toolStatus = internalToolStatus;
                    } else if ('isError' in rest && rest.isError) {
                        toolStatus = TOOL_STATUS.FAILED;
                    } else {
                        toolStatus = TOOL_STATUS.SUCCEEDED;
                    }

                    // Never expose internal _toolStatus field to MCP clients
                    return { ...rest };
                }

                if (tool.type === 'actor-mcp') {
                    let client: Client | null = null;
                    try {
                        client = await connectMCPClient(tool.serverUrl, apifyToken, mcpSessionId);
                        if (!client) {
                            const msg = `Failed to connect to MCP server at "${tool.serverUrl}".
Please verify the server URL is correct and accessible, and ensure you have a valid Apify token with appropriate permissions.`;
                            log.softFail(msg, { mcpSessionId, statusCode: 408 }); // 408 Request Timeout
                            await this.server.sendLoggingMessage({ level: 'error', data: msg });
                            toolStatus = TOOL_STATUS.SOFT_FAIL;
                            return buildMCPResponse({ texts: [msg], isError: true });
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
                                        mcpSessionId,
                                        notification,
                                    });
                                    await extra.sendNotification(notification);
                                });
                            }
                        }

                        log.info('Calling Actor-MCP', { actorId: tool.actorId, toolName: tool.originToolName, mcpSessionId, input: redactSkyfirePayId(args) });
                        const res = await client.callTool({
                            name: tool.originToolName,
                            arguments: args,
                            _meta: {
                                progressToken,
                            },
                        }, CallToolResultSchema, {
                            timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC,
                        });

                        // For external MCP servers we do not try to infer soft_fail vs failed from isError.
                        // We treat the call as succeeded at the telemetry layer unless an actual error is thrown.
                        return { ...res };
                    } catch (error) {
                        logHttpError(error, `Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}'`, {
                            actorId: tool.actorId,
                            toolName: tool.originToolName,
                        });
                        toolStatus = TOOL_STATUS.FAILED;
                        return buildMCPResponse({
                            texts: [`Failed to call MCP tool '${tool.originToolName}' on Actor '${tool.actorId}': ${error instanceof Error ? error.message : String(error)}. The MCP server may be temporarily unavailable.`],
                            isError: true,
                        });
                    } finally {
                        if (client) await client.close();
                    }
                }

                // Handle actor tool
                if (tool.type === 'actor') {
                    const progressTracker = createProgressTracker(progressToken, extra.sendNotification);
                    const { 'skyfire-pay-id': _skyfirePayId, ...actorArgs } = args as Record<string, unknown>;
                    const apifyClient = createApifyClientWithSkyfireSupport(this, args, apifyToken);

                    try {
                        log.info('Calling Actor', { actorName: tool.actorFullName, mcpSessionId, input: redactSkyfirePayId(actorArgs) });
                        const executorResult = await this.actorExecutor.executeActorTool({
                            actorFullName: tool.actorFullName,
                            input: actorArgs,
                            apifyClient,
                            callOptions: { memory: tool.memoryMbytes },
                            progressTracker,
                            abortSignal: extra.signal,
                            mcpSessionId,
                        });

                        if (!executorResult) {
                            toolStatus = TOOL_STATUS.ABORTED;
                            return {};
                        }

                        return executorResult;
                    } finally {
                        if (progressTracker) {
                            progressTracker.stop();
                        }
                    }
                }
                // If we reached here without returning, it means the tool type was not recognized (user error)
                toolStatus = TOOL_STATUS.SOFT_FAIL;
            } catch (error) {
                toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
                logHttpError(error, 'Error occurred while calling tool', { toolName: name });
                const errorMessage = (error instanceof Error) ? error.message : 'Unknown error';
                return buildMCPResponse({
                    texts: [`Error calling tool "${name}": ${errorMessage}.  Please verify the tool name, input parameters, and ensure all required resources are available.`],
                    isError: true,
                    toolStatus,
                });
            } finally {
                this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
            }

            const availableTools = this.listToolNames();
            const msg = `Unknown tool type for "${name}".
Available tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'none'}.
Please verify the tool name and ensure the tool is properly registered.`;
            log.softFail(msg, { mcpSessionId, statusCode: 404 });
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
     * @param userId - Apify user ID (string or null if not available)
     * @param startTime - Timestamp when the tool call started
     * @param toolStatus - Final status of the tool call
     */
    private finalizeAndTrackTelemetry(
        telemetryData: ToolCallTelemetryProperties | null,
        userId: string | null,
        startTime: number,
        toolStatus: ToolStatus,
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
        trackToolCall(userId, this.telemetryEnv, finalizedTelemetryData);
    }

    // TODO: this function quite duplicates the main tool call login the CallToolRequestSchema handler, we should refactor
    /**
     * Executes a tool asynchronously for a long-running task and updates task status.
     *
     * @param params - Tool execution parameters
     * @param params.taskId - The task identifier
     * @param params.tool - The tool to execute
     * @param params.args - Tool arguments
     * @param params.apifyToken - Apify API token
     * @param params.progressToken - Progress token for notifications
     * @param params.extra - Extra request handler context
     * @param params.mcpSessionId - MCP session ID for telemetry
     */

    private async executeToolAndUpdateTask(params: {
        taskId: string;
        tool: ToolEntry;
        args: Record<string, unknown>;
        apifyToken: string;
        progressToken: string | number | undefined;
        extra: RequestHandlerExtra<Request, Notification>;
        mcpSessionId: string | undefined;
        userRentedActorIds?: string[];
    }): Promise<void> {
        const { taskId, tool, args, apifyToken, progressToken, extra, mcpSessionId, userRentedActorIds } = params;
        let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
        const startTime = Date.now();

        log.debug('[executeToolAndUpdateTask] Starting task execution', {
            taskId,
            toolName: tool.name,
            mcpSessionId,
        });

        // Prepare telemetry before try-catch so it's accessible to both paths.
        // This avoids re-fetching user data in the error handler.
        const { telemetryData, userId } = await this.prepareTelemetryData(tool, mcpSessionId, apifyToken);

        try {
            // Check if task was already cancelled before we start execution.
            // Critical: if a client cancels the task immediately after creation (race condition),
            // attempting to transition from 'cancelled' (terminal state) to 'working' will fail in the SDK
            // because terminal states cannot transition to other states. We must check before calling updateTaskStatus.
            if (await isTaskCancelled(taskId, mcpSessionId, this.taskStore)) {
                log.debug('[executeToolAndUpdateTask] Task was cancelled before execution started, skipping', {
                    taskId,
                    mcpSessionId,
                });
                this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, TOOL_STATUS.ABORTED);
                return;
            }

            log.debug('[executeToolAndUpdateTask] Updating task status to working', {
                taskId,
                mcpSessionId,
            });
            await this.taskStore.updateTaskStatus(taskId, 'working', undefined, mcpSessionId);

            // Execute the tool and get the result
            let result: Record<string, unknown> = {};

            // Centralized skyfire validation for tools that require it
            if (tool.requiresSkyfirePayId) {
                const skyfireError = validateSkyfirePayId(this, args);
                if (skyfireError) {
                    result = skyfireError;
                    toolStatus = TOOL_STATUS.SOFT_FAIL;
                }
            }

            // Handle internal tool execution in task mode
            if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === 'internal') {
                const progressTracker = createProgressTracker(progressToken, extra.sendNotification, taskId);

                log.info('Calling internal tool for task', { taskId, name: tool.name, mcpSessionId, input: redactSkyfirePayId(args) });
                const res = await tool.call({
                    args,
                    extra,
                    apifyMcpServer: this,
                    mcpServer: this.server,
                    apifyToken,
                    userRentedActorIds,
                    progressTracker,
                    mcpSessionId,
                }) as object;

                if (progressTracker) {
                    progressTracker.stop();
                }

                // If tool provided internal status, use it; otherwise infer from isError flag
                const { internalToolStatus, ...rest } = res as { internalToolStatus?: ToolStatus; isError?: boolean };
                if (internalToolStatus !== undefined) {
                    toolStatus = internalToolStatus;
                } else if ('isError' in rest && rest.isError) {
                    toolStatus = TOOL_STATUS.FAILED;
                } else {
                    toolStatus = TOOL_STATUS.SUCCEEDED;
                }

                result = rest;
            }

            // Handle actor tool execution in task mode
            if (toolStatus === TOOL_STATUS.SUCCEEDED && tool.type === 'actor') {
                const progressTracker = createProgressTracker(progressToken, extra.sendNotification, taskId);
                const { 'skyfire-pay-id': _skyfirePayId, ...actorArgs } = args as Record<string, unknown>;
                const apifyClient = createApifyClientWithSkyfireSupport(this, args, apifyToken);

                try {
                    log.info('Calling Actor for task', { taskId, actorName: tool.actorFullName, mcpSessionId, input: redactSkyfirePayId(actorArgs) });
                    const executorResult = await this.actorExecutor.executeActorTool({
                        actorFullName: tool.actorFullName,
                        input: actorArgs,
                        apifyClient,
                        callOptions: { memory: tool.memoryMbytes },
                        progressTracker,
                        abortSignal: extra.signal,
                        mcpSessionId,
                    });

                    if (!executorResult) {
                        toolStatus = TOOL_STATUS.ABORTED;
                        result = {};
                    } else {
                        result = executorResult;
                    }
                } finally {
                    if (progressTracker) {
                        progressTracker.stop();
                    }
                }
            }

            // Check if task was cancelled before storing result
            if (await isTaskCancelled(taskId, mcpSessionId, this.taskStore)) {
                log.debug('[executeToolAndUpdateTask] Task was cancelled, skipping result storage', {
                    taskId,
                    mcpSessionId,
                });
                this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
                return;
            }

            // Store the result in the task store
            log.debug('[executeToolAndUpdateTask] Storing completed result', {
                taskId,
                mcpSessionId,
            });
            await this.taskStore.storeTaskResult(taskId, 'completed', result, mcpSessionId);
            log.debug('Task completed successfully', { taskId, toolName: tool.name, mcpSessionId });

            this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
        } catch (error) {
            log.error('Error executing tool for task', { taskId, mcpSessionId, error });
            toolStatus = getToolStatusFromError(error, Boolean(extra.signal?.aborted));
            const errorMessage = (error instanceof Error) ? error.message : 'Unknown error';

            // Check if task was cancelled before storing result
            // TODO: In future, we should actually stop execution via AbortController,
            // but coordinating cancellation across distributed nodes would be complex
            if (await isTaskCancelled(taskId, mcpSessionId, this.taskStore)) {
                log.debug('[executeToolAndUpdateTask] Task was cancelled, skipping result storage', {
                    taskId,
                    mcpSessionId,
                });
                this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
                return;
            }

            log.debug('[executeToolAndUpdateTask] Storing failed result', {
                taskId,
                mcpSessionId,
                error: errorMessage,
            });
            await this.taskStore.storeTaskResult(taskId, 'failed', {
                content: [{
                    type: 'text' as const,
                    text: `Error calling tool: ${errorMessage}. Please verify the tool name, input parameters, and ensure all required resources are available.`,
                }],
                isError: true,
                internalToolStatus: toolStatus,
            }, mcpSessionId);

            this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
        }
    }

    /*
     * Creates telemetry data for a tool call.
    */
    private async prepareTelemetryData(
        tool: HelperTool | ActorTool | ActorMcpTool, mcpSessionId: string | undefined, apifyToken: string,
    ): Promise<{ telemetryData: ToolCallTelemetryProperties | null; userId: string | null }> {
        if (!this.telemetryEnabled) {
            return { telemetryData: null, userId: null };
        }

        const toolFullName = tool.type === 'actor' ? tool.actorFullName : tool.name;

        // Get userId from cache or fetch from API
        let userId: string | null = null;
        if (apifyToken) {
            const apifyClient = new ApifyClient({ token: apifyToken });
            userId = await getUserIdFromTokenCached(apifyToken, apifyClient);
            log.debug('Telemetry: fetched userId', { userId, mcpSessionId });
        }
        const capabilities = this.options.initializeRequestData?.params?.capabilities;
        const params = this.options.initializeRequestData?.params as InitializeRequest['params'];
        const telemetryData: ToolCallTelemetryProperties = {
            app: 'mcp',
            app_version: getPackageVersion() || '',
            mcp_client_name: params?.clientInfo?.name || '',
            mcp_client_version: params?.clientInfo?.version || '',
            mcp_protocol_version: params?.protocolVersion || '',
            mcp_client_capabilities: capabilities || null,
            mcp_session_id: mcpSessionId || '',
            transport_type: this.options.transportType || '',
            tool_name: toolFullName,
            tool_status: TOOL_STATUS.SUCCEEDED, // Will be updated in finally
            tool_exec_time_ms: 0, // Will be calculated in finally
        };

        return { telemetryData, userId };
    }

    /**
     * Resolves widgets and determines which ones are ready to be served.
     */
    private async resolveWidgets(): Promise<void> {
        if (this.options.uiMode !== 'openai') {
            return;
        }

        try {
            const { fileURLToPath } = await import('node:url');
            const path = await import('node:path');

            const filename = fileURLToPath(import.meta.url);
            const dirName = path.dirname(filename);

            const resolved = await resolveAvailableWidgets(dirName);
            this.availableWidgets = resolved;

            const readyWidgets: string[] = [];
            const missingWidgets: string[] = [];

            for (const [uri, widget] of resolved.entries()) {
                if (widget.exists) {
                    readyWidgets.push(widget.name);
                } else {
                    missingWidgets.push(widget.name);
                    log.softFail(`Widget file not found: ${widget.jsPath} (widget: ${uri})`);
                }
            }

            if (readyWidgets.length > 0) {
                log.debug('Ready widgets', { widgets: readyWidgets });
            }

            if (missingWidgets.length > 0) {
                log.softFail('Some widgets are not ready', {
                    widgets: missingWidgets,
                    note: 'These widgets will not be available. Ensure web/dist files are built and included in deployment.',
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.softFail(`Failed to resolve widgets: ${errorMessage}`);
            // Continue without widgets
        }
    }

    async connect(transport: Transport): Promise<void> {
        await this.resolveWidgets();
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
