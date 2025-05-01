import type { Server as HttpServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import log from '@apify/log';

import { createExpressApp } from '../../src/actor/server.js';
import { defaults, HelperTools } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { actorNameToToolName } from '../../src/tools/utils.js';

async function createMCPSSEClient(
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
        },
    );

    const client = new Client({
        name: 'sse-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

async function createMCPStreamableClient(
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

    const transport = new StreamableHTTPClientTransport(
        url,
        {
            requestInit: {
                headers: {
                    authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                },
            },
        },
    );

    const client = new Client({
        name: 'sse-client',
        version: '1.0.0',
    });
    await client.connect(transport);

    return client;
}

describe('Actors MCP Server SSE', {
    concurrent: false, // Run test serially to prevent port already in use
}, () => {
    let app: Express;
    let server: ActorsMcpServer;
    let httpServer: HttpServer;
    const testPort = 50000;
    const testHost = `http://localhost:${testPort}`;

    beforeEach(async () => {
        // same as in main.ts
        // TODO: unify
        server = new ActorsMcpServer({
            enableAddingActors: false,
            enableDefaultActors: false,
        });
        log.setLevel(log.LEVELS.OFF);

        // Create express app using the proper server setup
        app = createExpressApp(testHost, server);

        // Start test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(testPort, () => resolve());
        });

        // TODO: figure out why this is needed
        await new Promise<void>((resolve) => { setTimeout(resolve, 1000); });
    });

    afterEach(async () => {
        await server.close();
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
        const client = await createMCPSSEClient(`${testHost}/sse`);

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
        const client = await createMCPSSEClient(`${testHost}/sse`, {
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

    it('load Actors from parameters', async () => {
        const actors = ['apify/rag-web-browser', 'apify/instagram-scraper'];
        const client = await createMCPSSEClient(`${testHost}/sse`, {
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
        const client = await createMCPSSEClient(`${testHost}/sse`, {
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
        const client = await createMCPSSEClient(`${testHost}/sse`, {
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

describe('Actors MCP Server Streamable HTTP', {
    concurrent: false, // Run test serially to prevent port already in use
}, () => {
    let app: Express;
    let server: ActorsMcpServer;
    let httpServer: HttpServer;
    const testPort = 50001;
    const testHost = `http://localhost:${testPort}`;

    beforeEach(async () => {
        // same as in main.ts
        // TODO: unify
        server = new ActorsMcpServer({
            enableAddingActors: false,
            enableDefaultActors: false,
        });
        log.setLevel(log.LEVELS.OFF);

        // Create express app using the proper server setup
        app = createExpressApp(testHost, server);

        // Start test server
        await new Promise<void>((resolve) => {
            httpServer = app.listen(testPort, () => resolve());
        });

        // TODO: figure out why this is needed
        await new Promise<void>((resolve) => { setTimeout(resolve, 1000); });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    });

    it('default tools list', async () => {
        const client = await createMCPStreamableClient(`${testHost}/mcp`);

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
        const client = await createMCPStreamableClient(`${testHost}/mcp`, {
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

    it('load Actors from parameters', async () => {
        const actors = ['apify/rag-web-browser', 'apify/instagram-scraper'];
        const client = await createMCPStreamableClient(`${testHost}/mcp`, {
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
        const client = await createMCPStreamableClient(`${testHost}/mcp`, {
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
        const client = await createMCPStreamableClient(`${testHost}/mcp`, {
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
