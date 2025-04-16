/*
 * Express server implementation used for standby Actor mode.
 */

import { randomUUID } from 'node:crypto';

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';

import { type ActorsMcpServer } from '../mcp/server.js';
import { processParamsGetTools } from '../mcp/utils.js';
import { getHelpMessage, HEADER_READINESS_PROBE, Routes } from './const.js';
import { getActorRunData } from './utils.js';

export function createExpressApp(
    host: string,
    mcpServer: ActorsMcpServer,
): express.Express {
    const app = express();
    app.use(express.json());
    let transportSSE: SSEServerTransport;
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    function respondWithError(res: Response, error: unknown, logMessage: string, statusCode = 500) {
        log.error(`${logMessage}: ${error}`);
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

    app.get(Routes.ROOT, async (req: Request, res: Response) => {
        if (req.headers && req.get(HEADER_READINESS_PROBE) !== undefined) {
            log.debug('Received readiness probe');
            res.status(200).json({ message: 'Server is ready' }).end();
            return;
        }
        try {
            log.info(`Received GET message at: ${Routes.ROOT}`);
            const tools = await processParamsGetTools(req.url, process.env.APIFY_TOKEN as string);
            if (tools) {
                mcpServer.updateTools(tools);
            }
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.status(200).json({ message: `Actor is using Model Context Protocol. ${getHelpMessage(host)}`, data: getActorRunData() }).end();
        } catch (error) {
            respondWithError(res, error, `Error in GET ${Routes.ROOT}`);
        }
    });

    app.head(Routes.ROOT, (_req: Request, res: Response) => {
        res.status(200).end();
    });

    app.get(Routes.SSE, async (req: Request, res: Response) => {
        try {
            log.info(`Received GET message at: ${Routes.SSE}`);
            const tools = await processParamsGetTools(req.url, process.env.APIFY_TOKEN as string);
            if (tools) {
                mcpServer.updateTools(tools);
            }
            transportSSE = new SSEServerTransport(Routes.MESSAGE, res);
            await mcpServer.connect(transportSSE);
        } catch (error) {
            respondWithError(res, error, `Error in GET ${Routes.SSE}`);
        }
    });

    app.post(Routes.MESSAGE, async (req: Request, res: Response) => {
        try {
            log.info(`Received POST message at: ${Routes.MESSAGE}`);
            if (transportSSE) {
                await transportSSE.handlePostMessage(req, res);
            } else {
                log.error('Server is not connected to the client.');
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: Server is not connected to the client. '
                        + 'Connect to the server with GET request to /sse endpoint',
                    },
                    id: null,
                });
            }
        } catch (error) {
            respondWithError(res, error, `Error in POST ${Routes.MESSAGE}`);
        }
    });

    app.post(Routes.MCP, async (req: Request, res: Response) => {
        log.info('Received MCP request:', req.body);
        try {
            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
            // Reuse existing transport
                transport = transports[sessionId];
            } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request - use JSON response mode
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: true, // Enable JSON response mode
                });

                // Connect the transport to the MCP server BEFORE handling the request
                await mcpServer.connect(transport);

                // After handling the request, if we get a session ID back, store the transport
                await transport.handleRequest(req, res, req.body);

                // Store the transport by session ID for future requests
                if (transport.sessionId) {
                    transports[transport.sessionId] = transport;
                }
                return; // Already handled
            } else {
            // Invalid request - no session ID or not initialization request
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided or not initialization request',
                    },
                    id: null,
                });
                return;
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

    // Catch-all for undefined routes
    app.use((req: Request, res: Response) => {
        res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}. ${getHelpMessage(host)}` }).end();
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
