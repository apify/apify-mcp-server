import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { createMcpSseClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';
import { getAvailablePort } from './utils/port.js';

let app: Express;
let httpServer: HttpServer;
let httpServerPort: number;
let httpServerHost: string;
let mcpUrl: string;

createIntegrationTestsSuite({
    suiteName: 'Apify MCP Server SSE',
    transport: 'sse',
    createClientFn: async (options) => await createMcpSseClient(mcpUrl, options),
    beforeAllFn: async () => {
        log.setLevel(log.LEVELS.OFF);

        // Get an available port
        httpServerPort = await getAvailablePort();
        httpServerHost = `http://localhost:${httpServerPort}`;
        mcpUrl = `${httpServerHost}/sse`;

        // Create an express app
        app = createExpressApp(httpServerHost);

        // Start a test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(httpServerPort, () => resolve());
        });
    },
    afterAllFn: async () => {
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    },
});
