import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Request, Response } from 'express';
import express from 'express';

import { HEADER_READINESS_PROBE, Routes } from './const.js';
import { log } from './logger.js';
import { type ApifyMcpServer, processParamsAndUpdateTools } from './mcp-server.js';

export function createServerApp(host: string,
    mcpServer: ApifyMcpServer,
    additionalData?: object): express.Express {
    const HELP_MESSAGE = `Connect to the server with GET request to ${host}/sse?token=YOUR-APIFY-TOKEN`
        + ` and then send POST requests to ${host}/message?token=YOUR-APIFY-TOKEN`;

    const app = express();

    let transport: SSEServerTransport;

    app.route(Routes.ROOT)
        .get(async (req: Request, res: Response) => {
            if (req.headers && req.get(HEADER_READINESS_PROBE) !== undefined) {
                log.debug('Received readiness probe');
                res.status(200).json({ message: 'Server is ready' }).end();
                return;
            }
            try {
                log.info(`Received GET message at: ${Routes.ROOT}`);
                await processParamsAndUpdateTools(req.url, mcpServer);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.status(200).json({ message: `Actor is using Model Context Protocol. ${HELP_MESSAGE}`, data: additionalData }).end();
            } catch (error) {
                log.error(`Error in GET ${Routes.ROOT} ${error}`);
                res.status(500).json({ message: 'Internal Server Error' }).end();
            }
        })
        .head((_req: Request, res: Response) => {
            res.status(200).end();
        });

    app.route(Routes.SSE)
        .get(async (req: Request, res: Response) => {
            try {
                log.info(`Received GET message at: ${Routes.SSE}`);
                await processParamsAndUpdateTools(req.url, mcpServer);
                transport = new SSEServerTransport(Routes.MESSAGE, res);
                await mcpServer.connect(transport);
            } catch (error) {
                log.error(`Error in GET ${Routes.SSE}: ${error}`);
                res.status(500).json({ message: 'Internal Server Error' }).end();
            }
        });

    app.route(Routes.MESSAGE)
        .post(async (req: Request, res: Response) => {
            try {
                log.info(`Received POST message at: ${Routes.MESSAGE}`);
                if (transport) {
                    await transport.handlePostMessage(req, res);
                } else {
                    res.status(400).json({
                        message: 'Server is not connected to the client. '
                            + 'Connect to the server with GET request to /sse endpoint',
                    });
                }
            } catch (error) {
                log.error(`Error in POST ${Routes.MESSAGE}: ${error}`);
                res.status(500).json({ message: 'Internal Server Error' }).end();
            }
        });

    // Catch-all for undefined routes
    app.use((req: Request, res: Response) => {
        res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}. ${HELP_MESSAGE}` }).end();
    });

    return app;
}
