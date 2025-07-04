import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import { addRemoveTools, defaultTools } from '../../src/tools/index.js';
import type { ISearchActorsResult } from '../../src/tools/store_collection.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import { ACTOR_MCP_SERVER_ACTOR_NAME, ACTOR_PYTHON_EXAMPLE, DEFAULT_ACTOR_NAMES, DEFAULT_TOOL_NAMES } from '../const.js';
import { addActor, type McpClientOptions } from '../helpers.js';

interface IntegrationTestsSuiteOptions {
    suiteName: string;
    transport: 'sse' | 'streamable-http' | 'stdio';
    createClientFn: (options?: McpClientOptions) => Promise<Client>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
}

function getToolNames(tools: { tools: { name: string }[] }) {
    return tools.tools.map((tool) => tool.name);
}

function expectToolNamesToContain(names: string[], toolNames: string[] = []) {
    toolNames.forEach((name) => expect(names).toContain(name));
}

async function callPythonExampleActor(client: Client, selectedToolName: string) {
    const result = await client.callTool({
        name: selectedToolName,
        arguments: {
            first_number: 1,
            second_number: 2,
        },
    });

    type ContentItem = { text: string; type: string };
    const content = result.content as ContentItem[];
    // The result is { content: [ ... ] }, and the last content is the sum
    expect(content[content.length - 1]).toEqual({
        text: JSON.stringify({
            first_number: 1,
            second_number: 2,
            sum: 3,
        }),
        type: 'text',
    });
}

