/*
 * Express server implementation used for standby Actor mode.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from './apify_client.js';
import { ActorsMcpServer } from './mcp/server.js';
import { resolvePaymentProvider } from './payments/index.js';
import type { ApifyRequestParams } from './types.js';
import { parseServerMode } from './utils/server_mode.js';

enum TransportType {
    HTTP = 'HTTP',
    SSE = 'SSE',
}

enum Routes {
    MCP = '/',
    SSE = '/sse',
    MESSAGE = '/message',
}

/**
 * Extracts the Apify API token from the incoming request.
 *
 * Mirrors `apify-mcp-server-internal`'s `extractApiTokenFromRequest` so the
 * dev server behaves identically to production for auth/payment routing:
 *   1. `x-apify-authorization: Bearer <token>` header (preferred)
 *   2. `authorization: Bearer <token>` header
 *   3. `?token=<token>` query parameter
 *
 * Returns `undefined` if no valid token is present. The caller decides whether
 * a missing token is an error (no payment provider) or expected (payment mode).
 */
function extractApiTokenFromRequest(req: Request): string | undefined {
    for (const header of ['x-apify-authorization', 'authorization']) {
        const value = req.headers[header];
        if (typeof value !== 'string') continue;
        const [schema, token] = value.trim().split(/\s+/);
        if (schema?.toLowerCase() === 'bearer' && token) return token;
    }
    try {
        const tokenFromUrl = new URL(req.url ?? '', `http://${req.headers.host}`).searchParams.get('token');
        return tokenFromUrl || undefined;
    } catch (error) {
        log.softFail('Failed to parse request URL for token extraction', { url: req.url, error });
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
            message: 'Unauthorized: Apify API token is missing. Pass it as `Authorization: Bearer <token>`, or set `?payment=<provider>` to use a third-party payment provider.',
        },
        id: null,
    });
    return null;
}

