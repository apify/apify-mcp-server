/**
 * Model Context Protocol (MCP) server for Apify Actors
 */

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
} from '../const.js';
import type { AvailableWidget } from '../resources/widgets.js';
import { getTelemetryEnv } from '../telemetry.js';
import { getActorsAsTools } from '../tools/index.js';
import type {
    ActorMcpTool,
    ActorsMcpServerOptions,
    ActorStore,
    ActorTool,
    HelperTool,
    TelemetryEnv,
    ToolCallTelemetryProperties,
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { getServerInstructions } from '../utils/server-instructions.js';
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
import { registerToolHandlers } from './tool_handlers.js';
import {
    getToolsAndActorsToLoad,
    listActorToolNames as listActorToolNamesFromRegistry,
    listAllToolNames as listAllToolNamesFromRegistry,
    listToolNames as listToolNamesFromRegistry,
    removeToolsByName as removeToolsByNameFromRegistry,
    upsertTools as upsertToolsIntoRegistry,
} from './tool_registry.js';
import { processParamsGetTools } from './utils.js';
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
        registerToolHandlers({
            server: this.server,
            tools: this.tools,
            options: this.options,
            taskStore: this.taskStore,
            apifyMcpServer: this,
            listToolNames: () => this.listToolNames(),
            prepareTelemetryData: async (tool, mcpSessionId, apifyToken) => this.prepareTelemetryData(tool, mcpSessionId, apifyToken),
            finalizeAndTrackTelemetry: (telemetryData, userId, startTime, toolStatus) => {
                this.finalizeAndTrackTelemetry(telemetryData, userId, startTime, toolStatus);
            },
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
