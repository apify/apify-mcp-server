/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import { randomUUID } from 'node:crypto';

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest, Notification, Request } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import type { ApifyClient } from '../apify-client.js';
import {
    APIFY_MCP_URL,
    DEFAULT_TELEMETRY_ENABLED,
    DEFAULT_TELEMETRY_ENV,
    SERVER_NAME,
    SERVER_VERSION,
    TOOL_STATUS,
} from '../const.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { getTelemetryEnv } from '../telemetry.js';
import { getActorsAsTools } from '../tools/index.js';
import type {
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
import { logHttpError } from '../utils/logging.js';
import { buildMCPResponse } from '../utils/mcp.js';
import { getServerInstructions } from '../utils/server-instructions.js';
import { getToolStatusFromError } from '../utils/tool-status.js';
import { getToolPublicFieldOnly } from '../utils/tools.js';
import { LOG_LEVEL_MAP } from './const.js';
import {
    setupLoggingHandlers as setupLoggingHandlersHelper,
    setupLoggingProxy as setupLoggingProxyHelper,
} from './logging_handlers.js';
import { registerPromptHandlers } from './prompt_handlers.js';
import { registerResourceHandlers } from './resource_handlers.js';
import { registerTaskHandlers } from './task_handlers.js';
import {
    finalizeAndTrackTelemetry as finalizeAndTrackTelemetryHelper,
    prepareTelemetryData as prepareTelemetryDataHelper,
} from './telemetry_helpers.js';
import { validateAndPrepareToolCall } from './tool_call_validation.js';
import { executeToolForCall, executeToolForTask } from './tool_execution.js';
import {
    getToolsAndActorsToLoad,
    listActorToolNames as listActorToolNamesFromRegistry,
    listAllToolNames as listAllToolNamesFromRegistry,
    listToolNames as listToolNamesFromRegistry,
    removeToolsByName as removeToolsByNameFromRegistry,
    upsertTools as upsertToolsIntoRegistry,
} from './tool_registry.js';
import { isTaskCancelled, processParamsGetTools } from './utils.js';
import { resolveWidgets as resolveWidgetsHelper } from './widgets_resolver.js';

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
        return listToolNamesFromRegistry(this.tools);
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
     * Returns the list of all currently loaded Actor tool IDs.
     * @returns {string[]} - Array of loaded Actor tool IDs (e.g., 'apify/rag-web-browser')
     */
    public listActorToolNames(): string[] {
        return listActorToolNamesFromRegistry(this.tools);
    }

    /**
     * Returns a list of Actor name and MCP server tool IDs.
     * @returns {string[]} - An array of Actor MCP server Actor IDs (e.g., 'apify/actors-mcp-server').
     */
    public listAllToolNames(): string[] {
        return listAllToolNamesFromRegistry(this.tools);
    }

    /**
    * Loads missing toolNames from a provided list of tool names.
    * Skips toolNames that are already loaded and loads only the missing ones.
    * @param toolNames - Array of tool names to ensure are loaded
    * @param apifyClient
    */
    public async loadToolsByName(toolNames: string[], apifyClient: ApifyClient) {
        const loadedToolNames = this.listAllToolNames();
        const { toolsToLoad, actorsToLoad } = getToolsAndActorsToLoad({
            toolNames,
            loadedToolNames,
        });

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
        const removedTools = removeToolsByNameFromRegistry({
            toolsRegistry: this.tools,
            toolNames,
        });
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
        upsertToolsIntoRegistry({
            toolsRegistry: this.tools,
            tools,
            skyfireMode: this.options.skyfireMode,
        });
        if (shouldNotifyToolsChangedHandler) this.notifyToolsChangedHandler();
        return tools;
    }

    private notifyToolsChangedHandler() {
        // If no handler is registered, do nothing
        if (!this.toolsChangedHandler) return;

        // Get the list of tool names
        this.toolsChangedHandler(this.listAllToolNames());
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
        setupLoggingProxyHelper({
            server: this.server,
            logLevelMap: LOG_LEVEL_MAP,
            getCurrentLogLevel: () => this.currentLogLevel,
        });
    }

    private setupLoggingHandlers(): void {
        setupLoggingHandlersHelper({
            server: this.server,
            logLevelMap: LOG_LEVEL_MAP,
            setCurrentLogLevel: (level) => {
                this.currentLogLevel = level;
            },
        });
    }

    private setupResourceHandlers(): void {
        registerResourceHandlers({
            server: this.server,
            skyfireMode: this.options.skyfireMode,
            uiMode: this.options.uiMode,
            getAvailableWidgets: () => this.availableWidgets,
        });
    }

    /**
     * Sets up MCP request handlers for prompts.
     */
    private setupPromptHandlers(): void {
        registerPromptHandlers({
            server: this.server,
        });
    }

    /**
      * Sets up MCP request handlers for long-running tasks.
      */
    private setupTaskHandlers(): void {
        registerTaskHandlers({
            server: this.server,
            taskStore: this.taskStore,
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
            // TODO: we should split this huge method into smaller parts as it is slowly getting out of hand
            const {
                name,
                args,
                tool,
                apifyToken,
                progressToken,
                userRentedActorIds,
                mcpSessionId,
                task: taskParams,
            } = await validateAndPrepareToolCall({
                request: request as { params: ApifyRequestParams & { name: string; arguments?: Record<string, unknown> } },
                options: this.options,
                tools: this.tools,
                server: this.server,
                listToolNames: () => this.listToolNames(),
            });

            // Handle long-running task request
            if (taskParams) {
                const task = await this.taskStore.createTask(
                    {
                        ttl: taskParams.ttl,
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
                const toolExecutionResult = await executeToolForCall({
                    tool,
                    args,
                    apifyToken,
                    progressToken,
                    extra,
                    mcpSessionId,
                    userRentedActorIds,
                    apifyMcpServer: this,
                    mcpServer: this.server,
                });

                toolStatus = toolExecutionResult.toolStatus;
                if (toolExecutionResult.handled) {
                    return toolExecutionResult.response ?? {};
                }
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
        finalizeAndTrackTelemetryHelper({
            telemetryData,
            userId,
            startTime,
            toolStatus,
            telemetryEnv: this.telemetryEnv,
        });
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

            const taskToolExecutionResult = await executeToolForTask({
                tool,
                args,
                apifyToken,
                progressToken,
                extra,
                mcpSessionId,
                userRentedActorIds,
                apifyMcpServer: this,
                mcpServer: this.server,
                taskId,
            });

            const { response: result } = taskToolExecutionResult;
            toolStatus = taskToolExecutionResult.toolStatus;

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
        return await prepareTelemetryDataHelper({
            telemetryEnabled: this.telemetryEnabled,
            tool,
            mcpSessionId,
            apifyToken,
            initializeRequestData: this.options.initializeRequestData as InitializeRequest | undefined,
            transportType: this.options.transportType,
        });
    }

    /**
     * Resolves widgets and determines which ones are ready to be served.
     */
    private async resolveWidgets(): Promise<void> {
        const widgets = await resolveWidgetsHelper(this.options.uiMode);
        if (widgets) {
            this.availableWidgets = widgets;
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
