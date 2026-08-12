import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/dev_server.js';
import { createMcpStreamableClient } from '../test_kit/index.js';
import { createIntegrationTestsSuite } from './suite.js';
import { getAvailablePort } from './utils/port.js';

let app: Express;
let httpServer: HttpServer;
let httpServerPort: number;
let httpServerHost: string;
let mcpUrl: string;

createIntegrationTestsSuite({
    suiteName: 'Apify MCP Server Streamable HTTP',
    transport: '2025-11-25',
    createClientFn: async (options) => await createMcpStreamableClient(mcpUrl, options),
    beforeAllFn: async () => {
        log.setLevel(log.LEVELS.OFF);

        // Get an available port
        httpServerPort = await getAvailablePort();
        httpServerHost = `http://localhost:${httpServerPort}`;
        mcpUrl = httpServerHost;

        // Create an express app
        app = createExpressApp();

        // Start a test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(httpServerPort, '127.0.0.1', () => resolve());
        });
    },
    afterAllFn: async () => {
        // Drain long-poll keep-alives before close (waitSecs default 30).
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    },
});
