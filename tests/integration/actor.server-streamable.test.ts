import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { createMcpStreamableClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

let app: Express;
let mcpServer: ActorsMcpServer;
let httpServer: HttpServer;
const httpServerPort = 50001;
const httpServerHost = `http://localhost:${httpServerPort}`;
const mcpUrl = `${httpServerHost}/mcp`;

createIntegrationTestsSuite({
    suiteName: 'Actors MCP Server Streamable HTTP',
    getActorsMcpServer: () => mcpServer,
    createClientFn: async (options) => await createMcpStreamableClient(mcpUrl, options),
    beforeAllFn: async () => {
        log.setLevel(log.LEVELS.OFF);
        // Create express app using the proper server setup
        mcpServer = new ActorsMcpServer({ enableAddingActors: false });
        app = createExpressApp(httpServerHost, mcpServer);

        // Start test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(httpServerPort, () => resolve());
        });
    },
    beforeEachFn: async () => {
        mcpServer.disableDynamicActorTools();
        await mcpServer.reset();
    },
    afterAllFn: async () => {
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    },
});
