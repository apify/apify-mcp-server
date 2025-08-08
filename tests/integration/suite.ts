import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import { latestNewsOnTopicPrompt } from '../../src/prompts/latest-news-on-topic.js';
import { addRemoveTools, defaultTools, toolCategories, toolCategoriesEnabledByDefault } from '../../src/tools/index.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import type { ToolCategory } from '../../src/types.js';
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
    const expected = {
        text: JSON.stringify({
            first_number: 1,
            second_number: 2,
            sum: 3,
        }),
        type: 'text',
    };
    // Parse the JSON to compare objects regardless of property order
    const actual = content[content.length - 1];
    expect(JSON.parse(actual.text)).toEqual(JSON.parse(expected.text));
    expect(actual.type).toBe(expected.type);
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
            expect(names).toMatchInlineSnapshot(`
              [
                "get-actor-details",
                "search-actors",
                "search-apify-docs",
                "fetch-apify-docs",
                "apify-slash-rag-web-browser",
              ]
            `);

            await client.close();
        });

        it('should list all default tools and two loaded Actors', async () => {
            const actors = ['apify/website-content-crawler', 'apify/instagram-scraper'];
            const client = await createClientFn({ actors, enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names).toMatchInlineSnapshot(`
              [
                "get-actor-details",
                "search-actors",
                "search-apify-docs",
                "fetch-apify-docs",
                "apify-slash-website-content-crawler",
                "apify-slash-instagram-scraper",
              ]
            `);

            await client.close();
        });

        it('should add Actor dynamically and call it directly', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            const client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length;
            expect(names.length).toEqual(numberOfTools);
            // Check that the Actor is not in the tools list
            expect(names).not.toContain(selectedToolName);
            // Add Actor dynamically
            await addActor(client, ACTOR_PYTHON_EXAMPLE);

            // Check if tools was added
            const namesAfterAdd = getToolNames(await client.listTools());
            expect(namesAfterAdd.length).toEqual(numberOfTools + 1);
            expect(namesAfterAdd).toContain(selectedToolName);
            await callPythonExampleActor(client, selectedToolName);

            await client.close();
        });

        it('should add Actor dynamically and call it via generic call-actor tool', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            const client = await createClientFn({ enableAddingActors: true, tools: ['preview'] });
            const names = getToolNames(await client.listTools());
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length + toolCategories.preview.length;
            expect(names.length).toEqual(numberOfTools);
            // Check that the Actor is not in the tools list
            expect(names).not.toContain(selectedToolName);
            // Add Actor dynamically
            await addActor(client, ACTOR_PYTHON_EXAMPLE);

            // Check if tools was added
            const namesAfterAdd = getToolNames(await client.listTools());
            expect(namesAfterAdd.length).toEqual(numberOfTools + 1);
            expect(namesAfterAdd).toContain(selectedToolName);

            const result = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: {
                        first_number: 1,
                        second_number: 2,
                    },
                },
            });

            expect(result).toEqual(
                {
                    content: [
                        {
                            text: `{"sum":3,"first_number":1,"second_number":2}`,
                            type: 'text',
                        },
                    ],
                },
            );

            await client.close();
        });

        it('should not call Actor via call-actor tool if it is not added', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            const client = await createClientFn({ enableAddingActors: true, tools: ['preview'] });
            const names = getToolNames(await client.listTools());
            const numberOfTools = defaultTools.length + addRemoveTools.length + defaults.actors.length + toolCategories.preview.length;
            expect(names.length).toEqual(numberOfTools);
            // Check that the Actor is not in the tools list
            expect(names).not.toContain(selectedToolName);

            const result = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: {
                        first_number: 1,
                        second_number: 2,
                    },
                },
            });

            // TODO: make some more change-tolerant assertion, it's hard to verify text message result without exact match
            expect(result).toEqual(
                {
                    content: [
                        {
                            text: "Actor 'apify/python-example' is not added. Add it with the 'add-actor' tool. Available Actors are: apify/rag-web-browser",
                            type: 'text',
                        },
                    ],
                },
            );

            await client.close();
        });

        // TODO: disabled for now, remove tools is disabled and might be removed in the future
        it.skip('should remove Actor from tools list', async () => {
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
            const outputText = content[0].text;

            // Check to ensure that the output string format remains the same.
            // If someone changes the output format, this test may stop working
            // without actually failing.
            expect(outputText).toContain('This Actor');
            // Check that no rental Actors are present
            expect(outputText).not.toContain('This Actor is rental');

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
            await client.callTool({ name: HelperTools.ACTOR_ADD, arguments: { actor: ACTOR_PYTHON_EXAMPLE } });

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

        it('should search Apify documentation', async () => {
            const client = await createClientFn({
                tools: ['docs'],
            });
            const toolName = HelperTools.DOCS_SEARCH;

            const query = 'standby actor';
            const result = await client.callTool({
                name: toolName,
                arguments: {
                    query,
                    limit: 5,
                    offset: 0,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            // At least one result should contain the standby actor docs URL
            const standbyDocUrl = 'https://docs.apify.com/platform/actors/running/standby';
            expect(content.some((item) => item.text.includes(standbyDocUrl))).toBe(true);

            await client.close();
        });

        it('should fetch Apify documentation page', async () => {
            const client = await createClientFn({
                tools: ['docs'],
            });
            const toolName = HelperTools.DOCS_FETCH;

            const documentUrl = 'https://docs.apify.com/academy/getting-started/creating-actors';
            const result = await client.callTool({
                name: toolName,
                arguments: {
                    url: documentUrl,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(documentUrl);

            await client.close();
        });

        it('should load correct tools for each category tools key', async () => {
            for (const category of Object.keys(toolCategories)) {
                const client = await createClientFn({
                    tools: [category as ToolCategory],
                });

                const loadedTools = await client.listTools();
                const toolNames = getToolNames(loadedTools);

                // If the category is enabled by default, it should not be loaded again, and its tools
                // are accounted for in the default tools.
                const isCategoryInDefault = toolCategoriesEnabledByDefault.includes(category as ToolCategory);
                const expectedTools = isCategoryInDefault ? [] : toolCategories[category as ToolCategory];
                const expectedToolNames = expectedTools.map((tool) => tool.tool.name);

                expect(toolNames.length).toEqual(expectedTools.length + defaultTools.length + defaults.actors.length + addRemoveTools.length);
                for (const expectedToolName of expectedToolNames) {
                    expect(toolNames).toContain(expectedToolName);
                }

                await client.close();
            }
        });

        it('should handle multiple tool category keys input correctly', async () => {
            const categories = ['docs', 'runs', 'storage'] as ToolCategory[];
            const client = await createClientFn({
                tools: categories,
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedTools = [
                ...toolCategories.docs,
                ...toolCategories.runs,
                ...toolCategories.storage,
            ];
            const expectedToolNames = expectedTools.map((tool) => tool.tool.name);

            // Handle case where tools are enabled by default
            const selectedCategoriesInDefault = categories.filter((key) => toolCategoriesEnabledByDefault.includes(key));
            const numberOfToolsFromCategoriesInDefault = selectedCategoriesInDefault
                .flatMap((key) => toolCategories[key]).length;

            const numberOfToolsExpected = defaultTools.length + defaults.actors.length + addRemoveTools.length
                // Tools from tool categories minus the ones already in default tools
                + (expectedTools.length - numberOfToolsFromCategoriesInDefault);
            expect(toolNames.length).toEqual(numberOfToolsExpected);
            for (const expectedToolName of expectedToolNames) {
                expect(toolNames).toContain(expectedToolName);
            }

            await client.close();
        });

        it('should list all prompts', async () => {
            const client = await createClientFn();
            const prompts = await client.listPrompts();
            expect(prompts.prompts.length).toBeGreaterThan(0);
            await client.close();
        });

        it('should be able to get prompt by name', async () => {
            const client = await createClientFn();

            const topic = 'apify';
            const prompt = await client.getPrompt({
                name: latestNewsOnTopicPrompt.name,
                arguments: {
                    topic,
                },
            });

            const message = prompt.messages[0];
            expect(message).toBeDefined();
            expect(message.content.text).toContain(topic);

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