export function createExpressApp(): express.Express {
    const app = express();
    const mcpServers: { [sessionId: string]: ActorsMcpServer } = {};
    const transportsSSE: { [sessionId: string]: SSEServerTransport } = {};
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
    const taskStore = new InMemoryTaskStore();

    function respondWithError(res: Response, error: unknown, logMessage: string, statusCode = 500) {
        if (statusCode >= 500) {
            // Server errors (>= 500) - log as exception
            log.exception(error instanceof Error ? error : new Error(String(error)), 'Error in request', { logMessage, statusCode });
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

    app.get(Routes.SSE, async (req: Request, res: Response) => {
        try {
            log.info('MCP API', {
                mth: req.method,
                rt: Routes.SSE,
                tr: TransportType.SSE,
            });
            // Extract telemetry query parameters
            const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
            const telemetryEnabledParam = urlParams.get('telemetry-enabled');
            // URL param > env var > default (true)
            const telemetryEnabled = parseBooleanOrNull(telemetryEnabledParam)
                ?? parseBooleanOrNull(process.env.TELEMETRY_ENABLED)
                ?? true;

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
                transportType: 'sse',
                telemetry: {
                    enabled: telemetryEnabled,
                },
                serverMode,
                paymentProvider,
                token: apifyToken,
            });
            const transport = new SSEServerTransport(Routes.MESSAGE, res);

            // Generate a unique session ID for this SSE connection
            const mcpSessionId = transport.sessionId;

            const apifyClient = new ApifyClient({ token: apifyToken });
            // Fetch actor metadata and queue mode-agnostic sources. Composed with
            // the final mode inside the initialize request handler.
            await mcpServer.loadToolsFromUrl(req.url, apifyClient);

            transportsSSE[transport.sessionId] = transport;
            mcpServers[transport.sessionId] = mcpServer;

            await mcpServer.connect(transport);

            const sdkOnMessage = transport.onmessage as ((msg: JSONRPCMessage, extra?: unknown) => void) | undefined;
            transport.onmessage = (message, extra) => {
                const msgRecord = message as Record<string, unknown>;
                if (!msgRecord.params || typeof msgRecord.params !== 'object' || Array.isArray(msgRecord.params)) {
                    msgRecord.params = {};
                }
                const params = msgRecord.params as ApifyRequestParams;
                params._meta ??= {};
                params._meta.mcpSessionId = mcpSessionId;
                sdkOnMessage?.(message, extra);
            };

            res.on('close', () => {
                log.info('Connection closed, cleaning up', {
                    mcpSessionId: transport.sessionId,
                });
                delete transportsSSE[transport.sessionId];
                delete mcpServers[transport.sessionId];
            });
        } catch (error) {
            respondWithError(res, error, `Error in GET ${Routes.SSE}`);
        }
    });

    app.post(Routes.MESSAGE, async (req: Request, res: Response) => {
        try {
            log.info('MCP API', {
                mth: req.method,
                rt: Routes.MESSAGE,
                tr: TransportType.HTTP,
            });
            const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('sessionId');
            if (!sessionId) {
                log.softFail('No session ID provided in POST request', { statusCode: 400 });
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No session ID provided',
                    },
                    id: null,
                });
                return;
            }
            const transport = transportsSSE[sessionId];
            if (transport) {
                await transport.handlePostMessage(req, res);
            } else {
                log.softFail('Server is not connected to the client.', { statusCode: 404 });
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Not Found: Server is not connected to the client. '
                        + 'Connect to the server with GET request to /sse endpoint',
                    },
                    id: null,
                });
            }
        } catch (error) {
            respondWithError(res, error, `Error in POST ${Routes.MESSAGE}`);
        }
    });

    // express.json() middleware to parse JSON bodies.
    // It must be used before the POST / route but after the GET /sse route :shrug:
    app.use(express.json());
    app.post(Routes.MCP, async (req: Request, res: Response) => {
        log.info('Received MCP request:', req.body);
        try {
            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
                // Reuse existing transport
                transport = transports[sessionId];
                // Inject session ID into request params for existing sessions
                if (req.body?.params) {
                    req.body.params._meta ??= {};
                    req.body.params._meta.mcpSessionId = sessionId;
                }
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // Extract telemetry query parameters
                const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
                const telemetryEnabledParam = urlParams.get('telemetry-enabled');
                // URL param > env var > default (true)
                const telemetryEnabled = parseBooleanOrNull(telemetryEnabledParam)
                    ?? parseBooleanOrNull(process.env.TELEMETRY_ENABLED)
                    ?? true;

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
                });

                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
                return; // Already handled
            } else {
                // Invalid request - no session ID or not initialization request
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Not Found: No valid session ID provided or not initialization request',
                    },
                    id: null,
                });
                return;
            }

            // Inject session ID into request params for all requests
            if (req.body?.params && sessionId) {
                req.body.params._meta ??= {};
                req.body.params._meta.mcpSessionId = sessionId;
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
    app.get(Routes.MCP, async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const transport = transports[sessionId || ''] as StreamableHTTPServerTransport | undefined;
        if (!transport) {
            log.softFail('Session not found for GET SSE stream', { mcpSessionId: sessionId, statusCode: 404 });
            res.status(404).send('Not Found: Session not found').end();
            return;
        }
        log.info('MCP API', {
            mth: req.method,
            rt: Routes.MCP,
            tr: TransportType.HTTP,
            mcpSessionId: sessionId,
        });
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            respondWithError(res, error, 'Error handling GET SSE stream');
        }
    });

    app.delete(Routes.MCP, async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        const transport = transports[sessionId || ''] as StreamableHTTPServerTransport | undefined;
        if (transport) {
            log.info('MCP API', {
                mth: req.method,
                rt: Routes.MESSAGE,
                tr: TransportType.HTTP,
                mcpSessionId: sessionId,
            });
            await transport.handleRequest(req, res, req.body);
            return;
        }

        log.softFail('Session not found', { mcpSessionId: sessionId, statusCode: 404 });
        res.status(404).send('Not Found: Session not found').end();
    });

    // Catch-all for undefined routes
    app.use((req: Request, res: Response) => {
        res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}.` }).end();
    });

    return app;
}

// Helper function to detect initialize requests
function isInitializeRequest(body: unknown): boolean {
    if (Array.isArray(body)) {
        return body.some((msg) => typeof msg === 'object' && msg !== null && 'method' in msg && msg.method === 'initialize');
    }
    return typeof body === 'object' && body !== null && 'method' in body && body.method === 'initialize';
}

// --- Entry point: start the server when run directly ---

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const HOST = process.env.HOST ?? 'http://localhost';
    const PORT = Number(process.env.PORT ?? 3001);

    const app = createExpressApp();

    app.listen(PORT, '127.0.0.1', () => {
        log.info('MCP server listening', { host: HOST, port: PORT });
    });

    process.on('SIGINT', () => {
        log.info('Received SIGINT, shutting down gracefully...');
        process.exit(0);
    });
}
