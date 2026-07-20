import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';

import type { ALLOWED_TASK_TOOL_EXECUTION_MODES } from '../../../src/const.js';
import { APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED } from '../../../src/const.js';
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

/** HTTP status of a full-permission-not-approved error, shared by the fabricator and its pins. */
export const PERMISSION_HTTP_STATUS = 403;

/** x402 payload as the axios interceptor decodes it from the `payment-required` header. */
export const X402_PAYMENT_DATA = {
    x402Version: 1,
    accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000' }],
};

/**
 * A 402 x402 payment-required condition. Any object with `statusCode: 402` satisfies the predicate;
 * pass `paymentData` to attach the payload the production axios interceptor stores under
 * `Symbol.for('paymentRequiredData')`, so the full x402 response build is exercised. Called with no
 * argument it yields the bare 402 (no payload).
 */
export function makePaymentRequiredError(paymentData?: Record<string, unknown>): Error {
    return Object.assign(new Error('Payment required'), {
        statusCode: 402,
        ...(paymentData ? { [Symbol.for('paymentRequiredData')]: paymentData } : {}),
    });
}

/** A real full-permission-not-approved `ApifyApiError`, built against the src/const.ts type constant. */
export function makePermissionApprovalError(): ApifyApiError {
    return new ApifyApiError(
        {
            data: { error: { type: APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED, message: 'needs approval' } },
            status: PERMISSION_HTTP_STATUS,
        } as AxiosResponse,
        1,
    );
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
 * `paymentRequired`/`taskSupport` let a caller drive the pre-flight payment/task paths.
 */
export function makeRecorderTool(
    name: string,
    options: { paymentRequired?: boolean; taskSupport?: (typeof ALLOWED_TASK_TOOL_EXECUTION_MODES)[number] } = {},
): {
    tool: ToolEntry;
    received: { called: boolean; progressTracker: InternalToolArgs['progressTracker'] | undefined };
} {
    const { paymentRequired = false, taskSupport } = options;
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
        paymentRequired,
        annotations: {},
        ...(taskSupport ? { execution: { taskSupport } } : {}),
        call: async (toolArgs: InternalToolArgs) => {
            received.called = true;
            received.progressTracker = toolArgs.progressTracker;
            return respondRaw({ content: [{ type: 'text', text: 'ok' }] });
        },
    } as ToolEntry;
    return { tool, received };
}
