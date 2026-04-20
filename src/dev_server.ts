/*
 * Express server implementation used for standby Actor mode.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { InitializeRequest, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';
import { parseBooleanOrNull } from '@apify/utilities';

import { ApifyClient } from './apify_client.js';
import { ActorsMcpServer } from './mcp/server.js';
import { processParamsGetTools } from './mcp/utils.js';
import { resolvePaymentProvider } from './payments/index.js';
import type { ApifyRequestParams } from './types.js';
import { parseServerMode } from './types.js';

enum TransportType {
    HTTP = 'HTTP',
    SSE = 'SSE',
}

enum Routes {
    MCP = '/',
    SSE = '/sse',
    MESSAGE = '/message',
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

            const mcpServer = new ActorsMcpServer({
                taskStore,
                setupSigintHandler: false,
                transportType: 'sse',
                telemetry: {
                    enabled: telemetryEnabled,
                },
                serverMode,
                paymentProvider,
            });
            const transport = new SSEServerTransport(Routes.MESSAGE, res);

            // Generate a unique session ID for this SSE connection
            const mcpSessionId = transport.sessionId;

            // Defer tool loading until `prepareForInitialize` finalizes `serverMode`.
            const apifyToken = process.env.APIFY_TOKEN as string;
            log.debug('Deferring tool load until initialize', { mcpSessionId: transport.sessionId, tr: TransportType.SSE });
            const apifyClient = new ApifyClient({ token: apifyToken });
            mcpServer.setDeferredToolsLoader(
                async () => processParamsGetTools(req.url, apifyClient, mcpServer.serverMode),
            );

            transportsSSE[transport.sessionId] = transport;
            mcpServers[transport.sessionId] = mcpServer;

            // Connect first; then wrap `transport.onmessage` so we can AWAIT
            // `prepareForInitialize` before the SDK dispatches `initialize`. This lets
            // clients that ignore `notifications/tools/list_changed` still see the
            // correct tool set on the first `tools/list` response.
            await mcpServer.connect(transport);

            const sdkOnMessage = transport.onmessage as ((msg: JSONRPCMessage, extra?: unknown) => void) | undefined;
            const handleMessage = async (message: JSONRPCMessage, extra?: unknown) => {
                const msgRecord = message as Record<string, unknown>;
                if (msgRecord.method === 'initialize') {
                    await mcpServer.prepareForInitialize(msgRecord as unknown as InitializeRequest);
                }
                if (msgRecord.params) {
                    const params = msgRecord.params as ApifyRequestParams;
                    params._meta ??= {};
                    params._meta.mcpSessionId = mcpSessionId;
                }
                sdkOnMessage?.(message, extra);
            };
            transport.onmessage = (message, extra) => {
                // Catch rejections so tool-loader network errors surface instead of
                // producing an unhandled promise rejection + hung client.
                handleMessage(message, extra).catch(async (error) => {
                    log.error('Failed to handle SSE transport message', { mcpSessionId, error });
                    try { await transport.close(); } catch { /* already closed */ }
                });
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
                // New initialization request. JSON-RPC batches are technically allowed:
                // extract the actual initialize message so capability detection and
                // telemetry don't silently fall back to undefined on an array body.
                const initMsg = Array.isArray(req.body)
                    ? (req.body as Record<string, unknown>[]).find((m) => m?.method === 'initialize') as InitializeRequest
                    : req.body as InitializeRequest;

                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: false, // Use SSE response mode
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

                const mcpServer = new ActorsMcpServer({
                    taskStore,
                    setupSigintHandler: false,
                    initializeRequestData: initMsg,
                    transportType: 'http',
                    telemetry: {
                        enabled: telemetryEnabled,
                    },
                    serverMode,
                    paymentProvider,
                });

                // Defer tool loading; `prepareForInitialize` runs it after finalizing
                // `serverMode` from the initialize request's capabilities.
                const apifyToken = process.env.APIFY_TOKEN as string;
                log.debug('Deferring tool load until initialize', { tr: TransportType.HTTP });
                const apifyClient = new ApifyClient({ token: apifyToken });
                mcpServer.setDeferredToolsLoader(
                    async () => processParamsGetTools(req.url, apifyClient, mcpServer.serverMode),
                );

                // Finalize mode + load tools BEFORE the transport dispatches the initialize
                // request, so the InitializeResult and first `tools/list` reflect the
                // resolved mode even for clients that ignore
                // `notifications/tools/list_changed`.
                await mcpServer.prepareForInitialize(initMsg);

                // Connect the transport to the MCP server BEFORE handling the request
                await mcpServer.connect(transport);

                // After handling the request, if we get a session ID back, store the transport
                await transport.handleRequest(req, res, req.body);

                // Store the transport by session ID for future requests
                if (transport.sessionId) {
                    transports[transport.sessionId] = transport;
                    mcpServers[transport.sessionId] = mcpServer;
                }
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

    // Handle GET requests for SSE streams according to spec
    app.get(Routes.MCP, async (_req: Request, res: Response) => {
        // We don't support GET requests for this server
        // The spec requires returning 405 Method Not Allowed in this case
        res.status(405).set('Allow', 'POST').send('Method Not Allowed');
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
    if (!process.env.APIFY_TOKEN) {
        log.error('APIFY_TOKEN is required but not set in the environment variables.');
        process.exit(1);
    }

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
