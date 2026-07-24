/**
 * Legacy (v1 SDK) MCP wiring extracted from `ActorsMcpServer`.
 *
 * `LegacyMcpServer` owns the v1 SDK `Server`, every request handler (initialize, logging, tools,
 * prompts, resources, tasks), notifications, error mapping, SIGINT + transport lifecycle. It reads
 * shared Apify state through the narrow {@link LegacyMcpServerHost} interface (implemented by
 * `ActorsMcpServer`), never importing the concrete facade class. This adapter is package-private —
 * not exported from `index.ts` / `index_internals.ts`.
 */

import { randomUUID } from 'node:crypto';

import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { InitializeRequest, InitializeResult, Task } from '@modelcontextprotocol/sdk/types.js';
import {
    CallToolRequestSchema,
    CancelTaskRequestSchema,
    ErrorCode,
    GetPromptRequestSchema,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    InitializeRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListTasksRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
    RELATED_TASK_META_KEY,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import log from '@apify/log';

import type { ApifyClient } from '../apify_client.js';
import { FAILURE_CATEGORY, TOOL_STATUS } from '../const.js';
import type { createPromptService } from '../prompts/prompt_service.js';
import type { createResourceService } from '../resources/resource_service.js';
import { getServerInfo } from '../server_card.js';
import { withReportProblemNudge } from '../tools/dev/report_problem.js';
import type {
    ActorsMcpServerOptions,
    ActorStore,
    ApifyRequestParams,
    CallDiagnostics,
    SERVER_MODE,
    TelemetryEnv,
    ToolEntry,
    ToolStatus,
} from '../types.js';
import { isMcpClientFaultMessage, sanitizeMezmoMessage } from '../utils/logging.js';
import { getServerInstructions } from '../utils/server-instructions/index.js';
import { buildActorFields, getToolFullName, getToolPublicFieldOnly } from '../utils/tools.js';
import type { McpClientContext } from './client_context.js';
import { LOG_LEVEL_MAP } from './const.js';
import { InternalError, InvalidParamsError } from './errors.js';
import { emitTaskStatusNotification, executeToolAndUpdateTask } from './task_execution.js';
import {
    buildPreflightFailureOutcome,
    classifyToolCallError,
    executeSyncToolCall,
    prepareToolCall,
} from './tool_call_engine.js';
import { logToolCallAndTelemetry, prepareTelemetryData } from './tool_call_telemetry.js';
import { storeTaskResultOrSkipIfExpired } from './utils.js';

/**
 * Legacy protocol boundary: project a service's domain error to its v1 `McpError`, copying `message`
 * and `data` unchanged so the wire output (code, message, presence of `data`) is byte-identical.
 * Non-domain errors pass through untouched.
 */
function toLegacyMcpError(error: unknown): unknown {
    if (error instanceof InvalidParamsError) return new McpError(ErrorCode.InvalidParams, error.message, error.data);
    if (error instanceof InternalError) return new McpError(ErrorCode.InternalError, error.message, error.data);
    return error;
}

/**
 * Read-facing view of the shared `ActorsMcpServer` facade that the legacy adapter depends on. Keeps
 * the coupling one-directional and greppable: the adapter reads live shared state (tools mutate after
 * construction) and neutral services, and never sees the concrete facade class.
 */
export interface LegacyMcpServerHost {
    readonly tools: Map<string, ToolEntry>;
    readonly serverMode: SERVER_MODE;
    readonly actorStore?: ActorStore;
    readonly clientContext: McpClientContext | undefined;
    readonly telemetryEnabled: boolean;
    readonly telemetryEnv: TelemetryEnv;
    readonly options: ActorsMcpServerOptions;
    readonly promptService: ReturnType<typeof createPromptService>;
    readonly resourceService: ReturnType<typeof createResourceService>;
    listToolNames(): string[];
    listAllToolNames(): string[];
    resolveApifyToken(meta?: ApifyRequestParams['_meta']): string | undefined;
    resolveApifyClient(params: ApifyRequestParams): ApifyClient | undefined;
    getServerInstructions(): string;
    applyInitialize(request: InitializeRequest): Promise<void>;
}

type LegacyMcpServerOptions = {
    setupSigintHandler: boolean;
    taskStore?: TaskStore;
    transportType?: 'stdio' | 'http';
};

/**
 * v1 SDK adapter. One per serving unit, constructed only by `ActorsMcpServer`.
 */
export class LegacyMcpServer {
    public readonly server: Server;
    public readonly taskStore: TaskStore;
    private readonly host: LegacyMcpServerHost;
    private sigintHandler: (() => Promise<void>) | undefined;
    private currentLogLevel = 'info';

    constructor(host: LegacyMcpServerHost, options: LegacyMcpServerOptions) {
        this.host = host;

        // for stdio use in memory task store if not provided, otherwise use provided task store
        if (options.transportType === 'stdio' && !options.taskStore) {
            this.taskStore = new InMemoryTaskStore();
        } else if (options.taskStore) {
            this.taskStore = options.taskStore;
        } else {
            throw new Error('Task store must be provided for non-stdio transport types');
        }

        this.server = new Server(getServerInfo(), {
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
                // Declared but unused — some clients (e.g. Claude Desktop) fail without it.
                resources: {},
                prompts: {},
                logging: {},
            },
            instructions: getServerInstructions(),
        });
        this.setupInitializeHandler();
        this.setupLoggingProxy();
        this.setupErrorHandling(options.setupSigintHandler);
        this.setupLoggingHandlers();
        this.setupToolHandlers();
        this.setupPromptHandlers();
        // Handle resource requests so clients like Claude Desktop don't fail.
        this.setupResourceHandlers();
        this.setupTaskHandlers();
    }

    /**
     * Override the SDK's `initialize` request handler to run mode resolution and
     * pending-source flush before `InitializeResult` is sent. Delegates boilerplate
     * (protocolVersion, capabilities, instructions) to the SDK's captured `_oninitialize`.
     *
     * Not using `server.oninitialized`: the SDK dispatches notification handlers
     * fire-and-forget (separate microtask), so a follow-up `tools/list` can race past them.
     * The request handler guarantees tools are final before the response and the first `tools/list`.
     */
    private setupInitializeHandler() {
        // Capture the SDK's default initialize handler installed in its constructor.
        // Private-field access on the SDK Server — verified against
        // @modelcontextprotocol/sdk ^1.25.x (see package.json). On SDK bumps, re-check
        // `@modelcontextprotocol/sdk/shared/protocol.js` for a still-named `_oninitialize`;
        // if renamed or made non-delegable, rebuild the InitializeResult shape here
        // (protocolVersion, serverInfo, capabilities, instructions) instead of delegating.
        // The capability-gating unit tests construct a server and act as a canary.
        // eslint-disable-next-line no-underscore-dangle
        const sdkInitHandler = (
            this.server as unknown as {
                _oninitialize(req: InitializeRequest): Promise<InitializeResult>;
            }
        )._oninitialize.bind(this.server);

        this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
            await this.host.applyInitialize(request);

            const result = await sdkInitHandler(request);
            // Tools are final here (applyInitialize flushed pending tools, applying the per-client
            // blocklist), so tool presence is the ground truth for whether to advertise
            // report-problem in the instructions.
            result.instructions = this.host.getServerInstructions();
            return result;
        });
    }

    private setupErrorHandling(setupSIGINTHandler = true): void {
        this.server.onerror = (error) => {
            // Known client faults are expected noise, not server bugs — softFail so they don't
            // flood Mezmo error alerts. The fault patterns live in utils/logging.ts.
            const message = error.message ?? '';
            if (isMcpClientFaultMessage(message)) {
                // Sanitize the errMessage value to preserve the soft-fail level (Mezmo promotes
                // entries whose message contains "error").
                log.softFail('MCP client fault, request could not be handled', {
                    errMessage: sanitizeMezmoMessage(message),
                });
            } else {
                log.error('[MCP Error]', { error });
            }
        };
        if (setupSIGINTHandler) {
            const handler = async () => {
                await this.server.close();
                process.exit(0);
            };
            process.once('SIGINT', handler);
            this.sigintHandler = handler;
        }
    }

    private setupLoggingProxy(): void {
        const originalSendLoggingMessage = this.server.sendLoggingMessage.bind(this.server);

        // Filter outgoing log messages below the client's requested level.
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
        const { resourceService } = this.host;

        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return await resourceService.listResources();
        });

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            try {
                return await resourceService.readResource(
                    request.params.uri,
                    this.host.resolveApifyClient(request.params as ApifyRequestParams),
                );
            } catch (error) {
                throw toLegacyMcpError(error);
            }
        });

        this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
            return await resourceService.listResourceTemplates();
        });
    }

    /**
     * Sets up MCP request handlers for prompts. The prompt service throws domain errors; the
     * boundary maps them to `McpError` so wire output is unchanged.
     */
    private setupPromptHandlers(): void {
        const { promptService } = this.host;
        this.server.setRequestHandler(ListPromptsRequestSchema, () => promptService.listPrompts());
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            try {
                return promptService.getPrompt(request.params.name, request.params.arguments);
            } catch (error) {
                throw toLegacyMcpError(error);
            }
        });
    }

    /**
     * Fetches a task by ID, softFail-logging and throwing a client-facing McpError if it doesn't exist.
     */
    private async getTaskOrThrow(taskId: string, mcpSessionId: string | undefined, logTag: string): Promise<Task> {
        const task = await this.taskStore.getTask(taskId, mcpSessionId);
        if (!task) {
            // Client error (invalid/unknown taskId) — softFail to avoid polluting error logs.
            log.softFail(`[${logTag}] Task not found`, { taskId, mcpSessionId, statusCode: 404 });
            throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found`);
        }
        return task;
    }

    /**
     * Sets up MCP request handlers for long-running tasks.
     * Each handler reads `_meta.mcpSessionId` (injected at the transport layer) to isolate
     * per-session task stores.
     */
    private setupTaskHandlers(): void {
        // List tasks
        this.server.setRequestHandler(ListTasksRequestSchema, async (request) => {
            const params = (request.params || {}) as ApifyRequestParams & { cursor?: string };
            const { cursor } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[ListTasksRequestSchema] Listing tasks', { mcpSessionId });
            const result = await this.taskStore.listTasks(cursor, mcpSessionId);
            return { tasks: result.tasks, nextCursor: result.nextCursor };
        });

        // Get task status
        this.server.setRequestHandler(GetTaskRequestSchema, async (request) => {
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskRequestSchema] Getting task status', { taskId, mcpSessionId });
            return await this.getTaskOrThrow(taskId, mcpSessionId, 'GetTaskRequestSchema');
        });

        // Get task result payload
        this.server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[GetTaskPayloadRequestSchema] Getting task result', { taskId, mcpSessionId });
            const task = await this.getTaskOrThrow(taskId, mcpSessionId, 'GetTaskPayloadRequestSchema');
            if (task.status !== 'completed' && task.status !== 'failed') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Task "${taskId}" is not completed yet. Current status: ${task.status}`,
                );
            }
            const result = await this.taskStore.getTaskResult(taskId, mcpSessionId);
            // taskId is not in the result body — _meta.related-task lets clients correlate them
            return {
                ...result,
                _meta: {
                    ...(result._meta as Record<string, unknown>),
                    [RELATED_TASK_META_KEY]: { taskId },
                },
            };
        });

        // Cancel task
        this.server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
            const params = (request.params || {}) as ApifyRequestParams & { taskId: string };
            const { taskId } = params;
            const mcpSessionId = params._meta?.mcpSessionId;
            log.debug('[CancelTaskRequestSchema] Cancelling task', { taskId, mcpSessionId });

            const task = await this.getTaskOrThrow(taskId, mcpSessionId, 'CancelTaskRequestSchema');
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
                // Client error (cancel on terminal task) — softFail to avoid polluting error logs.
                log.softFail('[CancelTaskRequestSchema] Task already in terminal state', {
                    taskId,
                    mcpSessionId,
                    status: task.status,
                    statusCode: 409,
                });
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Cannot cancel task "${taskId}" with status "${task.status}"`,
                );
            }
            await this.taskStore.updateTaskStatus(taskId, 'cancelled', 'Cancelled by client', mcpSessionId);
            const updatedTask = await this.taskStore.getTask(taskId, mcpSessionId);
            log.debug('[CancelTaskRequestSchema] Task cancelled successfully', { taskId, mcpSessionId });
            await emitTaskStatusNotification(taskId, mcpSessionId, this.taskStore, this.server);
            return updatedTask!;
        });
    }

    private setupToolHandlers(): void {
        // Handles the request to list tools.
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = Array.from(this.host.tools.values()).map((tool) =>
                getToolPublicFieldOnly(tool, {
                    mode: this.host.serverMode,
                    filterWidgetMeta: true,
                }),
            );
            return { tools };
        });

        /**
         * Handles the request to call a tool. `extra` carries request-scoped helpers such as
         * `sendNotification`. Throws {@link McpError} to mirror the MCP SDK's McpServer error codes.
         */
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const params = request.params as ApifyRequestParams & { name: string; arguments?: Record<string, unknown> };
            // Keep telemetry on the decoded arguments.
            // eslint-disable-next-line prefer-const
            let { name, arguments: args, _meta: meta } = params;
            const progressToken = meta?.progressToken;
            const apifyToken = this.host.resolveApifyToken(meta) as string;
            // Injected upstream; required for long-running tasks — the task store keys on it and
            // there is no other channel to pass it.
            const mcpSessionId = meta?.mcpSessionId;
            if (!mcpSessionId) {
                log.error('MCP Session ID is missing in tool call request. This should never happen.');
                throw new Error('MCP Session ID is required for tool calls');
            }
            const startTime = Date.now();
            let toolStatus: ToolStatus = TOOL_STATUS.SUCCEEDED;
            let callDiagnostics: CallDiagnostics = {};
            let shouldTrackTelemetry = true;
            let resolvedToolName = name;
            // Set only on the pre-flight task path — the one task-mode flow whose telemetry rides
            // this handler's `finally` — so its `Tool call completed` log line keeps the taskId the
            // async path logs via finishTaskTracking.
            let preflightTaskId: string | undefined;
            // The nudge must be included in the measured result.
            let toolResult: unknown = null;
            // Keep actor context available to the outer catch.
            let actorName: string | undefined;
            let actorId: string | undefined;
            const { clientContext, actorStore } = this.host;
            const { paymentProvider, allowUnauthMode } = this.host.options;
            // Plain values pulled from the host/request, threaded into the shared engine.
            // Snapshotting the tool names here equals the pre-refactor per-call read: the tool
            // registry is only mutated during connection setup, never mid-session.
            const loadedToolNames = this.host.listToolNames();
            const { signal, sendNotification } = extra;
            const emitLog = async (msg: { level: string; data?: unknown }) =>
                this.server.sendLoggingMessage(msg as Parameters<typeof this.server.sendLoggingMessage>[0]);

            // Start with the raw name so early failures still have telemetry.
            const { telemetryData, userId } = await prepareTelemetryData({
                toolName: name,
                mcpSessionId,
                apifyToken,
                clientContext,
                telemetryEnabled: this.host.telemetryEnabled,
                transportType: this.host.options.transportType,
            });

            try {
                const prepared = await prepareToolCall({
                    apifyToken,
                    name,
                    args,
                    meta,
                    requestHeaders: extra.requestInfo?.headers,
                    isTaskRequest: Boolean(request.params.task),
                    mcpSessionId,
                    telemetryData,
                    clientContext,
                    tools: this.host.tools,
                    paymentProvider,
                    allowUnauthMode,
                    loadedToolNames,
                    signal,
                });

                if ('result' in prepared) {
                    // The engine already classified this post-resolution failure.
                    resolvedToolName = prepared.resolvedToolName;
                    args = prepared.decodedArgs;
                    toolStatus = prepared.toolStatus;
                    callDiagnostics = prepared.callDiagnostics;
                    toolResult = prepared.result;
                    return prepared.result;
                }

                if ('message' in prepared) {
                    // Reproduce v1's invalid-params tail and preserve telemetry fields.
                    resolvedToolName = prepared.resolvedToolName ?? resolvedToolName;
                    if (prepared.decodedArgs) args = prepared.decodedArgs;
                    toolStatus = prepared.toolStatus;
                    callDiagnostics = prepared.callDiagnostics;
                    log.softFail(prepared.message, {
                        mcpSessionId,
                        failureCategory: prepared.callDiagnostics.failure_category,
                        actorName: prepared.callDiagnostics.actor_name,
                        validationKeyword: prepared.callDiagnostics.validation_keyword,
                        validationPath: prepared.callDiagnostics.validation_path,
                        validationMissingProperty: prepared.callDiagnostics.validation_missing_property,
                        validationAdditionalProperty: prepared.callDiagnostics.validation_additional_property,
                        ...prepared.logFields,
                    });
                    await this.server.sendLoggingMessage({ level: 'error', data: prepared.message });
                    throw new McpError(ErrorCode.InvalidParams, prepared.message);
                }

                const { tool, toolArgs, logSafeArgs, apifyClient, standbyRejection, paymentRequiredResult } = prepared;
                actorName = prepared.actorName;
                actorId = prepared.actorId;
                resolvedToolName = getToolFullName(tool);
                // Telemetry uses the decoded arguments.
                args = prepared.decodedArgs;

                // TODO: we should split this huge method into smaller parts as it is slowly getting out of hand
                // Handle long-running task request
                if (request.params.task) {
                    const task = await this.taskStore.createTask(
                        {
                            ttl: request.params.task.ttl,
                        },
                        `call-tool-${name}-${randomUUID()}`,
                        request,
                        mcpSessionId,
                    );
                    log.debug('Created task for tool execution', {
                        taskId: task.taskId,
                        toolName: tool.name,
                        mcpSessionId,
                    });

                    // Pre-flight failure is already known — the outcome needs no work. Resolve the
                    // task synchronously: store the failure as the terminal `completed` result and emit
                    // exactly one `completed` status notification (no `updateTaskStatus('working')`, so no
                    // `working` notification). Standby rejection wins over the generic payment-required
                    // short-circuit, matching the sync path's precedence. Telemetry rides the handler's
                    // outer `finally` (shouldTrackTelemetry stays true), firing once with the sync-path
                    // properties plus the taskId on the log line.
                    const preflightResult = standbyRejection ?? paymentRequiredResult;
                    if (preflightResult) {
                        const outcome = buildPreflightFailureOutcome(
                            standbyRejection,
                            paymentRequiredResult,
                            actorName,
                            actorId,
                        );
                        toolStatus = outcome.toolStatus;
                        callDiagnostics = outcome.callDiagnostics;
                        preflightTaskId = task.taskId;
                        try {
                            await storeTaskResultOrSkipIfExpired(
                                this.taskStore,
                                tool.name,
                                task.taskId,
                                'completed',
                                outcome.result,
                                mcpSessionId,
                            );
                        } catch (error) {
                            // A store failure (not expiry) would otherwise fall through to the generic
                            // catch and return a task-less tool result the client rejects as a
                            // CreateTaskResult parse error; surface it as a protocol error instead.
                            // The pre-flight outcome left toolStatus=SOFT_FAIL, but a genuine store
                            // outage is a hard failure — correct it before throwing so the handler
                            // `finally` logs FAILED/INTERNAL_ERROR, not the stale pre-flight SOFT_FAIL.
                            toolStatus = TOOL_STATUS.FAILED;
                            callDiagnostics = {
                                failure_category: FAILURE_CATEGORY.INTERNAL_ERROR,
                                ...buildActorFields(actorName, actorId),
                            };
                            throw new McpError(
                                ErrorCode.InternalError,
                                `Failed to store the pre-flight result for task "${task.taskId}": ${
                                    error instanceof Error ? error.message : String(error)
                                }`,
                            );
                        }
                        // Defer so the client sees the CreateTaskResult (and learns the taskId) before
                        // the terminal status notification — the async path's post-response ordering.
                        // emitTaskStatusNotification never throws and no-ops if the task expired.
                        setImmediate(() => {
                            void emitTaskStatusNotification(task.taskId, mcpSessionId, this.taskStore, this.server);
                        });
                        // Measure the nudged result without changing the stored result.
                        toolResult = withReportProblemNudge({
                            result: outcome.result,
                            tools: this.host.tools,
                            failingToolName: resolvedToolName,
                            failureCategory: callDiagnostics.failure_category,
                            failureHttpStatus: callDiagnostics.failure_http_status,
                        });
                        // createTask returned status `working`; synthesize the terminal status instead of
                        // re-fetching — if the task expired before the result store (the one case
                        // storeTaskResultOrSkipIfExpired tolerates), a re-fetch would come back empty and a
                        // `working` fallback would contradict the tasks/get 404 the client sees next.
                        return { task: { ...task, status: 'completed' as const } };
                    }

                    // Execute the tool asynchronously and update task status
                    setImmediate(() => {
                        executeToolAndUpdateTask({
                            taskId: task.taskId,
                            tool,
                            toolArgs,
                            logSafeArgs,
                            apifyClient,
                            apifyToken,
                            progressToken,
                            mcpSessionId,
                            actorName,
                            actorId,
                            clientContext,
                            taskStore: this.taskStore,
                            server: this.server,
                            tools: this.host.tools,
                            actorStore,
                            paymentProvider,
                            loadedToolNames,
                            telemetryEnabled: this.host.telemetryEnabled,
                            telemetryEnv: this.host.telemetryEnv,
                            transportType: this.host.options.transportType,
                            sendNotification,
                        }).catch((error) =>
                            // Benign task-expiry is handled in-method (see the catch block and
                            // storeTaskResultOrSkipIfExpired); anything reaching here is genuinely unexpected.
                            log.error('executeToolAndUpdateTask failed unexpectedly', { taskId: task.taskId, error }),
                        );
                    });

                    // Return the task immediately; execution continues asynchronously
                    shouldTrackTelemetry = false;
                    return { task };
                }

                // Sync path: run the shared dispatch tail and project its neutral outcome by identity.
                const outcome = await executeSyncToolCall(prepared, {
                    apifyToken,
                    toolName: name,
                    mcpSessionId,
                    progressToken,
                    tools: this.host.tools,
                    actorStore,
                    paymentProvider,
                    loadedToolNames,
                    signal,
                    sendNotification,
                    emitLog,
                });
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                toolResult = outcome.result;
                return outcome.result;
            } catch (error) {
                // Match v1: classify task-creation failures, but re-throw protocol errors as JSON-RPC.
                if (error instanceof McpError) {
                    throw error;
                }
                const outcome = classifyToolCallError(error, {
                    tools: this.host.tools,
                    toolName: name,
                    failingToolName: resolvedToolName,
                    actorName,
                    actorId,
                    isAborted: Boolean(extra.signal?.aborted),
                    mcpSessionId,
                });
                toolStatus = outcome.toolStatus;
                callDiagnostics = outcome.callDiagnostics;
                toolResult = outcome.result;
                return outcome.result;
            } finally {
                if (shouldTrackTelemetry) {
                    logToolCallAndTelemetry({
                        toolName: resolvedToolName,
                        mcpSessionId,
                        toolStatus,
                        startTime,
                        telemetryData,
                        userId,
                        callDiagnostics,
                        args,
                        result: toolResult,
                        taskId: preflightTaskId,
                        telemetryEnv: this.host.telemetryEnv,
                    });
                }
            }
        });
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }

    async close(): Promise<void> {
        if (this.sigintHandler) {
            process.removeListener('SIGINT', this.sigintHandler);
            this.sigintHandler = undefined;
        }
        // Closing the server also removes its event handlers.
        await this.server.close();
    }
}
