import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

import type { ALLOWED_TASK_TOOL_EXECUTION_MODES } from '../../../src/const.js';
import { ActorsMcpServer } from '../../../src/mcp/server.js';
import type { ActorsMcpServerOptions, InternalToolArgs, ToolEntry, ToolInputSchema } from '../../../src/types.js';
import { TOOL_TYPE } from '../../../src/types.js';
import { compileSchema } from '../../../src/utils/ajv.js';
import { respondRaw } from '../../../src/utils/mcp.js';

/**
 * Signature of an SDK request handler reached via the private `_requestHandlers` map. The
 * `mcp.server.*` tests drive these handlers directly (no transport, no `server.request()`).
 */
export type HandlerFn = (
    req: Record<string, unknown>,
    extra: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Returns the real request handler the SDK registered for `method` (e.g. 'tools/call',
 * 'tasks/result'), reached through the server's private `_requestHandlers` map so a test can invoke
 * it directly. Throws if the handler is not registered. This reach into an SDK-internal seam is
 * centralized here so an SDK upgrade only needs one fix.
 */
export function getRequestHandler(server: unknown, method: string): HandlerFn {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (server as { server: { _requestHandlers: Map<string, HandlerFn> } }).server._requestHandlers.get(
        method,
    );
    if (!handler) throw new Error(`Handler "${method}" not registered`);
    return handler;
}

/**
 * Constructs a real `ActorsMcpServer` backed by an `InMemoryTaskStore`, runs `run` against it, and
 * always closes it. Defaults match the existing `mcp.server.*` tests (telemetry off, placeholder
 * token); pass `options` to override (e.g. telemetry on with no token for the shape tests).
 */
export async function withServer<T>(
    run: (server: ActorsMcpServer) => Promise<T>,
    options?: Partial<ActorsMcpServerOptions>,
): Promise<T> {
    const server = new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        telemetry: { enabled: false },
        token: 'fake-token',
        ...options,
    });
    try {
        return await run(server);
    } finally {
        await server.close();
    }
}

/**
 * A synthetic internal tool whose `call` throws `error` (default: a plain `Error('boom')`), so
 * dispatch falls through to the outer catch. An empty input schema validates against `{}`. Set
 * `taskSupport` to make the tool eligible for the task path (it otherwise fails the pre-dispatch gate).
 */
export function makeThrowingTool(
    options: { name?: string; error?: unknown; taskSupport?: (typeof ALLOWED_TASK_TOOL_EXECUTION_MODES)[number] } = {},
): ToolEntry {
    const { name = 'test-throwing-tool', error = new Error('boom'), taskSupport } = options;
    return {
        type: TOOL_TYPE.INTERNAL,
        name,
        description: 'throws',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        ...(taskSupport ? { execution: { taskSupport } } : {}),
        call: async (_toolArgs: InternalToolArgs) => {
            throw error;
        },
    };
}

/**
 * A synthetic internal tool that records what the server passed into `call` (whether it ran, and the
 * `progressTracker` it received). Generalizes to any "did the server pass X to the tool?" assertion.
 */
export function makeRecorderTool(name: string): {
    tool: ToolEntry;
    received: { called: boolean; progressTracker: InternalToolArgs['progressTracker'] | undefined };
} {
    const received: { called: boolean; progressTracker: InternalToolArgs['progressTracker'] | undefined } = {
        called: false,
        progressTracker: undefined,
    };
    const tool: ToolEntry = {
        type: TOOL_TYPE.INTERNAL,
        name,
        description: 'recorder tool for progress wiring tests',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        ajvValidate: Object.assign(() => true, { errors: null }) as unknown as ToolEntry['ajvValidate'],
        paymentRequired: false,
        annotations: {},
        call: async (toolArgs: InternalToolArgs) => {
            received.called = true;
            received.progressTracker = toolArgs.progressTracker;
            return respondRaw({ content: [{ type: 'text', text: 'ok' }] });
        },
    } as ToolEntry;
    return { tool, received };
}
