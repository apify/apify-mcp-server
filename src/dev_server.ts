/*
 * Express server implementation used for standby Actor mode.
 *
 * Serves two MCP protocol revisions on one endpoint:
 * - stateful Streamable HTTP with sessions, per the 2025-era spec
 *   (https://modelcontextprotocol.io/specification/2025-11-25), via `@modelcontextprotocol/sdk`
 * - stateless single requests, per the 2026-07-28 revision
 *   (https://modelcontextprotocol.io/specification/2026-07-28), via the v2 SDK
 *   (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`)
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import {
    localhostHostValidation,
    localhostOriginValidation,
    toNodeHandler,
    toWebRequest,
} from '@modelcontextprotocol/node';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { InitializeRequestParams } from '@modelcontextprotocol/sdk/types.js';
import { InitializeRequestParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from './apify_client.js';
import { buildMcpClientContext } from './mcp/client_context.js';
import { ActorsMcpServer } from './mcp/server.js';
import { createStatelessServer } from './mcp/stateless_server.js';
import { resolvePaymentProvider } from './payments/index.js';
import { sanitizeMezmoMessage } from './utils/logging.js';
import { injectMcpSessionId } from './utils/mcp.js';
import { getRequestOriginForClient } from './utils/mcp_clients.js';
import { parseServerMode } from './utils/server_mode.js';

// DEV ONLY. This is a local dev/standby-emulation server, not the hosted HTTP server.
// The production Streamable HTTP transport (auth, rate limiting, Redis-backed session
// lifecycle, multi-node) lives in apify-mcp-server-internal. Do not treat this file as
// the source of HTTP-transport semantics or send PRs here to mirror production behavior;
// fix production-facing HTTP behavior in the internal repo.
//
// Default telemetry to the DEV Segment source so local tool calls never land in PROD
// analytics. Still overridable by an explicit TELEMETRY_ENV (e.g. PROD) in the env.
process.env.TELEMETRY_ENV ??= 'DEV';

/**
 * Extracts the Apify API token from the incoming request.
 *
 * Mirrors `apify-mcp-server-internal`'s `extractApiTokenFromRequest` so the
 * dev server behaves identically to production for auth/payment routing:
 *   1. `authorization: Bearer <token>` header
 *   2. `?token=<token>` query parameter
 *
 * Returns `undefined` if no valid token is present. The caller decides whether
 * a missing token is an error (no payment provider) or expected (payment mode).
 */
