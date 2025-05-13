import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { createMCPStreamableClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';

let app: Express;
let mcpServer: ActorsMcpServer;
let httpServer: HttpServer;
const httpServerPort = 50001;
const httpServerHost = `http://localhost:${httpServerPort}`;
const mcpUrl = `${httpServerHost}/mcp`;

createIntegrationTestsSuite({
    suiteName: 'Actors MCP Server Streamable HTTP',
    concurrent: false,
    getActorsMCPServer: () => mcpServer,
    createClientFn: async (options) => await createMCPStreamableClient(mcpUrl, options),
    beforeAllFn: async () => {
        mcpServer = new ActorsMcpServer({
            enableDefaultActors: false,
        });
        log.setLevel(log.LEVELS.OFF);

        // Create express app using the proper server setup
        app = createExpressApp(httpServerHost, mcpServer);

        // Start test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(httpServerPort, () => resolve());
        });
    },
    beforeEachFn: async () => {
        await mcpServer.reset();
    },
    afterAllFn: async () => {
        await mcpServer.close();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    },
});
