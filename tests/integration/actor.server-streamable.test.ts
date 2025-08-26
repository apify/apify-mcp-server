import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { createMcpStreamableClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

let app: Express;
let httpServer: HttpServer;
const httpServerPort = 50001;
const httpServerHost = `http://localhost:${httpServerPort}`;
const mcpUrl = `${httpServerHost}/mcp`;

createIntegrationTestsSuite({
    suiteName: 'Apify MCP Server Streamable HTTP',
    transport: 'streamable-http',
    createClientFn: async (options) => await createMcpStreamableClient(mcpUrl, options),
    beforeAllFn: async () => {
        log.setLevel(log.LEVELS.OFF);

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