function extractApiTokenFromRequest(req: Request): string | undefined {
    const value = req.headers.authorization;
    if (typeof value === 'string') {
        const [schema, token] = value.trim().split(/\s+/);
        if (schema?.toLowerCase() === 'bearer' && token) return token;
    }
    try {
        const tokenFromUrl = new URL(req.url ?? '', `http://${req.headers.host}`).searchParams.get('token');
        return tokenFromUrl || undefined;
    } catch (error) {
        log.softFail('Failed to parse request URL for token extraction', {
            url: req.url,
            errMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}

/** The 401 body both eras send for a missing token, JSON-RPC-shaped like production's. */
const UNAUTHORIZED_RESPONSE_BODY = {
    jsonrpc: '2.0',
    error: {
        code: -32001,
        message:
            'Unauthorized: Apify API token is missing. Pass it as `Authorization: Bearer <token>`, or set `?payment=<provider>` to use a third-party payment provider.',
    },
    id: null,
} as const;

/**
 * Returns the resolved token for a request, or sends a 401 response.
 * In payment mode, no token is required — returns `{ apifyToken: undefined }`.
 */
function resolveRequestAuth(
    req: Request,
    res: Response,
    paymentProvider: Awaited<ReturnType<typeof resolvePaymentProvider>>,
): { apifyToken: string | undefined } | null {
    if (paymentProvider) return { apifyToken: undefined };

    const apifyToken = extractApiTokenFromRequest(req);
    if (apifyToken) return { apifyToken };

    log.softFail('Apify API token missing on unauthenticated request', { statusCode: 401 });
    res.status(401).json(UNAUTHORIZED_RESPONSE_BODY);
    return null;
}

/** The request fields era routing reads. Narrow so it can be exercised without an HTTP server. */
type EraRoutableRequest = {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
};

/**
 * Whether the 2026-07-28 stateless path must answer this request instead of the stateful one.
 * Uses the SDK's own discriminator: `true` covers claim-less traffic (2025-era `initialize` and
 * follow-ups, body-less session GET/DELETE, and unparseable bodies). `false` covers everything the
 * 2026-07-28 entry answers, including its own validation rejections, which must not be re-routed.
 */
export async function isStatelessRequest(req: EraRoutableRequest): Promise<boolean> {
    // `express.json()` already parsed the body, so nothing is read from the stream — which is what
    // lets the narrow shape above stand in for a full `IncomingMessage`.
    return !(await isLegacyRequest(await toWebRequest(req as NodeIncomingMessageLike, req.body)));
}

/**
 * Serves one 2026-07-28 request: no session id, no handshake, nothing retained afterwards.
 * URL-parameter handling is deliberately a copy of the stateful branch's, so that branch stays
 * untouched by this change.
 *
 * The missing-token 401 is resolved inside the server factory, not up front: SEP-2243 requires
 * framing rejections (400/-32020) regardless of auth state, and the SDK entry runs its validation
 * ladder before invoking the factory.
 *
 * Dev-only shape: a facade is built per request, so `?actors=` re-fetches Actor metadata every
 * time. A host may share one facade across requests instead — snapshots are per-request either way.
 */
async function serveStatelessRequest(req: Request, res: Response, taskStore: InMemoryTaskStore): Promise<void> {
    const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const telemetryEnabled =
        parseBooleanOrNull(urlParams.get('telemetry-enabled')) ??
        parseBooleanOrNull(process.env.TELEMETRY_ENABLED) ??
        true;
    const uiParam = urlParams.get('ui');
    const serverMode = uiParam !== null ? parseServerMode(uiParam) : parseServerMode(process.env.UI_MODE);
    const paymentProvider = await resolvePaymentProvider(urlParams.get('payment'));

    // No token required in payment mode, mirroring `resolveRequestAuth`.
    const apifyToken = paymentProvider ? undefined : extractApiTokenFromRequest(req);
    let unauthorized = false;

    const handler = createMcpHandler(
        async () => {
            // Reached only after the validation ladder passed (see the doc comment above).
            if (!paymentProvider && !apifyToken) {
                unauthorized = true;
                throw new Error('Apify API token missing on unauthenticated request');
            }
            const mcpServer = new ActorsMcpServer({
                taskStore,
                setupSigintHandler: false,
                transportType: 'http',
                telemetry: { enabled: telemetryEnabled },
                serverMode,
                paymentProvider,
                token: apifyToken,
            });
            // Client identity arrives per request in the `_meta` envelope (there is no initialize
            // handshake), so this fetch carries no request-origin tag.
            await mcpServer.loadToolsFromUrl(req.url, new ApifyClient({ token: apifyToken }));
            return createStatelessServer(mcpServer);
        },
        {
            legacy: 'reject',
            onerror: (error) =>
                log.softFail('Stateless MCP request rejected', { errMessage: sanitizeMezmoMessage(error.message) }),
        },
    );
    try {
        // The entry never derives `authInfo` from headers itself; pass the extracted token through
        // for handlers to read as `ctx.http.authInfo`. No OAuth client here, hence empty `clientId`.
        if (apifyToken) {
            (req as Request & { auth?: AuthInfo }).auth = { token: apifyToken, clientId: '', scopes: [] };
        }
        // The factory's throw surfaces from the entry as a 500; swap in the 401 the auth gate owns.
        await toNodeHandler({
            ...handler,
            fetch: async (request, options) => {
                const response = await handler.fetch(request, options);
                if (!unauthorized) return response;
                log.softFail('Apify API token missing on unauthenticated request', { statusCode: 401 });
                return Response.json(UNAUTHORIZED_RESPONSE_BODY, { status: 401 });
            },
        })(req, res, req.body);
    } finally {
        await handler.close();
    }
}

export function createExpressApp(): express.Express {
    const app = express();
    const mcpServers: { [sessionId: string]: ActorsMcpServer } = {};
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
    const taskStore = new InMemoryTaskStore();
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    function respondWithError(res: Response, error: unknown, logMessage: string, statusCode = 500) {
        if (statusCode >= 500) {
            // Server errors (>= 500) - log as exception
            log.exception(error instanceof Error ? error : new Error(String(error)), 'Error in request', {
                logMessage,
                statusCode,
            });
        } else {
            // Client errors (< 500) - log as softFail without stack trace
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.softFail('Error in request', { logMessage, errMessage: errorMessage, statusCode });
        }
        if (!res.headersSent) {
            res.status(statusCode).json({
                jsonrpc: '2.0',
                error: {
                    code: statusCode === 500 ? -32603 : -32000,
                    message: statusCode === 500 ? 'Internal server error' : 'Bad Request',
                },
                id: null,
            });
        }
    }

    // DNS-rebinding protection, before parsing any body: reject non-local Host headers (a rebound
    // hostname resolves here without a browser Origin) and non-local Origins. See apify/apify-mcp-server#1140.
    app.use((req, res, next) => {
        if (validateHost(req, res) && validateOrigin(req, res)) next();
    });

    // express.json() middleware to parse JSON bodies, before the POST / route.
    app.use(express.json());
    app.post('/', async (req: Request, res: Response) => {
        log.info('Received MCP request:', req.body);
        try {
            // Both protocol eras are served on this one endpoint; everything the stateless path does
            // not claim falls through to the stateful path below, unchanged.
            if (await isStatelessRequest(req)) {
                await serveStatelessRequest(req, res, taskStore);
                return;
            }

            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            const initializeMessage = extractInitializeMessage(req.body);
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
                // Reuse existing transport
                transport = transports[sessionId];
            } else if (!sessionId && initializeMessage) {
                // Extract telemetry query parameters
                const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
                const telemetryEnabledParam = urlParams.get('telemetry-enabled');
                // URL param > env var > default (true)
                const telemetryEnabled =
                    parseBooleanOrNull(telemetryEnabledParam) ??
                    parseBooleanOrNull(process.env.TELEMETRY_ENABLED) ??
                    true;

                const uiParam = urlParams.get('ui');
                const serverMode = uiParam !== null ? parseServerMode(uiParam) : parseServerMode(process.env.UI_MODE);

                // Resolve payment provider from URL parameter (e.g., ?payment=skyfire)
                const paymentProvider = await resolvePaymentProvider(urlParams.get('payment'));

                // Mirror production: no token required in payment mode, else require Bearer header
                const auth = resolveRequestAuth(req, res, paymentProvider);
                if (!auth) return;
                const { apifyToken } = auth;

                const mcpServer = new ActorsMcpServer({
                    taskStore,
                    setupSigintHandler: false,
                    transportType: 'http',
                    telemetry: {
                        enabled: telemetryEnabled,
                    },
                    serverMode,
                    paymentProvider,
                    token: apifyToken,
                });

                // Client info is already available here — unlike stdio.ts, which loads tools
                // before initialization.
                const requestOrigin = getRequestOriginForClient(
                    buildMcpClientContext(parseInitializeParams(initializeMessage.params)),
                );
                const apifyClient = new ApifyClient({ token: apifyToken, requestOrigin });
                // Fetch actor metadata and queue mode-agnostic sources. Composed with
                // the final mode inside the initialize request handler.
                await mcpServer.loadToolsFromUrl(req.url, apifyClient);

                // SDK awaits onsessioninitialized before flushing InitializeResult, so registering
                // the maps here closes the (single-process, narrow) window where a follow-up
                // request could arrive before post-handleRequest map population runs.
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: false, // Use SSE response mode
                    onsessioninitialized: (newSessionId) => {
                        transports[newSessionId] = transport;
                        mcpServers[newSessionId] = mcpServer;
                    },
                    onsessionclosed: (closedSessionId) => {
                        delete transports[closedSessionId];
                        delete mcpServers[closedSessionId];
                    },
                });

                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
                return; // Already handled
            } else if (!sessionId) {
                // Non-initialization requests without a session ID must be 400 Bad Request.
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: Mcp-Session-Id header is required',
                    },
                    id: null,
                });
                return;
            } else {
                // Invalid request - session ID is unknown.
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32001,
                        message: 'Session not found',
                    },
                    id: null,
                });
                return;
            }

            // Inject session ID into request params for the reused existing session
            if (sessionId && req.body) {
                req.body.params = injectMcpSessionId(req.body.params, sessionId);
            }

            // Handle the request with existing transport - no need to reconnect
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            respondWithError(res, error, 'Error handling MCP request');
        }
    });

    // Handle GET requests
    // Clients open this to receive server-initiated notifications (e.g. notifications/tasks/status)
    // that are not tied to a specific POST request.  Without this, session-level notifications
    // are silently dropped by the transport.
    app.get('/', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const transport = transports[sessionId || ''] as StreamableHTTPServerTransport | undefined;
        if (!transport) {
            log.softFail('Session not found for GET SSE stream', { mcpSessionId: sessionId, statusCode: 404 });
            res.status(404).send('Not Found: Session not found').end();
            return;
        }
        log.info('MCP API', {
            mth: req.method,
            rt: '/',
            mcpSessionId: sessionId,
        });
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            respondWithError(res, error, 'Error handling GET SSE stream');
        }
    });

    app.delete('/', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        const transport = transports[sessionId || ''] as StreamableHTTPServerTransport | undefined;
        if (transport) {
            log.info('MCP API', {
                mth: req.method,
                rt: '/',
                mcpSessionId: sessionId,
            });
            try {
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                respondWithError(res, error, 'Error handling DELETE request');
            }
            return;
        }

        log.softFail('Session not found', { mcpSessionId: sessionId, statusCode: 404 });
        res.status(404).send('Not Found: Session not found').end();
    });

    // Catch-all for undefined routes
    app.use((req: Request, res: Response) => {
        res.status(404)
            .json({ message: `There is nothing at route ${req.method} ${req.originalUrl}.` })
            .end();
    });

    return app;
}

