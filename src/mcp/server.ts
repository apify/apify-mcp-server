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
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from '../apify-client.js';
import type { HelperTools } from '../const.js';
import {
    APIFY_MCP_URL,
    DEFAULT_TELEMETRY_ENABLED,
    DEFAULT_TELEMETRY_ENV,
    SERVER_NAME,
    SERVER_VERSION,
    SKYFIRE_ENABLED_TOOLS,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_TOOL_INSTRUCTIONS,
    TOOL_STATUS,
} from '../const.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { resolveAvailableWidgets } from '../resources/widgets.js';
import { getTelemetryEnv, trackToolCall } from '../telemetry.js';
import { defaultTools, getActorsAsTools, toolCategories } from '../tools/index.js';
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
import { cloneToolEntry, getToolPublicFieldOnly } from '../utils/tools.js';
import { getUserIdFromTokenCached } from '../utils/userid-cache.js';
import { getPackageVersion } from '../utils/version.js';
import { LOG_LEVEL_MAP } from './const.js';
import { registerPromptHandlers } from './prompt_handlers.js';
import { registerResourceHandlers } from './resource_handlers.js';
import { registerTaskHandlers } from './task_handlers.js';
import { validateAndPrepareToolCall } from './tool_call_validation.js';
import { executeToolForCall, executeToolForTask } from './tool_execution.js';
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
