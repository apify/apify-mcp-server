import type { Server as HttpServer } from 'node:http';

import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { createExpressApp } from '../src/actor/server.js';
import { HelperTools } from '../src/const.js';
import { ActorsMcpServer } from '../src/mcp/server.js';

describe('ApifyMcpServer initialization', () => {
    let app: Express;
    let server: ActorsMcpServer;
    let httpServer: HttpServer;
    const testPort = 7357;
    const testHost = `http://localhost:${testPort}`;

    beforeEach(async () => {
        server = new ActorsMcpServer();
        log.setLevel(log.LEVELS.OFF);

        // Create express app using the proper server setup
        app = createExpressApp(testHost, server);

        // Start test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(testPort, () => resolve());
        });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    });

    it('should load actors from query parameters', async () => {
        // Test with multiple actors including different username cases
        const testActors = ['apify/rag-web-browser', 'apify/instagram-scraper'];
        const numberOfHelperTools = 2;

        // Make request to trigger server initialization
        const response = await fetch(`${testHost}/?actors=${testActors.join(',')}`);
        expect(response.status).toBe(200);

        // Verify loaded tools
        const toolNames = server.getToolNames();
        expect(toolNames).toEqual(expect.arrayContaining([
            'apify-slash-rag-web-browser',
            'apify-slash-instagram-scraper',
        ]));
        expect(toolNames.length).toBe(testActors.length + numberOfHelperTools);
    });

    it('should enable auto-loading tools when flag is set', async () => {
        const response = await fetch(`${testHost}/?enableActorAutoLoading=true`);
        expect(response.status).toBe(200);

        const toolNames = server.getToolNames();
        expect(toolNames).toEqual([
            HelperTools.SEARCH_ACTORS,
            HelperTools.GET_ACTOR_DETAILS,
            HelperTools.ADD_ACTOR,
            HelperTools.REMOVE_ACTOR,
        ]);
    });
});
