import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/index.js';
import { addRemoveTools, defaultTools } from '../../src/tools/index.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import { addActor, expectArrayWeakEquals, type McpClientOptions } from '../helpers.js';

interface IntegrationTestsSuiteOptions {
    suiteName: string;
    getActorsMcpServer?: () => ActorsMcpServer;
    createClientFn: (options?: McpClientOptions) => Promise<Client>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
}

const ACTOR_PYTHON_EXAMPLE = 'apify/python-example';
const DEFAULT_TOOL_NAMES = defaultTools.map((tool) => tool.tool.name);
const DEFAULT_ACTOR_NAMES = defaults.actors.map((tool) => actorNameToToolName(tool));

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
        getActorsMcpServer,
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

        it('should remove Actor from tools list', async () => {
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

        // Execute only when we can get the MCP server instance - currently skips only stdio
        // is skipped because we are running a compiled version through node and there is no way (easy)
        // to get the MCP server instance
        it.runIf(getActorsMcpServer)('should load and restore tools from a tool list', async () => {
            const client = await createClientFn({ enableAddingActors: true });
            const actorsMcpServer = getActorsMcpServer!();

            // Add a new Actor
            await addActor(client, ACTOR_PYTHON_EXAMPLE);

            // Store the tool name list
            const names = actorsMcpServer.listAllToolNames();
            const expectedToolNames = [
                ...DEFAULT_TOOL_NAMES,
                ...defaults.actors,
                ...addRemoveTools.map((tool) => tool.tool.name),
                ...[ACTOR_PYTHON_EXAMPLE],
            ];
            expectArrayWeakEquals(expectedToolNames, names);

            // Remove all tools
            actorsMcpServer.tools.clear();
            expect(actorsMcpServer.listAllToolNames()).toEqual([]);

            // Load the tool state from the tool name list
            await actorsMcpServer.loadToolsByName(names, process.env.APIFY_TOKEN as string);

            // Check if the tool name list is restored
            expectArrayWeakEquals(actorsMcpServer.listAllToolNames(), expectedToolNames);

            await client.close();
        });

        it.runIf(getActorsMcpServer)('should reset and restore tool state with default tools', async () => {
            const firstClient = await createClientFn({ enableAddingActors: true });
            const actorsMCPServer = getActorsMcpServer!();
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;
            const toolList = actorsMCPServer.listAllToolNames();
            expect(toolList.length).toEqual(numberOfTools);
            // Add a new Actor
            await addActor(firstClient, ACTOR_PYTHON_EXAMPLE);

            // Store the tool name list
            const toolListWithActor = actorsMCPServer.listAllToolNames();
            expect(toolListWithActor.length).toEqual(numberOfTools + 1); // + 1 for the added Actor
            await firstClient.close();

            // Remove all tools
            await actorsMCPServer.reset();
            // We connect second client so that the default tools are loaded
            // if no specific list of Actors is provided
            const secondClient = await createClientFn({ enableAddingActors: true });
            const toolListAfterReset = actorsMCPServer.listAllToolNames();
            expect(toolListAfterReset.length).toEqual(numberOfTools);
            await secondClient.close();
        });

        it.runIf(getActorsMcpServer)('should notify tools changed handler on tool modifications', async () => {
            const client = await createClientFn({ enableAddingActors: true });
            let latestTools: string[] = [];
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;

            let toolNotificationCount = 0;
            const onToolsChanged = (tools: string[]) => {
                latestTools = tools;
                toolNotificationCount++;
            };

            const actorsMCPServer = getActorsMcpServer!();
            actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

            // Add a new Actor
            const actor = ACTOR_PYTHON_EXAMPLE;
            await client.callTool({
                name: HelperTools.ACTOR_ADD,
                arguments: {
                    actorName: actor,
                },
            });

            // Check if the notification was received with the correct tools
            expect(toolNotificationCount).toBe(1);
            expect(latestTools.length).toBe(numberOfTools + 1);
            expect(latestTools).toContain(actor);
            for (const tool of [...defaultTools, ...addRemoveTools]) {
                expect(latestTools).toContain(tool.tool.name);
            }
            for (const tool of defaults.actors) {
                expect(latestTools).toContain(tool);
            }

            // Remove the Actor
            await client.callTool({
                name: HelperTools.ACTOR_REMOVE,
                arguments: {
                    toolName: actorNameToToolName(actor),
                },
            });

            // Check if the notification was received with the correct tools
            expect(toolNotificationCount).toBe(2);
            expect(latestTools.length).toBe(numberOfTools);
            expect(latestTools).not.toContain(actor);
            for (const tool of [...defaultTools, ...addRemoveTools]) {
                expect(latestTools).toContain(tool.tool.name);
            }
            for (const tool of defaults.actors) {
                expect(latestTools).toContain(tool);
            }

            await client.close();
        });

        it.runIf(getActorsMcpServer)('should stop notifying after unregistering tools changed handler', async () => {
            const client = await createClientFn({ enableAddingActors: true });
            let latestTools: string[] = [];
            let notificationCount = 0;
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;
            const onToolsChanged = (tools: string[]) => {
                latestTools = tools;
                notificationCount++;
            };

            const actorsMCPServer = getActorsMcpServer!();
            actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

            // Add a new Actor
            const actor = ACTOR_PYTHON_EXAMPLE;
            await client.callTool({
                name: HelperTools.ACTOR_ADD,
                arguments: {
                    actorName: actor,
                },
            });

            // Check if the notification was received
            expect(notificationCount).toBe(1);
            expect(latestTools.length).toBe(numberOfTools + 1);
            expect(latestTools).toContain(actor);

            actorsMCPServer.unregisterToolsChangedHandler();

            // Remove the Actor
            await client.callTool({
                name: HelperTools.ACTOR_REMOVE,
                arguments: {
                    toolName: actorNameToToolName(actor),
                },
            });

            // Check if the notification was NOT received
            expect(notificationCount).toBe(1);
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
    });
}
