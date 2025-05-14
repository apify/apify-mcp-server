import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/index.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import { addActor, expectArrayWeakEquals, type MCPClientOptions } from '../helpers.js';

interface IntegrationTestsSuiteOptions {
    suiteName: string;
    getActorsMCPServer?: () => ActorsMcpServer;
    concurrent?: boolean;
    createClientFn: (options?: MCPClientOptions) => Promise<Client>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
}

export function createIntegrationTestsSuite(
    options: IntegrationTestsSuiteOptions,
) {
    const {
        suiteName,
        getActorsMCPServer,
        concurrent,
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
        concurrent: concurrent ?? true,
    }, () => {
        it('list default tools', async () => {
            const client = await createClientFn();
            const tools = await client.listTools();
            const names = tools.tools.map((tool) => tool.name);

            expect(names.length).toEqual(defaults.actors.length + defaults.helperTools.length);
            for (const tool of defaults.helperTools) {
                expect(names).toContain(tool);
            }
            for (const actor of defaults.actors) {
                expect(names).toContain(actorNameToToolName(actor));
            }
            await client.close();
        });

        it('use only apify/python-example Actor and call it', async () => {
            const actorName = 'apify/python-example';
            const selectedToolName = actorNameToToolName(actorName);
            const client = await createClientFn({
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
            const client = await createClientFn({
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
            const client = await createClientFn({
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
            const client = await createClientFn({
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

        it('should search for Actor successfully', async () => {
            const query = 'python-example';
            const actorName = 'apify/python-example';
            const client = await createClientFn({
                enableAddingActors: false,
            });

            // Remove the actor
            const result = await client.callTool({
                name: HelperTools.SEARCH_ACTORS,
                arguments: {
                    search: query,
                    limit: 5,
                },
            });
            const content = result.content as {text: string}[];
            expect(content.some((item) => item.text.includes(actorName))).toBe(true);

            await client.close();
        });

        // Execute only when we can get the MCP server instance - currently skips only STDIO
        // STDIO is skipped because we are running compiled version through node and there is not way (easy)
        // to get the MCP server instance
        if (getActorsMCPServer) {
            it('INTERNAL load tool state from tool name list if tool list empty', async () => {
                const client = await createClientFn({
                    enableAddingActors: true,
                });
                const actorsMCPServer = getActorsMCPServer();

                // Add a new Actor
                const actor = 'apify/python-example';
                await addActor(client, actor);

                // Store the tool name list
                const toolList = actorsMCPServer.getLoadedActorToolsList();
                expectArrayWeakEquals(toolList, [...defaults.helperTools, ...defaults.actorAddingTools, ...defaults.actors, actor]);

                // Remove all tools
                actorsMCPServer.tools.clear();
                expect(actorsMCPServer.getLoadedActorToolsList()).toEqual([]);

                // Load the tool state from the tool name list
                await actorsMCPServer.loadToolsFromToolsList(toolList, process.env.APIFY_TOKEN as string);

                // Check if the tool name list is restored
                expectArrayWeakEquals(actorsMCPServer.getLoadedActorToolsList(),
                    [...defaults.helperTools, ...defaults.actorAddingTools, ...defaults.actors, actor]);

                await client.close();
            });
            it('INTERNAL load tool state from tool name list if tool list default', async () => {
                const client = await createClientFn({
                    enableAddingActors: true,
                });
                const actorsMCPServer = getActorsMCPServer();

                // Add a new Actor
                const actor = 'apify/python-example';
                await addActor(client, actor);

                // Store the tool name list
                const toolList = actorsMCPServer.getLoadedActorToolsList();
                expectArrayWeakEquals(toolList, [...defaults.helperTools, ...defaults.actorAddingTools, ...defaults.actors, actor]);

                // Remove all tools
                await actorsMCPServer.reset();
                actorsMCPServer.loadToolsToAddActors();
                expectArrayWeakEquals(actorsMCPServer.getLoadedActorToolsList(), [...defaults.helperTools, ...defaults.actorAddingTools]);

                // Load the tool state from the tool name list
                await actorsMCPServer.loadToolsFromToolsList(toolList, process.env.APIFY_TOKEN as string);

                // Check if the tool name list is restored
                expectArrayWeakEquals(actorsMCPServer.getLoadedActorToolsList(),
                    [...defaults.helperTools, ...defaults.actorAddingTools, ...defaults.actors, actor]);

                await client.close();
            });
            it('INTERNAL should notify tools changed handler when tools are added or removed', async () => {
                const client = await createClientFn({
                    enableAddingActors: true,
                });

                const toolsChangedNotifications: string[][] = [];

                const onToolsChanged = (tools: string[]) => {
                    toolsChangedNotifications.push(tools);
                };

                const actorsMCPServer = getActorsMCPServer();
                actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

                // Add a new Actor
                const actor = 'apify/python-example';
                await client.callTool({
                    name: HelperTools.ADD_ACTOR,
                    arguments: {
                        actorName: actor,
                    },
                });

                // Check if the notification was received
                expect(toolsChangedNotifications.length).toBe(1);
                expect(toolsChangedNotifications[0].length).toBe(defaults.helperTools.length
                    + defaults.actorAddingTools.length + defaults.actors.length + 1);
                expect(toolsChangedNotifications[0]).toContain(actor);
                for (const tool of defaults.helperTools) {
                    expect(toolsChangedNotifications[0]).toContain(tool);
                }
                for (const tool of defaults.actorAddingTools) {
                    expect(toolsChangedNotifications[0]).toContain(tool);
                }
                for (const tool of defaults.actors) {
                    expect(toolsChangedNotifications[0]).toContain(tool);
                }

                // Remove the Actor
                await client.callTool({
                    name: HelperTools.REMOVE_ACTOR,
                    arguments: {
                        toolName: actorNameToToolName(actor),
                    },
                });

                // Check if the notification was received
                expect(toolsChangedNotifications.length).toBe(2);
                expect(toolsChangedNotifications[1].length).toBe(defaults.helperTools.length
                    + defaults.actorAddingTools.length + defaults.actors.length);
                expect(toolsChangedNotifications[1]).not.toContain(actor);
                for (const tool of defaults.helperTools) {
                    expect(toolsChangedNotifications[1]).toContain(tool);
                }
                for (const tool of defaults.actorAddingTools) {
                    expect(toolsChangedNotifications[1]).toContain(tool);
                }
                for (const tool of defaults.actors) {
                    expect(toolsChangedNotifications[1]).toContain(tool);
                }

                await client.close();
            });
            it('INTERNAL should not notify tools changed handler after unregister', async () => {
                const client = await createClientFn({
                    enableAddingActors: true,
                });

                const toolsChangedNotifications: string[][] = [];

                const onToolsChanged = (tools: string[]) => {
                    toolsChangedNotifications.push(tools);
                };

                const actorsMCPServer = getActorsMCPServer();
                actorsMCPServer.registerToolsChangedHandler(onToolsChanged);

                // Add a new Actor
                const actor = 'apify/python-example';
                await client.callTool({
                    name: HelperTools.ADD_ACTOR,
                    arguments: {
                        actorName: actor,
                    },
                });

                // Check if the notification was received
                expect(toolsChangedNotifications.length).toBe(1);
                expect(toolsChangedNotifications[0].length).toBe(defaults.helperTools.length
                    + defaults.actorAddingTools.length + defaults.actors.length + 1);
                expect(toolsChangedNotifications[0]).toContain(actor);
                for (const tool of defaults.helperTools) {
                    expect(toolsChangedNotifications[0]).toContain(tool);
                }
                for (const tool of defaults.actorAddingTools) {
                    expect(toolsChangedNotifications[0]).toContain(tool);
                }
                for (const tool of defaults.actors) {
                    expect(toolsChangedNotifications[0]).toContain(tool);
                }

                actorsMCPServer.unregisterToolsChangedHandler();

                // Remove the Actor
                await client.callTool({
                    name: HelperTools.REMOVE_ACTOR,
                    arguments: {
                        toolName: actorNameToToolName(actor),
                    },
                });

                // Check if the notification was NOT received
                expect(toolsChangedNotifications.length).toBe(1);

                await client.close();
            });
        }
    });
}
