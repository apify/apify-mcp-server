import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { createMcpSseClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

let app: Express;
let mcpServer: ActorsMcpServer;
let httpServer: HttpServer;
const httpServerPort = 50000;
const httpServerHost = `http://localhost:${httpServerPort}`;
const mcpUrl = `${httpServerHost}/sse`;

createIntegrationTestsSuite({
    suiteName: 'Actors MCP Server SSE',
    getActorsMcpServer: () => mcpServer,
    createClientFn: async (options) => await createMcpSseClient(mcpUrl, options),
    beforeAllFn: async () => {
        mcpServer = new ActorsMcpServer({ enableAddingActors: false });
        log.setLevel(log.LEVELS.OFF);

        // Create an express app using the proper server setup
        app = createExpressApp(httpServerHost, mcpServer);

        // Start a test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(httpServerPort, () => resolve());
        });
    },
    beforeEachFn: async () => {
        mcpServer.disableDynamicActorTools();
        await mcpServer.reset();
    },
    afterAllFn: async () => {
        await mcpServer.close();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    },
});
