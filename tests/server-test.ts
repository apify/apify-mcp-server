import type { Server } from '@modelcontextprotocol/sdk/server.js';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { log } from '../src/logger.js';
import { ApifyMcpServer } from '../src/mcp-server.js';

describe('ApifyMcpServer initialization', () => {
    let app: express.Express;
    let server: ApifyMcpServer;
    let mcpServer: Server;
    const testPort = 7357;

    beforeEach(async () => {
        app = express();
        server = new ApifyMcpServer();
        log.setLevel(log.LEVELS.OFF);

        // Setup basic express route to trigger server initialization
        app.get('/', async (req, res) => {
            await server.processParamsAndUpdateTools(req.url);
            res.sendStatus(200);
        });

        // Start test server
        await new Promise<void>((resolve) => {
            mcpServer = app.listen(testPort, () => resolve());
        });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            mcpServer.close(() => resolve());
        });
    });

    it('should load actors from query parameters', async () => {
        // Test with multiple actors including different username cases
        const testActors = ['apify/rag-web-browser', 'apify/instagram-scraper'];

        // Make request to trigger server initialization
        const response = await fetch(`http://localhost:${testPort}/?actors=${testActors.join(',')}`);
        expect(response.status).toBe(200);

        // Verify loaded tools
        const toolNames = server.getToolNames();
        expect(toolNames).toEqual(expect.arrayContaining([
            'apify-slash-rag-web-browser',
            'apify-slash-instagram-scraper',
        ]));
        expect(toolNames.length).toBe(testActors.length);
    });

    it('should enable auto-loading tools when flag is set', async () => {
        const response = await fetch(`http://localhost:${testPort}/?enableActorAutoLoading=true`);
        expect(response.status).toBe(200);

        const toolNames = server.getToolNames();
        expect(toolNames).toEqual([
            'add-actor-to-tools',
            'remove-actor-from-tools',
        ]);
    });
});
