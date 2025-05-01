import type { Server as HttpServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { defaults, HelperTools } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { actorNameToToolName } from '../../src/tools/utils.js';

async function createMCPClient(
    serverUrl: string,
    options?: {
        actors?: string[];
        enableAddingActors?: boolean;
    },
): Promise<Client> {
    if (!process.env.APIFY_TOKEN) {
        throw new Error('APIFY_TOKEN environment variable is not set.');
    }
    const url = new URL(serverUrl);
    const { actors, enableAddingActors } = options || {};
    if (actors) {
        url.searchParams.append('actors', actors.join(','));
    }
    if (enableAddingActors) {
        url.searchParams.append('enableAddingActors', 'true');
    }

    const transport = new SSEClientTransport(
        url,
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                },
            },
            eventSourceInit: {
                // The EventSource package augments EventSourceInit with a "fetch" parameter.
                // You can use this to set additional headers on the outgoing request.
                // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                async fetch(input: Request | URL | string, init?: RequestInit) {
                    const headers = new Headers(init?.headers || {});
                    headers.set('authorization', `Bearer ${process.env.APIFY_TOKEN}`);
                    return fetch(input, { ...init, headers });
                },
            // We have to cast to "any" to use it, since it's non-standard
            } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        },
    );

    const client = new Client({
        name: 'sse-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

describe('Actors MCP Server', {
    concurrent: false, // Run test serially to prevent port already in use
}, () => {
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

    it('default tools list', async () => {
        const client = await createMCPClient(`${testHost}/sse`);

        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + defaults.actors.length);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        for (const actorTool of defaults.actors) {
            expect(names).toContain(actorNameToToolName(actorTool));
        }

        await client.close();
    });

    it('use only specific Actor and call it', async () => {
        const actorName = 'apify/python-example';
        const selectedToolName = actorNameToToolName(actorName);
        const client = await createMCPClient(`${testHost}/sse`, {
            actors: [actorName],
            enableAddingActors: false,
        });

        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + 1);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        expect(names).toContain(selectedToolName);

        const result = await client.callTool({
            name: selectedToolName,
            arguments: {
                first_number: 1,
                second_number: 2,
            },
        });

        expect(result).toEqual({
            content: [{
                text: JSON.stringify({
                    first_number: 1,
                    second_number: 2,
                    sum: 3,
                }),
                type: 'text',
            }],
        });

        await client.close();
    });

    it('load Actors from parameters via SSE client', async () => {
        const actors = ['apify/rag-web-browser', 'apify/instagram-scraper'];
        const client = await createMCPClient(`${testHost}/sse`, {
            actors,
            enableAddingActors: false,
        });

        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + actors.length);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        for (const actor of actors) {
            expect(names).toContain(actorNameToToolName(actor));
        }

        await client.close();
    });

    it('load Actor dynamically and call it', async () => {
        const actor = 'apify/python-example';
        const selectedToolName = actorNameToToolName(actor);
        const client = await createMCPClient(`${testHost}/sse`, {
            enableAddingActors: true,
        });

        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names.length).toEqual(defaults.helperTools.length + defaults.actorAddingTools.length + defaults.actors.length);
        for (const tool of defaults.helperTools) {
            expect(names).toContain(tool);
        }
        for (const tool of defaults.actorAddingTools) {
            expect(names).toContain(tool);
        }
        for (const actorTool of defaults.actors) {
            expect(names).toContain(actorNameToToolName(actorTool));
        }

        // Add Actor dynamically
        await client.callTool({
            name: HelperTools.ADD_ACTOR,
            arguments: {
                actorName: actor,
            },
        });

        // Check if tools was added
        const toolsAfterAdd = await client.listTools();
        const namesAfterAdd = toolsAfterAdd.tools.map((tool) => tool.name);
        expect(namesAfterAdd.length).toEqual(defaults.helperTools.length + defaults.actorAddingTools.length + defaults.actors.length + 1);
        expect(namesAfterAdd).toContain(selectedToolName);

        const result = await client.callTool({
            name: selectedToolName,
            arguments: {
                first_number: 1,
                second_number: 2,
            },
        });

        expect(result).toEqual({
            content: [{
                text: JSON.stringify({
                    first_number: 1,
                    second_number: 2,
                    sum: 3,
                }),
                type: 'text',
            }],
        });

        await client.close();
    });

    it('should remove Actor from tools list', async () => {
        const actor = 'apify/python-example';
        const selectedToolName = actorNameToToolName(actor);
        const client = await createMCPClient(`${testHost}/sse`, {
            actors: [actor],
            enableAddingActors: true,
        });

        // Verify actor is in the tools list
        const toolsBefore = await client.listTools();
        const namesBefore = toolsBefore.tools.map((tool) => tool.name);
        expect(namesBefore).toContain(selectedToolName);

        // Remove the actor
        await client.callTool({
            name: HelperTools.REMOVE_ACTOR,
            arguments: {
                toolName: selectedToolName,
            },
        });

        // Verify actor is removed
        const toolsAfter = await client.listTools();
        const namesAfter = toolsAfter.tools.map((tool) => tool.name);
        expect(namesAfter).not.toContain(selectedToolName);

        await client.close();
    });
});
