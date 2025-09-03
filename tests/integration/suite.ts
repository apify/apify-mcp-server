import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaults, HelperTools } from '../../src/const.js';
import { addTool } from '../../src/tools/helpers.js';
import { defaultTools, toolCategories } from '../../src/tools/index.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import type { ToolCategory } from '../../src/types.js';
import { getExpectedToolNamesByCategories } from '../../src/utils/tools.js';
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
        text: JSON.stringify([{
            first_number: 1,
            second_number: 2,
            sum: 3,
        }]),
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
            expect(tools.tools.length).toEqual(defaultTools.length + defaults.actors.length + 1);

            const names = getToolNames(tools);
            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expect(names).toContain('get-actor-output');
            await client.close();
        });

        it('should match spec default: actors,docs,apify/rag-web-browser when no params provided', async () => {
            const client = await createClientFn();
            const tools = await client.listTools();
            const names = getToolNames(tools);

            // Should be equivalent to tools=actors,docs,apify/rag-web-browser
            const expectedActorsTools = ['fetch-actor-details', 'search-actors', 'call-actor'];
            const expectedDocsTools = ['search-apify-docs', 'fetch-apify-docs'];
            const expectedActors = ['apify-slash-rag-web-browser'];

            const expectedTotal = expectedActorsTools.concat(expectedDocsTools, expectedActors);
            expect(names).toHaveLength(expectedTotal.length + 1);

            expectToolNamesToContain(names, expectedActorsTools);
            expectToolNamesToContain(names, expectedDocsTools);
            expectToolNamesToContain(names, expectedActors);
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should list only add-actor when enableAddingActors is true and no tools/actors are specified', async () => {
            const client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(2);
            expect(names).toContain('add-actor');
            expect(names).toContain('get-actor-output');
            await client.close();
        });

        it('should list all default tools and Actors when enableAddingActors is false', async () => {
            const client = await createClientFn({ enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + defaults.actors.length + 1);

            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should override enableAddingActors false with experimental tool category', async () => {
            const client = await createClientFn({ enableAddingActors: false, tools: ['experimental'] });

            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(2);
            expect(names).toContain('add-actor');
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should list two loaded Actors', async () => {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            const client = await createClientFn({ actors, enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(actors.length + 1);
            expectToolNamesToContain(names, actors.map((actor) => actorNameToToolName(actor)));
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should load only specified actors when actors param is provided (no other tools)', async () => {
            const actors = ['apify/python-example'];
            const client = await createClientFn({ actors });
            const names = getToolNames(await client.listTools());

            // Should only load the specified actor, no default tools or categories
            expect(names.length).toEqual(actors.length + 1);
            expect(names).toContain(actorNameToToolName(actors[0]));
            expect(names).toContain('get-actor-output');

            // Should NOT include any default category tools
            expect(names).not.toContain('search-actors');
            expect(names).not.toContain('fetch-actor-details');
            expect(names).not.toContain('call-actor');
            expect(names).not.toContain('search-apify-docs');
            expect(names).not.toContain('fetch-apify-docs');

            await client.close();
        });

        it('should not load any tools when enableAddingActors is true and tools param is empty', async () => {
            const client = await createClientFn({ enableAddingActors: true, tools: [] });
            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(0);
            await client.close();
        });

        it('should not load any tools when enableAddingActors is true and actors param is empty', async () => {
            const client = await createClientFn({ enableAddingActors: true, actors: [] });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
            await client.close();
        });

        it('should not load any tools when enableAddingActors is false and no tools/actors are specified', async () => {
            const client = await createClientFn({ enableAddingActors: false, tools: [], actors: [] });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
            await client.close();
        });

        it('should load only specified Actors via tools selectors when actors param omitted', async () => {
            const actors = ['apify/python-example'];
            const client = await createClientFn({ tools: actors });
            const names = getToolNames(await client.listTools());
            // Only the Actor should be loaded
            expect(names).toHaveLength(actors.length + 1);
            expect(names).toContain(actorNameToToolName(actors[0]));
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should treat selectors with slashes as Actor names', async () => {
            const client = await createClientFn({
                tools: ['docs', 'apify/python-example'],
            });
            const names = getToolNames(await client.listTools());

            // Should include docs category
            expect(names).toContain('search-apify-docs');
            expect(names).toContain('fetch-apify-docs');

            // Should include actor (if it exists/is valid)
            expect(names).toContain('apify-slash-python-example');

            await client.close();
        });

        it('should merge actors param into tools selectors (backward compatibility)', async () => {
            const actors = ['apify/python-example'];
            const categories = ['docs'] as ToolCategory[];

            const client = await createClientFn({ tools: categories, actors });

            const names = getToolNames(await client.listTools());
            const docsToolNames = getExpectedToolNamesByCategories(categories);
            const expected = [...docsToolNames, actorNameToToolName(actors[0])];
            expect(names).toHaveLength(expected.length + 1);

            const containsExpected = expected.every((n) => names.includes(n));
            expect(containsExpected).toBe(true);
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should handle mixed categories and specific tools in tools param', async () => {
            const client = await createClientFn({
                tools: ['docs', 'fetch-actor-details', 'add-actor'],
            });
            const names = getToolNames(await client.listTools());

            expect(names).toHaveLength(5);

            // Should include: docs category + specific tools
            expect(names).toContain('search-apify-docs'); // from docs category
            expect(names).toContain('fetch-apify-docs'); // from docs category
            expect(names).toContain('fetch-actor-details'); // specific tool
            expect(names).toContain('add-actor'); // specific tool
            expect(names).toContain('get-actor-output');

            // Should NOT include other actors category tools
            expect(names).not.toContain('search-actors');
            expect(names).not.toContain('call-actor');

            await client.close();
        });

        it('should load only docs tools', async () => {
            const categories = ['docs'] as ToolCategory[];
            const client = await createClientFn({ tools: categories, actors: [] });
            const names = getToolNames(await client.listTools());
            const expected = getExpectedToolNamesByCategories(categories);
            expect(names.length).toEqual(expected.length);
            expectToolNamesToContain(names, expected);
            await client.close();
        });

        it('should load only a specific tool when tools includes a tool name', async () => {
            const client = await createClientFn({ tools: ['fetch-actor-details'], actors: [] });
            const names = getToolNames(await client.listTools());
            expect(names).toEqual(['fetch-actor-details']);
            await client.close();
        });

        it('should not load any tools when tools param is empty and actors omitted', async () => {
            const client = await createClientFn({ tools: [] });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
            await client.close();
        });

        it('should not load any internal tools when tools param is empty and use custom Actor if specified', async () => {
            const client = await createClientFn({ tools: [], actors: [ACTOR_PYTHON_EXAMPLE] });

            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(2);
            expect(names).toContain(actorNameToToolName(ACTOR_PYTHON_EXAMPLE));
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should add Actor dynamically and call it directly', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            const client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            // Only the add tool should be added
            expect(names).toHaveLength(2);
            expect(names).toContain('add-actor');
            expect(names).toContain('get-actor-output');
            expect(names).not.toContain(selectedToolName);
            // Add Actor dynamically
            await addActor(client, ACTOR_PYTHON_EXAMPLE);

            // Check if tools was added
            const namesAfterAdd = getToolNames(await client.listTools());
            expect(namesAfterAdd.length).toEqual(3);
            expect(namesAfterAdd).toContain(selectedToolName);
            expect(namesAfterAdd).toContain('get-actor-output');
            await callPythonExampleActor(client, selectedToolName);

            await client.close();
        });

        it('should call Actor dynamically via generic call-actor tool without need to add it first', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            const client = await createClientFn({ enableAddingActors: true, tools: ['actors'] });
            const names = getToolNames(await client.listTools());
            // Only the actors category, get-actor-output and add-actor should be loaded
            const numberOfTools = toolCategories.actors.length + 2;
            expect(names).toHaveLength(numberOfTools);
            // Check that the Actor is not in the tools list
            expect(names).not.toContain(selectedToolName);

            const result = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    step: 'call',
                    input: {
                        first_number: 1,
                        second_number: 2,
                    },
                },
            });

            const content = result.content as { text: string }[];

            expect(content[content.length - 1]).toEqual(
                {
                    text: JSON.stringify([{
                        first_number: 1,
                        second_number: 2,
                        sum: 3,
                    }]),
                    type: 'text',
                },
            );

            await client.close();
        });

        it('should enforce two-step process for call-actor tool', async () => {
            const client = await createClientFn({ tools: ['actors'] });

            // Step 1: Get info (should work)
            const infoResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    step: 'info',
                },
            });

            expect(infoResult.content).toBeDefined();
            const content = infoResult.content as { text: string }[];
            expect(content.some((item) => item.text.includes('Input Schema'))).toBe(true);

            // Step 2: Call with proper input (should work)
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    step: 'call',
                    input: { first_number: 1, second_number: 2 },
                },
            });

            expect(callResult.content).toBeDefined();

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

        it('should return no tools were added when adding a non-existent actor', async () => {
            const client = await createClientFn({ enableAddingActors: true });
            const nonExistentActor = 'apify/this-actor-does-not-exist';
            const result = await client.callTool({
                name: HelperTools.ACTOR_ADD,
                arguments: { actor: nonExistentActor },
            });
            expect(result).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain('no tools were added');
            await client.close();
        });

        it('should be able to add and call Actorized MCP server', async () => {
            const client = await createClientFn({ enableAddingActors: true });

            const toolNamesBefore = getToolNames(await client.listTools());
            const searchToolCountBefore = toolNamesBefore.filter((name) => name.includes(HelperTools.STORE_SEARCH)).length;
            expect(searchToolCountBefore).toBe(0);

            // Add self as an Actorized MCP server
            await addActor(client, ACTOR_MCP_SERVER_ACTOR_NAME);

            const toolNamesAfter = getToolNames(await client.listTools());
            const searchToolCountAfter = toolNamesAfter.filter((name) => name.includes(HelperTools.STORE_SEARCH)).length;
            expect(searchToolCountAfter).toBe(1);

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

                const expectedToolNames = getExpectedToolNamesByCategories([category as ToolCategory]);
                // Only assert that all tools from the selected category are present.
                for (const expectedToolName of expectedToolNames) {
                    expect(toolNames).toContain(expectedToolName);
                }

                await client.close();
            }
        });

        it('should include add-actor when experimental category is selected even if enableAddingActors is false', async () => {
            const client = await createClientFn({
                enableAddingActors: false,
                tools: ['experimental'],
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            expect(toolNames).toContain(addTool.tool.name);

            await client.close();
        });

        it('should include add-actor when enableAddingActors is false and add-actor is selected directly', async () => {
            const client = await createClientFn({
                enableAddingActors: false,
                tools: [addTool.tool.name],
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            // Must include add-actor since it was selected directly
            expect(toolNames).toContain(addTool.tool.name);

            await client.close();
        });

        it('should handle multiple tool category keys input correctly', async () => {
            const categories = ['docs', 'runs', 'storage'] as ToolCategory[];
            const client = await createClientFn({
                tools: categories,
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedToolNames = getExpectedToolNamesByCategories(categories);
            expect(toolNames).toHaveLength(expectedToolNames.length);
            const containsExpectedTools = toolNames.every((name) => expectedToolNames.includes(name));
            expect(containsExpectedTools).toBe(true);

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
                name: 'GetLatestNewsOnTopic',
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

        // Environment variable tests - only applicable to stdio transport
        it.runIf(options.transport === 'stdio')('should load actors from ACTORS environment variable', async () => {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            const client = await createClientFn({ actors, useEnv: true });
            const names = getToolNames(await client.listTools());
            expectToolNamesToContain(names, actors.map((actor) => actorNameToToolName(actor)));

            await client.close();
        });

        it.runIf(options.transport === 'stdio')('should respect ENABLE_ADDING_ACTORS environment variable', async () => {
            // Test with enableAddingActors = false via env var
            const client = await createClientFn({ enableAddingActors: false, useEnv: true });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + defaults.actors.length + 1);

            expectToolNamesToContain(names, DEFAULT_TOOL_NAMES);
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it.runIf(options.transport === 'stdio')('should respect ENABLE_ADDING_ACTORS environment variable and load only add-actor tool when true', async () => {
            // Test with enableAddingActors = false via env var
            const client = await createClientFn({ enableAddingActors: true, useEnv: true });
            const names = getToolNames(await client.listTools());
            expectToolNamesToContain(names, ['add-actor', 'get-actor-output']);

            await client.close();
        });

        it.runIf(options.transport === 'stdio')('should load tool categories from TOOLS environment variable', async () => {
            const categories = ['docs', 'runs'] as ToolCategory[];
            const client = await createClientFn({ tools: categories, useEnv: true });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedTools = [
                ...toolCategories.docs,
                ...toolCategories.runs,
            ];
            const expectedToolNames = expectedTools.map((tool) => tool.tool.name);

            expect(toolNames).toHaveLength(expectedToolNames.length);
            for (const expectedToolName of expectedToolNames) {
                expect(toolNames).toContain(expectedToolName);
            }

            await client.close();
        });

        it('should call rag-web-browser actor and retrieve metadata.title and crawl object from dataset', async () => {
            const client = await createClientFn({ tools: ['actors', 'storage'] });

            const callResult = await client.callTool({
                name: 'call-actor',
                arguments: {
                    actor: 'apify/rag-web-browser',
                    step: 'call',
                    input: { query: 'https://apify.com' },
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string; type: string }[];

            expect(content.length).toBe(2); // Call step returns text summary with embedded schema

            // First content: text summary
            const runText = content[0].text;

            // Extract datasetId from the text
            const runIdMatch = runText.match(/Run ID: ([^\n]+)\n• Dataset ID: ([^\n]+)/);
            expect(runIdMatch).toBeTruthy();
            const datasetId = runIdMatch![2];

            // Check for JSON schema in the text (in a code block)
            const schemaMatch = runText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            expect(schemaMatch).toBeTruthy();
            if (schemaMatch) {
                const schemaText = schemaMatch[1];
                const schema = JSON.parse(schemaText);
                expect(schema).toHaveProperty('type');
                expect(schema.type).toBe('object');
                expect(schema).toHaveProperty('properties');
                expect(schema.properties).toHaveProperty('metadata');
                expect(schema.properties.metadata).toHaveProperty('type', 'object');
                expect(schema.properties).toHaveProperty('crawl');
                expect(schema.properties.crawl).toHaveProperty('type', 'object');
            }

            const outputResult = await client.callTool({
                name: HelperTools.ACTOR_OUTPUT_GET,
                arguments: {
                    datasetId,
                    fields: 'metadata.title,crawl',
                },
            });

            expect(outputResult.content).toBeDefined();
            const outputContent = outputResult.content as { text: string; type: string }[];
            const output = JSON.parse(outputContent[0].text);
            expect(Array.isArray(output)).toBe(true);
            expect(output.length).toBeGreaterThan(0);
            expect(output[0]).toHaveProperty('metadata.title');
            expect(typeof output[0]['metadata.title']).toBe('string');
            expect(output[0]).toHaveProperty('crawl');
            expect(typeof output[0].crawl).toBe('object');

            await client.close();
        });

        it('should call apify/rag-web-browser tool directly and retrieve metadata.title from dataset', async () => {
            const client = await createClientFn({ actors: ['apify/rag-web-browser'] });

            // Call the dedicated apify-slash-rag-web-browser tool
            const result = await client.callTool({
                name: actorNameToToolName('apify/rag-web-browser'),
                arguments: { query: 'https://apify.com' },
            });

            // Validate the response has 1 content item with text summary and embedded schema
            expect(result.content).toBeDefined();
            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);
            const { text } = content[0];

            // Extract datasetId from the response text
            const runIdMatch = text.match(/Run ID: ([^\n]+)\n• Dataset ID: ([^\n]+)/);
            expect(runIdMatch).toBeTruthy();
            const datasetId = runIdMatch![2];

            // Check for JSON schema in the text (in a code block)
            const schemaMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            expect(schemaMatch).toBeTruthy();
            if (schemaMatch) {
                const schemaText = schemaMatch[1];
                const schema = JSON.parse(schemaText);
                expect(schema).toHaveProperty('type');
                expect(schema.type).toBe('object');
                expect(schema).toHaveProperty('properties');
                expect(schema.properties).toHaveProperty('metadata');
                expect(schema.properties.metadata).toHaveProperty('type', 'object');
                expect(schema.properties).toHaveProperty('crawl');
                expect(schema.properties.crawl).toHaveProperty('type', 'object');
            }

            // Call get-actor-output with fields: 'metadata.title'
            const outputResult = await client.callTool({
                name: HelperTools.ACTOR_OUTPUT_GET,
                arguments: {
                    datasetId,
                    fields: 'metadata.title',
                },
            });

            // Validate the output contains the expected structure with metadata.title
            expect(outputResult.content).toBeDefined();
            const outputContent = outputResult.content as { text: string; type: string }[];
            const output = JSON.parse(outputContent[0].text);
            expect(Array.isArray(output)).toBe(true);
            expect(output.length).toBeGreaterThan(0);
            expect(output[0]).toHaveProperty('metadata.title');
            expect(typeof output[0]['metadata.title']).toBe('string');

            await client.close();
        });
    });
}