/**
 * Finds the `initialize` message in a (possibly batched) request body by `method` tag alone.
 * Deliberately loose: a body with malformed `params` must still enter the initialize branch so the
 * SDK's schema validation produces the accurate protocol error instead of the generic 400.
 */
export function extractInitializeMessage(body: unknown): { method: string; params?: unknown } | undefined {
    const messages = Array.isArray(body) ? body : [body];
    return messages.find(
        (msg): msg is { method: string; params?: unknown } =>
            typeof msg === 'object' && msg !== null && (msg as { method?: unknown }).method === 'initialize',
    );
}

/**
 * Type-safe extraction of `initialize` params for `buildMcpClientContext`/request-origin.
 * Malformed params parse to `undefined` (client context stays unset) rather than being cast
 * unchecked — the SDK validates the full request separately once it takes over below.
 */
export function parseInitializeParams(params: unknown): InitializeRequestParams | undefined {
    const result = InitializeRequestParamsSchema.safeParse(params);
    return result.success ? result.data : undefined;
}

// --- Entry point: start the server when run directly ---

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const HOST = process.env.HOST ?? 'http://localhost';
    const PORT = Number(process.env.PORT) || 3001;

    const app = createExpressApp();

    app.listen(PORT, '127.0.0.1', () => {
        log.info('MCP server listening', { host: HOST, port: PORT });
    });

    process.on('SIGINT', () => {
        log.info('Received SIGINT, shutting down gracefully...');
        process.exit(0);
    });
}
