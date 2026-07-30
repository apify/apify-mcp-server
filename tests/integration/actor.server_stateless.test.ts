import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';

import log from '@apify/log';

import { createExpressApp } from '../../src/dev_server.js';
import { createMcpStatelessClient } from '../helpers.js';
import { createIntegrationTestsSuite } from './suite.js';
import { getAvailablePort } from './utils/port.js';

let app: Express;
let httpServer: HttpServer;
let httpServerPort: number;
let mcpUrl: string;

createIntegrationTestsSuite({
    suiteName: 'Apify MCP Server 2026-07-28 stateless HTTP',
    transport: '2026-07-28',
    createClientFn: async (options) => await createMcpStatelessClient(mcpUrl, options),
    beforeAllFn: async () => {
        log.setLevel(log.LEVELS.OFF);

        // Get an available port
        httpServerPort = await getAvailablePort();
        mcpUrl = `http://localhost:${httpServerPort}`;

        // Create an express app
        app = createExpressApp();

        // Start a test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(httpServerPort, '127.0.0.1', () => resolve());
        });

        // `mode: 'auto'` falls back to the legacy `initialize` handshake when it finds no modern
        // server, which would let this whole dimension pass while exercising 2025-era code.
        // getDiscoverResult() is undefined on that legacy verdict, defined on a modern one.
        const negotiationProbeClient = await createMcpStatelessClient(mcpUrl);
        const discoverResult = negotiationProbeClient.getDiscoverResult();
        await negotiationProbeClient.close();
        if (!discoverResult) {
            throw new Error('Client negotiated the legacy era — this dimension would not exercise 2026-07-28.');
        }
    },
    afterAllFn: async () => {
        // closeAllConnections first — lingering long-poll requests (default waitSecs=30) keep
        // the keep-alive sockets open and block server.close() past vitest's 10s hookTimeout.
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    },
});
