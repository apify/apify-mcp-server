import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo, McpHttpHandler, Server as StatelessServer } from '@modelcontextprotocol/server';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    createMcpHandler,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';

import type { ALLOWED_TASK_TOOL_EXECUTION_MODES } from '../../../src/const.js';
import { APIFY_ERROR_TYPE_FULL_PERMISSION_NOT_APPROVED } from '../../../src/const.js';
import { ActorsMcpServer } from '../../../src/mcp/server.js';
import { createStatelessServer } from '../../../src/mcp/stateless_server.js';
import { RESOURCE_MIME_TYPE } from '../../../src/resources/widgets.js';
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
 * Reach the legacy adapter's SDK `Server` through the facade's private `legacyServer` field. The
 * v1 wiring moved off `ActorsMcpServer` into `LegacyMcpServer`; this cast keeps the reach into that
 * SDK-owned seam centralized so an SDK/structure change only needs one fix.
 */
export function getLegacyServer(server: unknown): Server {
    return (server as { legacyServer: { server: Server } }).legacyServer.server;
}

/** Reach the legacy adapter's task store through the facade's private `legacyServer` field. */
export function getTaskStore(server: unknown): TaskStore {
    return (server as { legacyServer: { taskStore: TaskStore } }).legacyServer.taskStore;
}

/**
 * Returns the real request handler the SDK registered for `method` (e.g. 'tools/call',
 * 'tasks/result'), reached through the adapter server's private `_requestHandlers` map so a test can
 * invoke it directly. Throws if the handler is not registered. This reach into an SDK-internal seam
 * is centralized here so an SDK upgrade only needs one fix.
 */
export function getRequestHandler(server: unknown, method: string): HandlerFn {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (
        getLegacyServer(server) as unknown as { _requestHandlers: Map<string, HandlerFn> }
    )._requestHandlers.get(method);
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

/** The dated protocol revision the stateless surface serves; the SDK exports no public constant for it. */
export const STATELESS_PROTOCOL_VERSION = '2026-07-28';

/** The client capability that resolves `'auto'` server mode to apps, as an `initialize` would declare it. */
const UI_CLIENT_CAPABILITIES = {
    extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

/** Client identity a stateless request declares in its own `_meta` envelope. */
export type StatelessClientIdentity = {
    name?: string;
    version?: string;
    supportsUi?: boolean;
};

export type StatelessCallOptions = {
    /** Identity for the envelope's `client-info` key; `null` omits that (optional) key entirely. */
    client?: StatelessClientIdentity | null;
    /** Extra `_meta` entries carried beside the envelope (e.g. `apifyToken`). */
    meta?: Record<string, unknown>;
    /** Auth info the serving entry receives from its caller, as the dev server's bearer passthrough sends. */
    authInfo?: AuthInfo;
};

export type StatelessResponse = {
    status: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
};

export type StatelessProbe = {
    /** The shared facade every request of this probe is served from. */
    server: ActorsMcpServer;
    /** Send one 2026-07-28 request through the SDK's serving entry and read its JSON-RPC payload. */
    call: (
        method: string,
        params?: Record<string, unknown>,
        options?: StatelessCallOptions,
    ) => Promise<StatelessResponse>;
    /** The per-request `Server` the adapter builds, for assertions on registration and capabilities. */
    buildServer: () => StatelessServer;
};

let nextStatelessRequestId = 0;

/**
 * Reads the JSON-RPC payload of a stateless response. The entry answers with a single JSON body,
 * or upgrades to SSE when the handler emitted a notification before its result — in which case the
 * payload is the last `data:` frame.
 */
export function readJsonRpcPayload(body: string): Omit<StatelessResponse, 'status'> {
    const frames = body.includes('data: ')
        ? body
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice('data: '.length))
        : [body];
    const payload = JSON.parse(frames[frames.length - 1]) as {
        result?: Record<string, unknown>;
        error?: { code: number; message: string; data?: unknown };
    };
    return { ...(payload.result && { result: payload.result }), ...(payload.error && { error: payload.error }) };
}

async function callStatelessMethod(
    handler: McpHttpHandler,
    method: string,
    params: Record<string, unknown> = {},
    options: StatelessCallOptions = {},
): Promise<StatelessResponse> {
    const { name = 'test-client', version = '1.0.0', supportsUi = false } = options.client ?? {};
    nextStatelessRequestId += 1;
    const body = {
        jsonrpc: '2.0',
        id: nextStatelessRequestId,
        method,
        params: {
            ...params,
            _meta: {
                [PROTOCOL_VERSION_META_KEY]: STATELESS_PROTOCOL_VERSION,
                ...(options.client === null ? {} : { [CLIENT_INFO_META_KEY]: { name, version } }),
                [CLIENT_CAPABILITIES_META_KEY]: supportsUi ? UI_CLIENT_CAPABILITIES : {},
                ...options.meta,
            },
        },
    };
    // The revision requires the method — and, where the body names a target, that target — in
    // headers as well; the entry refuses a request whose headers and body disagree.
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': method,
    };
    const target = params.name ?? params.uri;
    if (typeof target === 'string') headers['mcp-name'] = target;

    const response = await handler.fetch(
        new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(body) }),
        options.authInfo ? { authInfo: options.authInfo } : undefined,
    );
    return { status: response.status, ...readJsonRpcPayload(await response.text()) };
}

/**
 * Constructs a real `ActorsMcpServer` and drives 2026-07-28 requests against it through the SDK's
 * own serving entry — the same wiring the dev server and the hosted server use, so the envelope
 * lift, era validation and result projection are all exercised. Nothing leaves the process.
 */
export async function withStatelessServer<T>(
    run: (probe: StatelessProbe) => Promise<T>,
    options?: Partial<ActorsMcpServerOptions>,
): Promise<T> {
    return await withServer(async (server) => {
        const handler = createMcpHandler(() => createStatelessServer(server), { legacy: 'reject' });
        try {
            return await run({
                server,
                call: (method, params, callOptions) => callStatelessMethod(handler, method, params, callOptions),
                buildServer: () => createStatelessServer(server),
            });
        } finally {
            await handler.close();
        }
    }, options);
}

/**
 * Method names the stateless adapter registered handlers for, reached through the v2 SDK's private
 * `_requestHandlers` map. Kept here beside {@link getRequestHandler} so every reach into an
 * SDK-internal seam needs one fix on an SDK upgrade.
 */
export function listStatelessHandlerMethods(server: StatelessServer): string[] {
    // eslint-disable-next-line no-underscore-dangle
    return Array.from((server as unknown as { _requestHandlers: Map<string, unknown> })._requestHandlers.keys());
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

/** A synthetic internal tool that records the plain values the server threaded into it. */
export function makeArgsRecorderTool(name = 'recorder-tool'): {
    tool: ToolEntry;
    received: { apifyToken?: string; mcpSessionId?: string | undefined };
} {
    const received: { apifyToken?: string; mcpSessionId?: string | undefined } = {};
    const tool = {
        type: TOOL_TYPE.INTERNAL,
        name,
        description: 'records what the server passed in',
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        call: async (toolArgs: InternalToolArgs) => {
            received.apifyToken = toolArgs.apifyToken;
            received.mcpSessionId = toolArgs.mcpSessionId;
            return respondRaw({ content: [{ type: 'text', text: 'internal ok' }] });
        },
    } as ToolEntry;
    return { tool, received };
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
