/*
 * Express server implementation used for standby Actor mode.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from './apify_client.js';
import { ActorsMcpServer } from './mcp/server.js';
import { resolvePaymentProvider } from './payments/index.js';
import { injectMcpSessionId } from './utils/mcp.js';
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
    res.status(401).json({
        jsonrpc: '2.0',
        error: {
            code: -32001,
            message:
                'Unauthorized: Apify API token is missing. Pass it as `Authorization: Bearer <token>`, or set `?payment=<provider>` to use a third-party payment provider.',
        },
        id: null,
    });
    return null;
}

export function createExpressApp(): express.Express {
    const app = express();
    const mcpServers: { [sessionId: string]: ActorsMcpServer } = {};
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
    const taskStore = new InMemoryTaskStore();

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

    // express.json() middleware to parse JSON bodies, before the POST / route.
    app.use(express.json());
    app.post('/', async (req: Request, res: Response) => {
        log.info('Received MCP request:', req.body);
        try {
            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
                // Reuse existing transport
                transport = transports[sessionId];
            } else if (!sessionId && isInitializeRequest(req.body)) {
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

                const apifyClient = new ApifyClient({ token: apifyToken });
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

// Helper function to detect initialize requests
function isInitializeRequest(body: unknown): boolean {
    if (Array.isArray(body)) {
        return body.some(
            (msg) => typeof msg === 'object' && msg !== null && 'method' in msg && msg.method === 'initialize',
        );
    }
    return typeof body === 'object' && body !== null && 'method' in body && body.method === 'initialize';
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