export function createIntegrationTestsSuite(
    options: IntegrationTestsSuiteOptions,
) {
    const {
        suiteName,
        createClientFn,
        beforeAllFn,
        afterAllFn,
        beforeEachFn,
        afterEachFn,
    } = options;

    // Hooks
    if (beforeAllFn) {
        beforeAll(beforeAllFn);
    }
    if (afterAllFn) {
        afterAll(afterAllFn);
    }
    if (beforeEachFn) {
        beforeEach(beforeEachFn);
    }
    if (afterEachFn) {
        afterEach(afterEachFn);
    }

    describe(suiteName, {
        concurrent: false, // Make all tests sequential to prevent state interference
    }, () => {
        it('should list all default tools and Actors', async () => {
            const client = await createClientFn();
            const tools = await client.listTools();
            expect(tools.tools.length).toEqual(defaultTools.length + defaults.actors.length + addRemoveTools.length);

            const names = getToolNames(tools);
            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expectToolNamesToContain(names, addRemoveTools.map((tool) => tool.tool.name));
            await client.close();
        });

        it('should list all default tools and Actors, with add/remove tools', async () => {
            const client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + defaults.actors.length + addRemoveTools.length);

            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expectToolNamesToContain(names, addRemoveTools.map((tool) => tool.tool.name));
            await client.close();
        });

        it('should list all default tools and Actors, without add/remove tools', async () => {
            const client = await createClientFn({ enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + defaults.actors.length);

            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            await client.close();
        });

        it('should list all default tools and two loaded Actors', async () => {
            const actors = ['apify/website-content-crawler', 'apify/instagram-scraper'];
            const client = await createClientFn({ actors, enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + actors.length);
            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, actors.map((actor) => actorNameToToolName(actor)));

            await client.close();
        });

        it('should add Actor dynamically and call it', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            const client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;
            expect(names.length).toEqual(numberOfTools);
            // Check that the Actor is not in the tools list
            expect(names).not.toContain(selectedToolName);
            // Add Actor dynamically
            await client.callTool({ name: HelperTools.ACTOR_ADD, arguments: { actorName: ACTOR_PYTHON_EXAMPLE } });

            // Check if tools was added
            const namesAfterAdd = getToolNames(await client.listTools());
            expect(namesAfterAdd.length).toEqual(numberOfTools + 1);
            expect(namesAfterAdd).toContain(selectedToolName);
            await callPythonExampleActor(client, selectedToolName);

            await client.close();
        });

        // TODO: disabled for now, remove tools is disabled and might be removed in the future
        it.runIf(false)('should remove Actor from tools list', async () => {
            const actor = ACTOR_PYTHON_EXAMPLE;
            const selectedToolName = actorNameToToolName(actor);
            const client = await createClientFn({
                actors: [actor],
                enableAddingActors: true,
            });

            // Verify actor is in the tools list
            const namesBefore = getToolNames(await client.listTools());
            expect(namesBefore).toContain(selectedToolName);

            // Remove the actor
            await client.callTool({ name: HelperTools.ACTOR_REMOVE, arguments: { toolName: selectedToolName } });

            // Verify actor is removed
            const namesAfter = getToolNames(await client.listTools());
            expect(namesAfter).not.toContain(selectedToolName);

            await client.close();
        });

        it('should find Actors in store search', async () => {
            const query = 'python-example';
            const client = await createClientFn({
                enableAddingActors: false,
            });

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH,
                arguments: {
                    search: query,
                    limit: 5,
                },
            });
            const content = result.content as {text: string}[];
            expect(content.some((item) => item.text.includes(ACTOR_PYTHON_EXAMPLE))).toBe(true);

            await client.close();
        });

        // It should filter out all rental Actors only if we run locally or as standby, where
        // we cannot access MongoDB to get the user's rented Actors.
        // In case of apify-mcp-server it should include user's rented Actors.
        it('should filter out all rental Actors from store search', async () => {
            const client = await createClientFn();

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH,
                arguments: {
                    search: 'rental',
                    limit: 100,
                },
            });
            const content = result.content as {text: string}[];
            expect(content.length).toBe(1);
            const resultJson = JSON.parse(content[0].text) as ISearchActorsResult;
            const { actors } = resultJson;
            expect(actors.length).toBe(resultJson.total);
            expect(actors.length).toBeGreaterThan(0);

            // Check that no rental Actors are present
            for (const actor of actors) {
                // Since we now return the pricingInfo as a string, we need to check if it contains the string
                expect(actor.pricingInfo).not.toContain('This Actor is rental');
            }

            await client.close();
        });

        it('should notify client about tool list changed', async () => {
            const client = await createClientFn({ enableAddingActors: true });

            // This flag is set to true when a 'notifications/tools/list_changed' notification is received,
            // indicating that the tool list has been updated dynamically.
            let hasReceivedNotification = false;
            client.setNotificationHandler(ToolListChangedNotificationSchema, async (notification) => {
                if (notification.method === 'notifications/tools/list_changed') {
                    hasReceivedNotification = true;
                }
            });
            // Add Actor dynamically
            await client.callTool({ name: HelperTools.ACTOR_ADD, arguments: { actorName: ACTOR_PYTHON_EXAMPLE } });

            expect(hasReceivedNotification).toBe(true);

            await client.close();
        });

        it('should be able to add and call Actorized MCP server', async () => {
            const client = await createClientFn({ enableAddingActors: true });

            const toolNamesBefore = getToolNames(await client.listTools());
            const searchToolCountBefore = toolNamesBefore.filter((name) => name.includes(HelperTools.STORE_SEARCH)).length;
            expect(searchToolCountBefore).toBe(1);

            // Add self as an Actorized MCP server
            await addActor(client, ACTOR_MCP_SERVER_ACTOR_NAME);

            const toolNamesAfter = getToolNames(await client.listTools());
            const searchToolCountAfter = toolNamesAfter.filter((name) => name.includes(HelperTools.STORE_SEARCH)).length;
            expect(searchToolCountAfter).toBe(2);

            // Find the search tool from the Actorized MCP server
            const actorizedMCPSearchTool = toolNamesAfter.find(
                (name) => name.includes(HelperTools.STORE_SEARCH) && name !== HelperTools.STORE_SEARCH);
            expect(actorizedMCPSearchTool).toBeDefined();

            const result = await client.callTool({
                name: actorizedMCPSearchTool as string,
                arguments: {
                    search: ACTOR_MCP_SERVER_ACTOR_NAME,
                    limit: 1,
                },
            });
            expect(result.content).toBeDefined();

            await client.close();
        });

        // Session termination is only possible for streamable HTTP transport.
        it.runIf(options.transport === 'streamable-http')('should successfully terminate streamable session', async () => {
            const client = await createClientFn();
            await client.listTools();
            await (client.transport as StreamableHTTPClientTransport).terminateSession();
            await client.close();
        });
    });
}
