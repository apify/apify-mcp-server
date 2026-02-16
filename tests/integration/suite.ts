import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify-client.js';
import { CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG, defaults, HelperTools, RAG_WEB_BROWSER, SKYFIRE_ENABLED_TOOLS } from '../../src/const.js';
// Import tools from toolCategories instead of directly to avoid circular dependency during module initialization
import { defaultTools, toolCategories } from '../../src/tools/index.js';
import { callActorOutputSchema } from '../../src/tools/structured-output-schemas.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import type { ToolCategory, ToolEntry } from '../../src/types.js';
import { getExpectedToolNamesByCategories } from '../../src/utils/tool-categories-helpers.js';
import { ACTOR_MCP_SERVER_ACTOR_NAME, ACTOR_PYTHON_EXAMPLE, DEFAULT_ACTOR_NAMES, getDefaultToolNames } from '../const.js';
import { addActor, type McpClientOptions } from '../helpers.js';

// Helper to find tool by name from toolCategories (avoids circular dependency)
function findToolByName(name: string): ToolEntry | undefined {
    for (const tools of Object.values(toolCategories)) {
        const tool = tools.find((t) => t.name === name);
        if (tool) return tool;
    }
    return undefined;
}

type IntegrationTestsSuiteOptions = {
    suiteName: string;
    transport: 'sse' | 'streamable-http' | 'stdio';
    createClientFn: (options?: McpClientOptions) => Promise<Client>;
    beforeAllFn?: () => Promise<void>;
    afterAllFn?: () => Promise<void>;
    beforeEachFn?: () => Promise<void>;
    afterEachFn?: () => Promise<void>;
};

function getToolNames(tools: { tools: { name: string }[] }) {
    return tools.tools.map((tool) => tool.name);
}

function expectToolNamesToContain(names: string[], toolNames: string[] = []) {
    toolNames.forEach((name) => expect(names).toContain(name));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractJsonFromMarkdown(text: string): any {
    // Handle markdown code blocks like ```json
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
    }
    // If no markdown formatting, assume it's raw JSON
    return JSON.parse(text);
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
    const actual = content[0];
    expect(extractJsonFromMarkdown(actual.text)).toEqual(JSON.parse(expected.text));
    expect(actual.type).toBe(expected.type);
}

function validateStructuredOutput(
    result: unknown,
    toolOutputSchema: unknown,
    toolName: string,
): void {
    // Ensure result has structured content
    const resultWithStructured = result as Record<string, unknown>;
    if (!resultWithStructured.structuredContent) {
        return;
    }

    const { structuredContent } = resultWithStructured;

    // Verify tool has an outputSchema
    expect(toolOutputSchema).toBeDefined();

    if (toolOutputSchema) {
        // Create AJV validator instance
        const ajv = new Ajv();
        const validate = ajv.compile(toolOutputSchema as Record<string, unknown>);

        // Validate structured content against the schema
        const isValid = validate(structuredContent);

        if (!isValid) {
            // eslint-disable-next-line no-console
            console.error(`Validation errors for ${toolName}:`, validate.errors);
        }

        expect(isValid).toBe(true);
        expect(validate.errors).toBeNull();
    }
}

/**
 * Verify that structuredContent contains a non-empty readme and inputSchema.
 * Optionally checks actorInfo.fullName when expectedActorFullName is provided.
 */
function expectReadmeInStructuredContent(
    result: unknown,
    expectedActorFullName?: string,
): void {
    const r = result as { structuredContent?: { actorInfo?: { fullName?: string }; readme?: string; inputSchema?: unknown } };
    expect(r.structuredContent).toBeDefined();
    if (expectedActorFullName) {
        expect(r.structuredContent?.actorInfo?.fullName).toBe(expectedActorFullName);
    }
    expect(r.structuredContent?.readme).toBeDefined();
    expect(typeof r.structuredContent?.readme).toBe('string');
    expect(r.structuredContent!.readme!.length).toBeGreaterThan(0);
    expect(r.structuredContent?.inputSchema).toBeDefined();
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
        let client: Client | undefined;
        afterEach(async () => {
            await client?.close();
            client = undefined;
        });

        it('should list all default tools and Actors', async () => {
            client = await createClientFn();
            const tools = await client.listTools();
            expect(tools.tools.length).toEqual(defaultTools.length + defaults.actors.length + 2);

            const names = getToolNames(tools);
            expectToolNamesToContain(names, getDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expect(names).toContain(HelperTools.ACTOR_OUTPUT_GET);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);
            await client.close();
        });

        it('should match spec default: actors,docs,apify/rag-web-browser when no params provided', async () => {
            client = await createClientFn();
            const tools = await client.listTools();
            const names = getToolNames(tools);

            // Should be equivalent to tools=actors,docs,apify/rag-web-browser
            // Note: Internal tools (fetch-actor-details-internal, search-actors-internal) are only available in openai mode
            const expectedActorsTools = [
                'fetch-actor-details',
                'search-actors',
                'call-actor',
            ];
            const expectedDocsTools = ['search-apify-docs', 'fetch-apify-docs'];
            const expectedActors = ['apify-slash-rag-web-browser'];

            const expectedTotal = expectedActorsTools.concat(expectedDocsTools, expectedActors);
            expect(names).toHaveLength(expectedTotal.length + 2);

            expectToolNamesToContain(names, expectedActorsTools);
            expectToolNamesToContain(names, expectedDocsTools);
            expectToolNamesToContain(names, expectedActors);
            expect(names).toContain(HelperTools.ACTOR_OUTPUT_GET);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it('should list only add-actor when enableAddingActors is true and no tools/actors are specified', async () => {
            client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(2);
            expect(names).toContain('add-actor');
            expect(names).toContain('get-actor-output');
            await client.close();
        });

        it('should return outputSchema, title, and icons in tools list response', async () => {
            client = await createClientFn();
            const response = await client.listTools();

            // Find a tool with outputSchema (e.g., search-apify-docs)
            const searchApiifyDocsTool = response.tools.find((tool) => tool.name === 'search-apify-docs');
            expect(searchApiifyDocsTool).toBeDefined();

            // Verify that outputSchema is present
            expect(searchApiifyDocsTool?.outputSchema).toBeDefined();
            expect(typeof searchApiifyDocsTool?.outputSchema).toBe('object');
            expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('type');
            expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('properties');

            await client.close();
        });

        it('should list all default tools and Actors when enableAddingActors is false', async () => {
            client = await createClientFn({ enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + defaults.actors.length + 2);

            expectToolNamesToContain(names, getDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expect(names).toContain(HelperTools.ACTOR_OUTPUT_GET);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it('should override enableAddingActors false with experimental tool category', async () => {
            client = await createClientFn({ enableAddingActors: false, tools: ['experimental'] });

            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(2);
            expect(names).toContain('add-actor');
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should list two loaded Actors', async () => {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            client = await createClientFn({ actors, enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(actors.length + 1);
            expectToolNamesToContain(names, actors.map((actor) => actorNameToToolName(actor)));
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should load only specified actors when actors param is provided (no other tools)', async () => {
            const actors = ['apify/python-example'];
            client = await createClientFn({ actors });
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
        });

        it('should return tool with execution field when listing tools with apify/python-example', async () => {
            const actors = [ACTOR_PYTHON_EXAMPLE];
            client = await createClientFn({ tools: actors });
            const tools = await client.listTools();

            // Find the tool for apify/python-example
            const pythonExampleTool = tools.tools.find((tool) => tool.name === actorNameToToolName(ACTOR_PYTHON_EXAMPLE));
            expect(pythonExampleTool).toBeDefined();

            // Verify the tool contains the execution field (as returned by getToolPublicFieldOnly)
            expect(pythonExampleTool).toHaveProperty('execution');
            expect(pythonExampleTool?.execution).toBeDefined();

            // Verify other expected fields are present
            expect(pythonExampleTool).toHaveProperty('name');
            expect(pythonExampleTool).toHaveProperty('description');
            expect(pythonExampleTool).toHaveProperty('inputSchema');

            await client.close();
        });

        it('should not load any tools when enableAddingActors is true and tools param is empty', async () => {
            client = await createClientFn({ enableAddingActors: true, tools: [] });
            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(0);
        });

        it('should not load any tools when enableAddingActors is true and actors param is empty', async () => {
            client = await createClientFn({ enableAddingActors: true, actors: [] });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        });

        it('should not load any tools when enableAddingActors is false and no tools/actors are specified', async () => {
            client = await createClientFn({ enableAddingActors: false, tools: [], actors: [] });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        });

        it('should load only specified Actors via tools selectors when actors param omitted', async () => {
            const actors = ['apify/python-example'];
            client = await createClientFn({ tools: actors });
            const names = getToolNames(await client.listTools());
            // Only the Actor should be loaded
            expect(names).toHaveLength(actors.length + 1);
            expect(names).toContain(actorNameToToolName(actors[0]));
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should treat selectors with slashes as Actor names', async () => {
            client = await createClientFn({
                tools: ['docs', 'apify/python-example'],
            });
            const names = getToolNames(await client.listTools());

            // Should include docs category
            expect(names).toContain('search-apify-docs');
            expect(names).toContain('fetch-apify-docs');

            // Should include actor (if it exists/is valid)
            expect(names).toContain('apify-slash-python-example');
        });

        it('should merge actors param into tools selectors (backward compatibility)', async () => {
            const actors = ['apify/python-example'];
            const categories = ['docs'] as ToolCategory[];

            client = await createClientFn({ tools: categories, actors });

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
            client = await createClientFn({
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
        });

        it('should load only docs tools', async () => {
            const categories = ['docs'] as ToolCategory[];
            client = await createClientFn({ tools: categories, actors: [] });
            const names = getToolNames(await client.listTools());
            const expected = getExpectedToolNamesByCategories(categories);
            expect(names.length).toEqual(expected.length);
            expectToolNamesToContain(names, expected);
        });

        it('should load only a specific tool when tools includes a tool name', async () => {
            client = await createClientFn({ tools: ['fetch-actor-details'], actors: [] });
            const names = getToolNames(await client.listTools());
            expect(names).toEqual(['fetch-actor-details']);
        });

        it('should not load any tools when tools param is empty and actors omitted', async () => {
            client = await createClientFn({ tools: [] });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(0);
        });

        it('should not load any internal tools when tools param is empty and use custom Actor if specified', async () => {
            client = await createClientFn({ tools: [], actors: [ACTOR_PYTHON_EXAMPLE] });

            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(2);
            expect(names).toContain(actorNameToToolName(ACTOR_PYTHON_EXAMPLE));
            expect(names).toContain('get-actor-output');

            await client.close();
        });

        it('should add Actor dynamically and call it directly', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            client = await createClientFn({ enableAddingActors: true });
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
        });

        it('should call Actor dynamically via generic call-actor tool without need to add it first', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            client = await createClientFn({ enableAddingActors: true, tools: ['actors'] });
            const names = getToolNames(await client.listTools());
            // Only the actors category, get-actor-output, get-actor-run, and add-actor should be loaded
            const numberOfTools = toolCategories.actors.length + 3;
            expect(names).toHaveLength(numberOfTools);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);
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

            expect(content[0]).toEqual(
                {
                    text: JSON.stringify([{
                        first_number: 1,
                        second_number: 2,
                        sum: 3,
                    }]),
                    type: 'text',
                },
            );

            // Validate structured output has actual actor results
            const resultWithStructured = result as { structuredContent?: {
                 runId?: string;
                 datasetId?: string;
                 itemCount?: number;
                 items?: { first_number?: number; second_number?: number; sum?: number }[];
                 instructions?: string;
             } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.items).toBeDefined();
            expect(resultWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('sum', 3);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('first_number', 1);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('second_number', 2);
        });

        it('should call Actor directly with required input', async () => {
            client = await createClientFn({ tools: ['actors'] });

            // Should fail without input (AJV validation error)
            await expect(client!.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                },
            })).rejects.toThrow(/must have required property 'input'/);

            // Should succeed with input
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                },
            });
            expect(callResult.content).toBeDefined();
        });

        it('should support sync mode in call-actor (default behavior)', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    async: false,
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string }[];
            // Sync mode should return dataset items directly
            expect(content.some((item) => item.text.includes('Actor') && item.text.includes('completed successfully'))).toBe(true);
            expect(content.some((item) => item.text.includes('Dataset ID'))).toBe(true);

            // Validate structured output matches schema
            validateStructuredOutput(callResult, findToolByName(HelperTools.ACTOR_CALL)?.outputSchema, HelperTools.ACTOR_CALL);

            // Validate structured content has actual actor results
            const resultWithStructured = callResult as { structuredContent?: {
                 runId?: string;
                 datasetId?: string;
                 itemCount?: number;
                 items?: { first_number?: number; second_number?: number; sum?: number }[];
                 instructions?: string;
             } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.items).toBeDefined();
            expect(resultWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('sum', 3);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('first_number', 1);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('second_number', 2);

            // Validate _meta contains Apify usage cost information for completed sync runs
            const resultWithMeta = callResult as { _meta?: { apifyUsageTotalUsd?: number; apifyUsageUsd?: Record<string, number> } };
            expect(resultWithMeta._meta).toBeDefined();
            expect(typeof resultWithMeta._meta?.apifyUsageTotalUsd).toBe('number');
            expect(resultWithMeta._meta!.apifyUsageTotalUsd!).toBeGreaterThanOrEqual(0);
            expect(resultWithMeta._meta?.apifyUsageUsd).toBeDefined();
            expect(typeof resultWithMeta._meta?.apifyUsageUsd).toBe('object');
        });

        it('should support async mode in call-actor and return runId', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    async: true,
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string }[];
            // Async mode should return runId immediately
            expect(content.some((item) => item.text.includes('Run ID'))).toBe(true);

            // Check for structured content with runId
            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.runId).toBeDefined();
            expect(typeof resultWithStructured.structuredContent?.runId).toBe('string');

            // Validate structured output matches schema
            validateStructuredOutput(callResult, findToolByName(HelperTools.ACTOR_CALL)?.outputSchema, HelperTools.ACTOR_CALL);
        });

        it('should support sync mode in call-actor (default behavior)', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    step: 'call',
                    input: { first_number: 1, second_number: 2 },
                    async: false,
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string }[];
            // Sync mode should return dataset items directly
            expect(content.some((item) => item.text.includes('Actor') && item.text.includes('completed successfully'))).toBe(true);
            expect(content.some((item) => item.text.includes('Dataset ID'))).toBe(true);
        });

        it('should support async mode in call-actor and return runId', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    step: 'call',
                    input: { first_number: 1, second_number: 2 },
                    async: true,
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string }[];
            // Async mode should return runId immediately
            expect(content.some((item) => item.text.includes('Run ID'))).toBe(true);

            // Check for structured content with runId
            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.runId).toBeDefined();
            expect(typeof resultWithStructured.structuredContent?.runId).toBe('string');
        });

        it('should support previewOutput: false in call-actor and return metadata without preview items', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    previewOutput: false,
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string }[];

            // Should still have completion message with metadata
            expect(content.some((item) => item.text.includes('Actor') && item.text.includes('completed successfully'))).toBe(true);
            expect(content.some((item) => item.text.includes('Dataset ID'))).toBe(true);
            expect(content.some((item) => item.text.includes('Total items'))).toBe(true);

            // Should indicate preview was skipped
            expect(content.some((item) => item.text.includes('Preview skipped') || item.text.includes('previewOutput: false'))).toBe(true);

            // Should NOT have actual preview items JSON (the sum result)
            expect(content.some((item) => item.text.includes('"sum": 3') || item.text.includes('"sum":3'))).toBe(false);

            // Validate structured output matches schema
            validateStructuredOutput(callResult, findToolByName(HelperTools.ACTOR_CALL)?.outputSchema, HelperTools.ACTOR_CALL);

            // Validate structured content has empty items (preview disabled)
            const resultWithStructured = callResult as { structuredContent?: { items?: unknown[] } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.items).toEqual([]);
        });

        it('should return preview items by default in call-actor (previewOutput: true)', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    // previewOutput not specified, should default to true
                },
            });

            expect(callResult.content).toBeDefined();
            const content = callResult.content as { text: string }[];

            // Should have actual preview items with the sum result
            expect(content.some((item) => item.text.includes('"sum": 3') || item.text.includes('"sum":3'))).toBe(true);

            // Validate structured output matches schema
            validateStructuredOutput(callResult, findToolByName(HelperTools.ACTOR_CALL)?.outputSchema, HelperTools.ACTOR_CALL);

            // Validate structured content has actual actor results
            const resultWithStructured = callResult as { structuredContent?: {
                 runId?: string;
                 datasetId?: string;
                 itemCount?: number;
                 items?: { first_number?: number; second_number?: number; sum?: number }[];
                 instructions?: string;
             } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.items).toBeDefined();
            expect(resultWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('sum', 3);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('first_number', 1);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('second_number', 2);
        });

        it('should find Actors in store search', async () => {
            const query = 'python-example';
            client = await createClientFn({
                enableAddingActors: false,
            });

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH,
                arguments: {
                    keywords: query,
                    limit: 5,
                },
            });
            const content = result.content as { text: string }[];
            expect(content.some((item) => item.text.includes(ACTOR_PYTHON_EXAMPLE))).toBe(true);
        });

        // It should filter out all rental Actors only if we run locally or as standby, where
        // we cannot access MongoDB to get the user's rented Actors.
        // In case of apify-mcp-server it should include user's rented Actors.
        it('should filter out all rental Actors from store search', async () => {
            client = await createClientFn();

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH,
                arguments: {
                    keywords: 'rental',
                    limit: 100,
                },
            });
            const content = result.content as { text: string }[];
            expect(content.length).toBe(1);
            const outputText = content[0].text;

            // Check to ensure that the output string format remains the same.
            // If someone changes the output format, this test may stop working
            // without actually failing.
            expect(outputText).toContain('This Actor');
            // Check that no rental Actors are present
            expect(outputText).not.toContain('This Actor is rental');
        });

        it('should notify client about tool list changed', async () => {
            client = await createClientFn({ enableAddingActors: true });

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
        });

        it('should return no tools were added when adding a non-existent actor', async () => {
            client = await createClientFn({ enableAddingActors: true });
            const nonExistentActor = 'apify/this-actor-does-not-exist';
            const result = await client.callTool({
                name: HelperTools.ACTOR_ADD,
                arguments: { actor: nonExistentActor },
            });
            expect(result).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain('no tools were added');
        });

        it('should be able to add and call Actorized MCP server', async () => {
            client = await createClientFn({ enableAddingActors: true });

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
                    keywords: ACTOR_MCP_SERVER_ACTOR_NAME,
                    limit: 1,
                },
            });
            expect(result.content).toBeDefined();
        });

        it('should call MCP server Actor via call-actor and invoke fetch-apify-docs tool', async () => {
            client = await createClientFn({ tools: ['actors'] });

            // Step 1: Get MCP tools using fetch-actor-details
            const detailsResult = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_MCP_SERVER_ACTOR_NAME,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: true,
                    },
                },
            });

            expect(detailsResult.content).toBeDefined();
            const detailsContent = detailsResult.content as { text: string }[];
            expect(detailsContent.some((item) => item.text.includes('fetch-apify-docs'))).toBe(true);

            // Step 2: call - invoke the MCP tool fetch-apify-docs via actor:tool syntax
            const DOCS_URL = 'https://docs.apify.com';
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: `${ACTOR_MCP_SERVER_ACTOR_NAME}:fetch-apify-docs`,
                    input: { url: DOCS_URL },
                },
            });

            expect(callResult.content).toBeDefined();
            const callContent = callResult.content as { text: string }[];
            expect(callContent.some((item) => item.text.includes(`Fetched content from ${DOCS_URL}`))).toBe(true);
        });

        it('should search Apify documentation', async () => {
            client = await createClientFn({
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
        });

        it('should fetch Apify documentation page', async () => {
            client = await createClientFn({
                tools: ['docs'],
            });

            const documentUrl = 'https://docs.apify.com/academy/getting-started/creating-actors';
            const result = await client.callTool({
                name: HelperTools.DOCS_FETCH,
                arguments: {
                    url: documentUrl,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(documentUrl);
        });

        it('should reject fetch-apify-docs with forbidden URL (not from allowed domains)', async () => {
            client = await createClientFn({
                tools: ['docs'],
            });

            const forbiddenUrl = 'https://example.com/some-page';
            const result = await client.callTool({
                name: HelperTools.DOCS_FETCH,
                arguments: {
                    url: forbiddenUrl,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);
            // Verify it's an error response
            expect(result.isError).toBe(true);
            // Verify the error message contains helpful information
            expect(content[0].text).toContain('Invalid URL');
            expect(content[0].text).toContain('https://docs.apify.com');
            expect(content[0].text).toContain('https://crawlee.dev');
        });

        it('should allow fetch-apify-docs from Crawlee domain (https://crawlee.dev)', async () => {
            client = await createClientFn({
                tools: ['docs'],
            });

            const crawleeDocsUrl = 'https://crawlee.dev/js/docs/quick-start';
            const result = await client.callTool({
                name: HelperTools.DOCS_FETCH,
                arguments: {
                    url: crawleeDocsUrl,
                },
            });

            // Should not have error status
            expect(result.isError).not.toBe(true);
            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            // Verify the response contains the URL we fetched
            expect(content[0].text).toContain('Fetched content from');
        });

        it('should return structured output for search-apify-docs matching outputSchema', async () => {
            client = await createClientFn({
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
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutput(result, findToolByName(HelperTools.DOCS_SEARCH)?.outputSchema, toolName);
        });

        it('should return structured output for fetch-actor-details matching outputSchema', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });
            const toolName = HelperTools.ACTOR_GET_DETAILS;

            const result = await client.callTool({
                name: toolName,
                arguments: {
                    actor: RAG_WEB_BROWSER,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, toolName);
        });

        it('should return only input schema when output={ inputSchema: true }', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: true,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            // Should contain schema but NOT readme or actor card
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(true);
            expect(content.some((item) => item.text.includes('README'))).toBe(false);
        });

        it('should return only description and stats when specified', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: true,
                        stats: true,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            // Should contain actor info but NOT readme or schema
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(true);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(false);
        });

        it('should list MCP tools when output={ mcpTools: true } for MCP server Actor', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_MCP_SERVER_ACTOR_NAME,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: true,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.some((item) => item.text.includes('Available MCP Tools'))).toBe(true);
            expect(content.some((item) => item.text.includes('fetch-apify-docs'))).toBe(true);
        });

        it('should return graceful note when output={ mcpTools: true } for regular Actor', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: true,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            expect(content.some((item) => item.text.includes('This Actor is not an MCP server'))).toBe(true);
        });

        it('should return structured output for fetch-actor-details with selective output matching outputSchema', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });
            const toolName = HelperTools.ACTOR_GET_DETAILS;

            // Test with output={ mcpTools: true } - should validate against schema even with selective fields
            const result = await client.callTool({
                name: toolName,
                arguments: {
                    actor: ACTOR_MCP_SERVER_ACTOR_NAME,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: true,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            // This should validate successfully - structured output must match schema
            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, toolName);
        });

        it('should return structured output for fetch-actor-details with output={ description: true, readme: true } matching outputSchema', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });
            const toolName = HelperTools.ACTOR_GET_DETAILS;

            // Test with output={ description: true, readme: true } - inputSchema should be undefined
            const result = await client.callTool({
                name: toolName,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: true,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: true,
                        mcpTools: false,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            // This should validate successfully - structured output must match schema
            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, toolName);
        });

        it('should return only pricing when output={ pricing: true }', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: false,
                        stats: false,
                        pricing: true,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            // Should contain actor info (pricing is part of actor card) but NOT readme or schema
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(true);
            expect(content.some((item) => item.text.includes('README'))).toBe(false);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(false);

            // Validate structured output
            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
        });

        it('should return only readme when output={ readme: true }', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: true,
                        mcpTools: false,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            // Should contain readme text but NOT actor info card or input schema
            expect(content.length).toBeGreaterThan(0);
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(false);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(false);

            // Validate structured output
            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
        });

        it('should return README content (summary or full) in text and structured response for fetch-actor-details', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: 'fetch-actor-details',
                arguments: {
                    actor: RAG_WEB_BROWSER,
                    output: {
                        description: true,
                        readme: true,
                        inputSchema: true,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            const allText = content.map((item) => item.text).join('\n');

            // Text should contain actor card, README section (summary or full fallback), and input schema
            expect(allText).toContain('Actor information');
            expect(allText).toMatch(/# README summary|# README/);
            expect(allText).toContain('Input schema');

            expectReadmeInStructuredContent(result, RAG_WEB_BROWSER);

            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, 'fetch-actor-details');
        });

        it('should return README content via fetch-actor-details-internal in openai mode', async () => {
            client = await createClientFn({
                tools: ['actors'],
                uiMode: 'openai',
            });

            // fetch-actor-details-internal is openaiOnly, so we need openai mode to access it
            const result = await client.callTool({
                name: 'fetch-actor-details-internal',
                arguments: {
                    actor: RAG_WEB_BROWSER,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            const allText = content.map((item) => item.text).join('\n');

            // Default output includes README content and input schema
            expect(allText).toMatch(/# README summary|# README/);
            expect(allText).toContain('Input schema');

            expectReadmeInStructuredContent(result);
        });

        it('should use default values when output object is not provided', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            // When output is not provided, all fields should default to their default values
            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            // Should contain all default sections (description, stats, pricing, rating, metadata, readme, inputSchema)
            // but NOT mcpTools (which defaults to false)
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(true);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(true);
            expect(content.some((item) => item.text.includes('Available MCP Tools'))).toBe(false);
        });

        it('should return all fields when output includes all standard options', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: true,
                        stats: true,
                        pricing: true,
                        rating: false,
                        metadata: false,
                        inputSchema: true,
                        readme: true,
                        mcpTools: false,
                    },
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];

            // Should contain all sections in text
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(true);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(true);

            // Validate structured output exists and has all fields
            const resultWithStructured = result as { structuredContent?: { actorInfo?: unknown; inputSchema?: unknown } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.actorInfo).toBeDefined();
            expect(resultWithStructured.structuredContent?.inputSchema).toBeDefined();

            // Validate against schema
            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
        });

        it('should support granular output controls for rating and metadata', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            // Test 1: Only pricing (should include pricing, NOT other sections)
            const pricingOnlyResult = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: false,
                        stats: false,
                        pricing: true,
                        rating: false,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            const pricingContent = pricingOnlyResult.content as { text: string }[];
            const pricingText = pricingContent.map((item) => item.text).join('\n');
            // Should include actor card header and pricing
            expect(pricingText).toContain('Actor information');
            expect(pricingText).toContain('Pricing');
            // Should NOT include other sections
            expect(pricingText).not.toContain('Description:');
            expect(pricingText).not.toContain('Stats:');
            expect(pricingText).not.toContain('Rating:');
            expect(pricingText).not.toContain('Developed by:');
            expect(pricingText).not.toContain('Categories:');
            expect(pricingText).not.toContain('Last modified:');
            expect(pricingText).not.toContain('README');

            // Test 2: Only rating (should include rating for apify/rag-web-browser which has rating in stats)
            const ragWebBrowser = 'apify/rag-web-browser';
            const ratingOnlyResult = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ragWebBrowser,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: true,
                        metadata: false,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            const ratingContent = ratingOnlyResult.content as { text: string }[];
            const ratingText = ratingContent.map((item) => item.text).join('\n');
            // Should include actor card header and rating
            expect(ratingText).toContain('Actor information');
            expect(ratingText).toContain('Rating:');
            // Should NOT include other sections
            expect(ratingText).not.toContain('Description:');
            expect(ratingText).not.toContain('Stats:');
            expect(ratingText).not.toContain('Pricing');
            expect(ratingText).not.toContain('Developed by:');
            expect(ratingText).not.toContain('Categories:');
            expect(ratingText).not.toContain('Last modified:');
            expect(ratingText).not.toContain('README');

            // Test 3: Only metadata (should include developer, categories, last modified, deprecation status)
            const metadataOnlyResult = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    output: {
                        description: false,
                        stats: false,
                        pricing: false,
                        rating: false,
                        metadata: true,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            const metadataContent = metadataOnlyResult.content as { text: string }[];
            const metadataText = metadataContent.map((item) => item.text).join('\n');
            // Should include developer, categories, and last modified date
            expect(metadataText).toContain('Developed by:');
            expect(metadataText).toContain('Categories:');
            expect(metadataText).toContain('Last modified:');
            // Should NOT include other sections
            expect(metadataText).not.toContain('Description:');
            expect(metadataText).not.toContain('Stats:');
            expect(metadataText).not.toContain('Pricing');
            expect(metadataText).not.toContain('Rating:');
            expect(metadataText).not.toContain('README');

            // Test 4: Combination - pricing + rating + metadata (should exclude description, stats, readme, input-schema)
            const combinationResult = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ragWebBrowser,
                    output: {
                        description: false,
                        stats: false,
                        pricing: true,
                        rating: true,
                        metadata: true,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            const combinationContent = combinationResult.content as { text: string }[];
            const combinationText = combinationContent.map((item) => item.text).join('\n');
            // Should include: pricing, rating, metadata (developer, categories, last modified)
            expect(combinationText).toContain('Pricing');
            expect(combinationText).toContain('Rating:');
            expect(combinationText).toContain('Developed by:');
            expect(combinationText).toContain('Categories:');
            expect(combinationText).toContain('Last modified:');
            // Should NOT include: description, stats, readme, input-schema
            expect(combinationText).not.toContain('Description:');
            expect(combinationText).not.toContain('Stats:');
            expect(combinationText).not.toContain('README');
            expect(combinationText).not.toContain('Input schema');

            // Validate structured output for all test cases
            validateStructuredOutput(pricingOnlyResult, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
            validateStructuredOutput(ratingOnlyResult, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
            validateStructuredOutput(metadataOnlyResult, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
            validateStructuredOutput(combinationResult, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
        });

        it('should dynamically test all output options and verify section presence/absence', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });

            // Use apify/rag-web-browser which has all sections (description, stats, pricing, rating, metadata)
            const testActor = 'apify/rag-web-browser';

            // Define all output options with their expected markers in text
            const outputOptions = [
                {
                    name: 'description',
                    field: 'description',
                    markers: ['Description:'],
                    notMarkers: ['Developed by:', 'Categories:', 'Stats:', 'Pricing', 'Rating:', 'Last modified:', 'README', 'Input schema'],
                },
                {
                    name: 'stats',
                    field: 'stats',
                    markers: ['Stats:', 'total users', 'monthly users'],
                    notMarkers: ['Developed by:', 'Categories:', 'Description:', 'Pricing', 'Rating:', 'Last modified:', 'README', 'Input schema'],
                },
                {
                    name: 'pricing',
                    field: 'pricing',
                    markers: ['Pricing'],
                    notMarkers: ['Developed by:', 'Categories:', 'Description:', 'Stats:', 'Rating:', 'Last modified:', 'README', 'Input schema'],
                },
                {
                    name: 'rating',
                    field: 'rating',
                    markers: ['Rating:', 'out of 5'],
                    notMarkers: ['Developed by:', 'Categories:', 'Description:', 'Stats:', 'Pricing', 'Last modified:', 'README', 'Input schema'],
                },
                {
                    name: 'metadata',
                    field: 'metadata',
                    markers: ['Developed by:', 'Categories:', 'Last modified:'],
                    notMarkers: ['Description:', 'Stats:', 'Pricing', 'Rating:', 'README', 'Input schema'],
                },
                {
                    name: 'input-schema',
                    field: 'inputSchema',
                    markers: ['Input schema', '```json'],
                    notMarkers: ['Developed by:', 'Description:', 'Stats:', 'Pricing', 'Rating:', 'Last modified:', 'README'],
                },
                {
                    name: 'readme',
                    field: 'readme',
                    markers: [],
                    notMarkers: ['Input schema'],
                },
            ] as const;

            // Test each output option individually
            for (const option of outputOptions) {
                const result = await client.callTool({
                    name: HelperTools.ACTOR_GET_DETAILS,
                    arguments: {
                        actor: testActor,
                        output: {
                            description: option.field === 'description',
                            stats: option.field === 'stats',
                            pricing: option.field === 'pricing',
                            rating: option.field === 'rating',
                            metadata: option.field === 'metadata',
                            inputSchema: option.field === 'inputSchema',
                            readme: option.field === 'readme',
                            mcpTools: false,
                        },
                    },
                });

                const content = result.content as { text: string }[];
                const text = content.map((item) => item.text).join('\n');

                // Verify expected markers are present
                for (const marker of option.markers) {
                    expect(text, `output=${option.name} should contain "${marker}"`).toContain(marker);
                }

                // Verify unwanted markers are absent
                for (const notMarker of option.notMarkers) {
                    expect(text, `output=${option.name} should NOT contain "${notMarker}"`).not.toContain(notMarker);
                }

                // Validate structured output
                validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
            }

            // Test a combination: all actor card sections (description, stats, pricing, rating, metadata)
            const allCardSectionsResult = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: testActor,
                    output: {
                        description: true,
                        stats: true,
                        pricing: true,
                        rating: true,
                        metadata: true,
                        inputSchema: false,
                        readme: false,
                        mcpTools: false,
                    },
                },
            });

            const allCardContent = allCardSectionsResult.content as { text: string }[];
            const allCardText = allCardContent.map((item) => item.text).join('\n');

            // Should include all actor card sections
            expect(allCardText).toContain('Description:');
            expect(allCardText).toContain('Stats:');
            expect(allCardText).toContain('Pricing');
            expect(allCardText).toContain('Rating:');
            expect(allCardText).toContain('Developed by:');
            expect(allCardText).toContain('Categories:');
            expect(allCardText).toContain('Last modified:');

            // Should NOT include readme or input-schema
            expect(allCardText).not.toContain('README');
            expect(allCardText).not.toContain('Input schema');

            validateStructuredOutput(allCardSectionsResult, findToolByName(HelperTools.ACTOR_GET_DETAILS)?.outputSchema, HelperTools.ACTOR_GET_DETAILS);
        });

        it('should return structured output for search-actors matching outputSchema', async () => {
            client = await createClientFn({
                tools: ['actors'],
            });
            const toolName = HelperTools.STORE_SEARCH;

            const result = await client.callTool({
                name: toolName,
                arguments: {
                    keywords: 'rag web browser',
                    limit: 5,
                    offset: 0,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutput(result, findToolByName(HelperTools.STORE_SEARCH)?.outputSchema, toolName);
        });

        it('should return structured output for fetch-apify-docs matching outputSchema', async () => {
            client = await createClientFn({
                tools: ['docs'],
            });
            const toolName = HelperTools.DOCS_FETCH;

            const result = await client.callTool({
                name: toolName,
                arguments: {
                    url: 'https://docs.apify.com/platform/actors/development',
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutput(result, findToolByName(HelperTools.DOCS_FETCH)?.outputSchema, toolName);
        });

        it.for(Object.keys(toolCategories))('should load correct tools for %s category', async (category) => {
            client = await createClientFn({
                tools: [category as ToolCategory],
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedToolNames = getExpectedToolNamesByCategories([category as ToolCategory]);
            // Only assert that all tools from the selected category are present.
            // Note: UI category tools are only loaded in openai mode, so they won't be present in default mode
            for (const expectedToolName of expectedToolNames) {
                if (category !== 'ui') {
                    expect(toolNames).toContain(expectedToolName);
                }
            }
        });

        it('should include add-actor when experimental category is selected even if enableAddingActors is false', async () => {
            client = await createClientFn({
                enableAddingActors: false,
                tools: ['experimental'],
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            expect(toolNames).toContain(HelperTools.ACTOR_ADD);
        });

        it('should include add-actor when enableAddingActors is false and add-actor is selected directly', async () => {
            client = await createClientFn({
                enableAddingActors: false,
                tools: [HelperTools.ACTOR_ADD],
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            // Must include add-actor since it was selected directly
            expect(toolNames).toContain(HelperTools.ACTOR_ADD);
        });

        it('should handle multiple tool category keys input correctly', async () => {
            const categories = ['docs', 'runs', 'storage'] as ToolCategory[];
            client = await createClientFn({
                tools: categories,
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedToolNames = getExpectedToolNamesByCategories(categories);
            expect(toolNames).toHaveLength(expectedToolNames.length);
            const containsExpectedTools = toolNames.every((name) => expectedToolNames.includes(name));
            expect(containsExpectedTools).toBe(true);
        });

        it('should list all prompts', async () => {
            client = await createClientFn();
            const prompts = await client.listPrompts();
            expect(prompts.prompts.length).toBeGreaterThan(0);
        });

        it('should be able to get prompt by name', async () => {
            client = await createClientFn();

            const topic = 'apify';
            const prompt = await client.getPrompt({
                name: 'GetLatestNewsOnTopic',
                arguments: {
                    topic,
                },
            });

            const message = prompt.messages[0];
            expect(message).toBeDefined();
            expect(message.content).toBeDefined();
            expect(message.content.type).toBe('text');
            // So typescript is happy
            if (message.content.type === 'text') {
                expect(message.content.text).toContain(topic);
            }
        });

        // Session termination is only possible for streamable HTTP transport.
        it.runIf(options.transport === 'streamable-http')('should successfully terminate streamable session', async () => {
            client = await createClientFn();
            await client.listTools();
            await (client.transport as StreamableHTTPClientTransport).terminateSession();
        });

        // Cancellation test: start a long-running actor and cancel immediately, then verify it was aborted
        // Is not possible to run this test in parallel
        it.runIf(options.transport === 'streamable-http')('should abort actor run on notifications/cancelled', async () => {
            const ACTOR_NAME = 'apify/rag-web-browser';
            const selectedToolName = actorNameToToolName(ACTOR_NAME);
            client = await createClientFn({ enableAddingActors: true });

            // Add actor as tool
            await addActor(client, ACTOR_NAME);

            // Build request and cancel immediately via AbortController
            const controller = new AbortController();

            const requestPromise = client.request({
                method: 'tools/call' as const,
                params: {
                    name: selectedToolName,
                    arguments: { query: 'restaurants in San Francisco', maxResults: 10 },
                },
            }, CallToolResultSchema, { signal: controller.signal })
                // Ignores error "AbortError: This operation was aborted"
                .catch(() => undefined);

            // Abort right away
            setTimeout(() => controller.abort(), 3000);

            // Ensure the request completes/cancels before proceeding
            await requestPromise;

            // Verify via Apify API that a recent run for this actor was aborted
            const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
            const actor = await api.actor(ACTOR_NAME).get();
            expect(actor).toBeDefined();
            const actId = actor!.id as string;

            // Poll up to 30s for the latest run for this actor to reach ABORTED/ABORTING
            await vi.waitUntil(async () => {
                const runsList = await api.runs().list({ limit: 5, desc: true });
                const run = runsList.items.find((r) => r.actId === actId);
                if (run) {
                    return run.status === 'ABORTED' || run.status === 'ABORTING';
                }
                return false;
            }, { timeout: 10000, interval: 500 });
        });

        // Cancellation test using call-actor tool: start a long-running actor via call-actor and cancel immediately, then verify it was aborted
        it.runIf(options.transport === 'streamable-http')('should abort call-actor tool on notifications/cancelled', async () => {
            const ACTOR_NAME = 'apify/rag-web-browser';
            client = await createClientFn({ tools: ['actors'] });

            // Build request and cancel immediately via AbortController
            const controller = new AbortController();

            const requestPromise = client.request({
                method: 'tools/call' as const,
                params: {
                    name: HelperTools.ACTOR_CALL,
                    arguments: {
                        actor: ACTOR_NAME,
                        step: 'call',
                        input: { query: 'restaurants in San Francisco', maxResults: 10 },
                    },
                },
            }, CallToolResultSchema, { signal: controller.signal })
                // Ignores error "AbortError: This operation was aborted"
                .catch(() => undefined);

            // Abort right away
            setTimeout(() => controller.abort(), 3000);

            // Ensure the request completes/cancels before proceeding
            await requestPromise;

            // Verify via Apify API that a recent run for this actor was aborted
            const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
            const actor = await api.actor(ACTOR_NAME).get();
            expect(actor).toBeDefined();
            const actId = actor!.id as string;

            // Poll up to 30s for the latest run for this actor to reach ABORTED/ABORTING
            await vi.waitUntil(async () => {
                const runsList = await api.runs().list({ limit: 5, desc: true });
                const run = runsList.items.find((r) => r.actId === actId);
                if (run) {
                    return run.status === 'ABORTED' || run.status === 'ABORTING';
                }
                return false;
            }, { timeout: 10000, interval: 500 });
        });

        // Environment variable tests - only applicable to stdio transport
        it.runIf(options.transport === 'stdio')('should load actors from ACTORS environment variable', async () => {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            client = await createClientFn({ actors, useEnv: true });
            const names = getToolNames(await client.listTools());
            expectToolNamesToContain(names, actors.map((actor) => actorNameToToolName(actor)));
        });

        it.runIf(options.transport === 'stdio')('should respect ENABLE_ADDING_ACTORS environment variable', async () => {
            // Test with enableAddingActors = false via env var
            client = await createClientFn({ enableAddingActors: false, useEnv: true });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(defaultTools.length + defaults.actors.length + 2);

            expectToolNamesToContain(names, getDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expect(names).toContain(HelperTools.ACTOR_OUTPUT_GET);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it.runIf(options.transport === 'stdio')('should respect ENABLE_ADDING_ACTORS environment variable and load only add-actor tool when true', async () => {
            // Test with enableAddingActors = false via env var
            client = await createClientFn({ enableAddingActors: true, useEnv: true });
            const names = getToolNames(await client.listTools());
            expectToolNamesToContain(names, ['add-actor', 'get-actor-output']);

            await client.close();
        });

        it.runIf(options.transport === 'stdio')('should load tool categories from TOOLS environment variable', async () => {
            const categories = ['docs', 'runs'] as ToolCategory[];
            client = await createClientFn({ tools: categories, useEnv: true });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedTools = [
                ...toolCategories.docs,
                ...toolCategories.runs,
            ];
            const expectedToolNames = expectedTools.map((tool) => tool.name);

            expect(toolNames).toHaveLength(expectedToolNames.length);
            for (const expectedToolName of expectedToolNames) {
                expect(toolNames).toContain(expectedToolName);
            }
        });

        it('should call rag-web-browser actor and retrieve metadata.title and crawl object from dataset', async () => {
            client = await createClientFn({ tools: ['actors', 'storage'] });

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
            const runText = content[1].text;

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
            const output = extractJsonFromMarkdown(outputContent[0].text);
            expect(Array.isArray(output)).toBe(true);
            expect(output.length).toBeGreaterThan(0);
            expect(output[0]).toHaveProperty('metadata.title');
            expect(typeof output[0]['metadata.title']).toBe('string');
            expect(output[0]).toHaveProperty('crawl');
            expect(typeof output[0].crawl).toBe('object');

            await client.close();
        });

        it('should call apify/rag-web-browser tool directly and retrieve metadata.title from dataset', async () => {
            client = await createClientFn({ actors: ['apify/rag-web-browser'] });

            // Call the dedicated apify-slash-rag-web-browser tool
            const result = await client.callTool({
                name: actorNameToToolName('apify/rag-web-browser'),
                arguments: { query: 'https://apify.com' },
            });

            // Validate the response has 1 content item with text summary and embedded schema
            expect(result.content).toBeDefined();
            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);
            const { text } = content[1];

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
            const output = extractJsonFromMarkdown(outputContent[0].text);
            expect(Array.isArray(output)).toBe(true);
            expect(output.length).toBeGreaterThan(0);
            expect(output[0]).toHaveProperty('metadata.title');
            expect(typeof output[0]['metadata.title']).toBe('string');

            // Validate structured output for direct actor tool call
            const ragWebBrowserToolName = actorNameToToolName('apify/rag-web-browser');
            // Use imported callActorOutputSchema directly because direct Actor tools are dynamic and not in static toolCategories
            validateStructuredOutput(result, callActorOutputSchema, ragWebBrowserToolName);

            // Validate structured content has items with metadata and crawl
            const resultWithStructured = result as { structuredContent?: {
                 runId?: string;
                 datasetId?: string;
                 itemCount?: number;
                 items?: { metadata?: { title?: string }; crawl?: object }[];
                 instructions?: string;
             } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.items).toBeDefined();
            expect(resultWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('metadata');
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('crawl');

            // Validate structured output for get-actor-output
            validateStructuredOutput(outputResult, findToolByName(HelperTools.ACTOR_OUTPUT_GET)?.outputSchema, HelperTools.ACTOR_OUTPUT_GET);

            await client.close();
        });

        it('should call apify/python-example and retrieve the full dataset using get-actor-output tool', async () => {
            client = await createClientFn({ actors: ['apify/python-example'] });
            const selectedToolName = actorNameToToolName('apify/python-example');
            const input = { first_number: 5, second_number: 7 };

            const result = await client.callTool({
                name: selectedToolName,
                arguments: input,
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2); // Call step returns text summary with embedded schema

            // First content: text summary
            const runText = content[1].text;

            // Extract datasetId from the text
            const runIdMatch = runText.match(/Run ID: ([^\n]+)\n• Dataset ID: ([^\n]+)/);
            expect(runIdMatch).toBeTruthy();
            const datasetId = runIdMatch![2];

            // Retrieve full dataset using get-actor-output tool
            const outputResult = await client.callTool({
                name: HelperTools.ACTOR_OUTPUT_GET,
                arguments: {
                    datasetId,
                },
            });

            expect(outputResult.content).toBeDefined();
            const outputContent = outputResult.content as { text: string; type: string }[];
            const output = extractJsonFromMarkdown(outputContent[0].text);
            expect(Array.isArray(output)).toBe(true);
            expect(output.length).toBe(1);
            expect(output[0]).toHaveProperty('first_number', input.first_number);
            expect(output[0]).toHaveProperty('second_number', input.second_number);
            expect(output[0]).toHaveProperty('sum', input.first_number + input.second_number);

            // Validate structured output for direct actor tool
            // Use imported callActorOutputSchema directly because direct Actor tools are dynamic and not in static toolCategories
            validateStructuredOutput(result, callActorOutputSchema, selectedToolName);

            // Validate structured content has actual actor results with sum
            const resultWithStructured = result as { structuredContent?: {
                 runId?: string;
                 datasetId?: string;
                 itemCount?: number;
                 items?: { first_number?: number; second_number?: number; sum?: number }[];
                 instructions?: string;
             } };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.items).toBeDefined();
            expect(resultWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('sum', 12);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('first_number', 5);
            expect(resultWithStructured.structuredContent?.items?.[0]).toHaveProperty('second_number', 7);

            // Validate _meta contains Apify usage cost information for direct actor tool calls
            const resultWithMeta = result as { _meta?: { apifyUsageTotalUsd?: number; apifyUsageUsd?: Record<string, number> } };
            expect(resultWithMeta._meta).toBeDefined();
            expect(typeof resultWithMeta._meta?.apifyUsageTotalUsd).toBe('number');
            expect(resultWithMeta._meta!.apifyUsageTotalUsd!).toBeGreaterThanOrEqual(0);
            expect(resultWithMeta._meta?.apifyUsageUsd).toBeDefined();
            expect(typeof resultWithMeta._meta?.apifyUsageUsd).toBe('object');

            // Validate structured output for get-actor-output
            validateStructuredOutput(outputResult, findToolByName(HelperTools.ACTOR_OUTPUT_GET)?.outputSchema, HelperTools.ACTOR_OUTPUT_GET);
        });

        it('should return structured output for get-actor-run matching outputSchema', async () => {
            client = await createClientFn({ tools: ['actors', 'runs'] });

            // First, start an async actor run to get a runId
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    async: true,
                },
            });

            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            expect(resultWithStructured.structuredContent?.runId).toBeDefined();
            const runId = resultWithStructured.structuredContent!.runId!;

            // Now test get-actor-run
            const runResult = await client.callTool({
                name: HelperTools.ACTOR_RUNS_GET,
                arguments: { runId },
            });

            expect(runResult.content).toBeDefined();
            // Validate structured output for get-actor-run
            validateStructuredOutput(runResult, findToolByName(HelperTools.ACTOR_RUNS_GET)?.outputSchema, HelperTools.ACTOR_RUNS_GET);
        });

        it('should return Actor details both for full Actor name and ID', async () => {
            const actorName = 'apify/python-example';
            const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
            const actor = await apifyClient.actor(actorName).get();
            expect(actor).toBeDefined();
            const actorId = actor!.id as string;

            client = await createClientFn();

            // Fetch by full Actor name
            const resultByName = await client.callTool({
                name: 'fetch-actor-details',
                arguments: { actor: actorName },
            });
            expect(resultByName.content).toBeDefined();
            const contentByName = resultByName.content as { text: string }[];
            expect(contentByName[0].text).toContain(actorName);

            // Fetch by Actor ID only
            const resultById = await client.callTool({
                name: 'fetch-actor-details',
                arguments: { actor: actorId },
            });
            expect(resultById.content).toBeDefined();
            const contentById = resultById.content as { text: string }[];
            expect(contentById[0].text).toContain(actorName);

            await client.close();
        });

        it('should return structured output for get-dataset-items matching outputSchema', async () => {
            client = await createClientFn({ tools: ['actors', 'storage'] });

            // First, run an actor to get a datasetId
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 3, second_number: 4 },
                    async: false,
                },
            });

            const resultWithStructured = callResult as { structuredContent?: { datasetId?: string } };
            expect(resultWithStructured.structuredContent?.datasetId).toBeDefined();
            const datasetId = resultWithStructured.structuredContent!.datasetId!;

            // Now test get-dataset-items
            const datasetResult = await client.callTool({
                name: HelperTools.DATASET_GET_ITEMS,
                arguments: { datasetId },
            });

            expect(datasetResult.content).toBeDefined();
            // Validate structured output for get-dataset-items
            validateStructuredOutput(datasetResult, findToolByName(HelperTools.DATASET_GET_ITEMS)?.outputSchema, HelperTools.DATASET_GET_ITEMS);

            // Validate structured content has items with actual results
            const datasetWithStructured = datasetResult as { structuredContent?: {
                 datasetId?: string;
                 items?: { first_number?: number; second_number?: number; sum?: number }[];
                 itemCount?: number;
                 totalItemCount?: number;
                 offset?: number;
                 limit?: number;
             } };
            expect(datasetWithStructured.structuredContent).toBeDefined();
            expect(datasetWithStructured.structuredContent?.items).toBeDefined();
            expect(datasetWithStructured.structuredContent?.items?.length).toBeGreaterThan(0);
            expect(datasetWithStructured.structuredContent?.items?.[0]).toHaveProperty('sum', 7);
            expect(datasetWithStructured.structuredContent?.items?.[0]).toHaveProperty('first_number', 3);
            expect(datasetWithStructured.structuredContent?.items?.[0]).toHaveProperty('second_number', 4);
        });

        it('should connect to MCP server and at least one tool is available', async () => {
            client = await createClientFn({ tools: [ACTOR_MCP_SERVER_ACTOR_NAME] });
            const tools = await client.listTools();
            expect(tools.tools.length).toBeGreaterThan(0);
        });

        //  TEMP: this logic is currently disabled, see src/utils/tools-loader.ts
        // it.runIf(options.transport === 'streamable-http')('should swap call-actor for add-actor when client supports dynamic tools', async () => {
        //     client = await createClientFn({ clientName: 'Visual Studio Code', tools: ['actors'] });
        //     const names = getToolNames(await client.listTools());

        //     // should not contain call-actor but should contain add-actor
        //     expect(names).not.toContain('call-actor');
        //     expect(names).toContain('add-actor');

        //     await client.close();
        // });
        // it.runIf(options.transport === 'streamable-http')(
        // `should swap call-actor for add-actor when client supports dynamic tools for default tools`, async () => {
        //     client = await createClientFn({ clientName: 'Visual Studio Code' });
        //     const names = getToolNames(await client.listTools());

        //     // should not contain call-actor but should contain add-actor
        //     expect(names).not.toContain('call-actor');
        //     expect(names).toContain('add-actor');

        //     await client.close();
        // });
        it.runIf(options.transport === 'streamable-http')('should NOT swap call-actor for add-actor even when client supports dynamic tools', async () => {
            client = await createClientFn({ clientName: 'Visual Studio Code', tools: ['actors'] });
            const names = getToolNames(await client.listTools());

            // should not contain call-actor but should contain add-actor
            expect(names).toContain('call-actor');
            expect(names).not.toContain('add-actor');

            await client.close();
        });
        it.runIf(options.transport === 'streamable-http')(`should NOT swap call-actor for add-actor even when client supports dynamic tools for default tools`, async () => {
            client = await createClientFn({ clientName: 'Visual Studio Code' });
            const names = getToolNames(await client.listTools());

            // should not contain call-actor but should contain add-actor
            expect(names).toContain('call-actor');
            expect(names).not.toContain('add-actor');

            await client.close();
        });
        it.runIf(options.transport === 'streamable-http')(`should NOT swap call-actor for add-actor when client supports dynamic tools when using the call-actor explicitly`, async () => {
            client = await createClientFn({ clientName: 'Visual Studio Code', tools: ['call-actor'] });
            const names = getToolNames(await client.listTools());

            // should not contain call-actor but should contain add-actor
            expect(names).toContain('call-actor');
            expect(names).not.toContain('add-actor');

            await client.close();
        });

        it('should return error message when trying to call MCP server Actor without tool name in actor parameter', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const response = await client.callTool({
                name: 'call-actor',
                arguments: {
                    actor: ACTOR_MCP_SERVER_ACTOR_NAME,
                    input: { url: 'https://docs.apify.com' },
                },
            });

            expect(response.content).toBeDefined();
            const content = response.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG);
            expect(response.isError).toBe(true);

            await client.close();
        });

        // Environment variable precedence tests
        it.runIf(options.transport === 'stdio')('should use TELEMETRY_ENABLED env var when CLI arg is not provided', async () => {
            // When useEnv=true, telemetry.enabled option translates to env.TELEMETRY_ENABLED in child process
            client = await createClientFn({ useEnv: true, telemetry: { enabled: false } });
            const tools = await client.listTools();

            // Verify tools are loaded correctly
            expect(tools.tools.length).toBeGreaterThan(0);
            await client.close();
        });

        // TODO: if we add more streamable task tool call tests it migth be worth it to abscract the common logic but now it's not worth it
        it('should be able to call a long running task tool call', async () => {
            client = await createClientFn({ tools: [ACTOR_PYTHON_EXAMPLE] });

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(ACTOR_PYTHON_EXAMPLE),
                    arguments: {
                        first_number: 1,
                        second_number: 2,
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000, // Keep results for 60 seconds
                    },
                },
            );

            let lastStatus = '';
            let resultReceived = false;
            for await (const message of stream) {
                switch (message.type) {
                    case 'taskCreated':
                        // Task created successfully with ID: message.task.taskId
                        break;
                    case 'taskStatus':
                        if (lastStatus !== message.task.status) {
                            // Task status: message.task.status with optional message.task.statusMessage
                        }
                        lastStatus = message.task.status;
                        break;
                    case 'result':
                        // Task completed successfully
                        message.result.content.forEach((item) => {
                            expect(item).toHaveProperty('type');
                        });
                        // Mark that we received the result
                        resultReceived = true;
                        break;
                    case 'error':
                        throw message.error;
                    default:
                        throw new Error(`Unknown message type: ${(message as unknown as { type: string }).type}`);
                }
            }
            expect(resultReceived).toBe(true);
        });

        it('should be able to call a long running task and list it, get the status and then separately retrieve the result', async () => {
            client = await createClientFn({ tools: [ACTOR_PYTHON_EXAMPLE] });

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(ACTOR_PYTHON_EXAMPLE),
                    arguments: {
                        first_number: 3,
                        second_number: 4,
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000, // Keep results for 60 seconds
                    },
                },
            );

            let taskId: string | null = null;
            for await (const message of stream) {
                if (message.type === 'taskCreated') {
                    taskId = message.task.taskId;

                    // Now we can get the task status
                    const taskStatus = await client.experimental.tasks.getTask(taskId);
                    expect(taskStatus).toHaveProperty('status');
                    expect(taskStatus.status).toBe('working');

                    // List and verify the task is present
                    const tasks = await client.experimental.tasks.listTasks();
                    const taskIds = tasks.tasks.map((task) => task.taskId);
                    expect(taskIds).toContain(taskId);
                } else if (message.type === 'result') {
                    // So typescript is happy
                    if (!taskId) throw new Error('Task ID should be set before receiving result');
                    // Task completed retrieve the result separately
                    const result = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
                    expect(result.content).toBeDefined();
                    const content = result.content as { text: string; type: string }[];
                    expect(content.length).toBe(2);
                }
            }
        });

        it('should be able to call a long running task and then cancel it midway', async () => {
            client = await createClientFn({ tools: [ACTOR_PYTHON_EXAMPLE] });

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(ACTOR_PYTHON_EXAMPLE),
                    arguments: {
                        first_number: 5,
                        second_number: 6,
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000, // Keep results for 60 seconds
                    },
                },
            );

            let taskId: string | null = null;
            for await (const message of stream) {
                if (message.type === 'taskCreated') {
                    taskId = message.task.taskId;

                    await client.experimental.tasks.cancelTask(taskId);
                } else if (message.type === 'taskStatus') {
                    expect(message.task.status).toBe('cancelled');
                } else if (message.type === 'result') {
                    throw new Error('Task should have been cancelled before completion');
                }
            }
        });

        it('should support call-actor tool in task mode (internal tool with taskSupport)', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: HelperTools.ACTOR_CALL,
                    arguments: {
                        actor: ACTOR_PYTHON_EXAMPLE,
                        input: {
                            first_number: 10,
                            second_number: 20,
                        },
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000, // Keep results for 60 seconds
                    },
                },
            );

            let resultReceived = false;
            let taskCreated = false;
            for await (const message of stream) {
                switch (message.type) {
                    case 'taskCreated':
                        taskCreated = true;
                        expect(message.task.taskId).toBeDefined();
                        break;
                    case 'taskStatus':
                        // Task should transition through statuses
                        expect(['working', 'completed']).toContain(message.task.status);
                        break;
                    case 'result': {
                        // Verify the result contains expected content
                        expect(message.result.content).toBeDefined();
                        const content = message.result.content as { text: string; type: string }[];
                        expect(content.length).toBeGreaterThan(0);
                        // Should contain dataset or run information
                        const resultText = content.map((c) => c.text).join(' ');
                        expect(resultText.length).toBeGreaterThan(0);
                        resultReceived = true;
                        break;
                    }
                    case 'error':
                        throw message.error;
                    default:
                        throw new Error(`Unknown message type: ${(message as unknown as { type: string }).type}`);
                }
            }

            expect(taskCreated).toBe(true);
            expect(resultReceived).toBe(true);
        });

        it.runIf(options.transport === 'stdio')('should use UI_MODE env var when CLI arg is not provided', async () => {
            client = await createClientFn({ useEnv: true, uiMode: 'openai' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            // Verify that openai-only internal tools are present in openai mode
            expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_INTERNAL);
            expect(toolNames).toContain(HelperTools.STORE_SEARCH_INTERNAL);

            // Verify that tools have OpenAI metadata when UI mode is enabled
            const searchActorsTool = tools.tools.find((tool) => tool.name === HelperTools.STORE_SEARCH);
            expect(searchActorsTool).toBeDefined();
            expect(searchActorsTool?._meta).toBeDefined();
            expect(searchActorsTool?._meta?.['openai/outputTemplate']).toBeDefined();
            expect(searchActorsTool?._meta?.['openai/widgetAccessible']).toBe(true);

            const fetchActorDetailsToolFromList = tools.tools.find((tool) => tool.name === HelperTools.ACTOR_GET_DETAILS);
            expect(fetchActorDetailsToolFromList).toBeDefined();
            expect(fetchActorDetailsToolFromList?._meta).toBeDefined();
            expect(fetchActorDetailsToolFromList?._meta?.['openai/outputTemplate']).toBeDefined();
            expect(fetchActorDetailsToolFromList?._meta?.['openai/widgetAccessible']).toBe(true);

            const callActorTool = tools.tools.find((tool) => tool.name === HelperTools.ACTOR_CALL);
            expect(callActorTool).toBeDefined();
            expect(callActorTool?._meta).toBeDefined();
            expect(callActorTool?._meta?.['openai/outputTemplate']).toBeDefined();
            expect(callActorTool?._meta?.['openai/widgetAccessible']).toBe(true);

            await client.close();
        });

        it.runIf(options.transport === 'sse' || options.transport === 'streamable-http')('should use uiMode URL parameter when provided', async () => {
            client = await createClientFn({ uiMode: 'openai' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            // Verify that openai-only internal tools are present in openai mode
            expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_INTERNAL);
            expect(toolNames).toContain(HelperTools.STORE_SEARCH_INTERNAL);

            // Verify that tools have OpenAI metadata when UI mode is enabled via URL parameter
            const searchActorsTool = tools.tools.find((tool) => tool.name === HelperTools.STORE_SEARCH);
            expect(searchActorsTool).toBeDefined();
            expect(searchActorsTool?._meta).toBeDefined();
            expect(searchActorsTool?._meta?.['openai/outputTemplate']).toBeDefined();
            expect(searchActorsTool?._meta?.['openai/widgetAccessible']).toBe(true);

            const fetchActorDetailsToolFromList = tools.tools.find((tool) => tool.name === HelperTools.ACTOR_GET_DETAILS);
            expect(fetchActorDetailsToolFromList).toBeDefined();
            expect(fetchActorDetailsToolFromList?._meta).toBeDefined();
            expect(fetchActorDetailsToolFromList?._meta?.['openai/outputTemplate']).toBeDefined();
            expect(fetchActorDetailsToolFromList?._meta?.['openai/widgetAccessible']).toBe(true);

            const callActorTool = tools.tools.find((tool) => tool.name === HelperTools.ACTOR_CALL);
            expect(callActorTool).toBeDefined();
            expect(callActorTool?._meta).toBeDefined();
            expect(callActorTool?._meta?.['openai/outputTemplate']).toBeDefined();
            expect(callActorTool?._meta?.['openai/widgetAccessible']).toBe(true);

            await client.close();
        });

        it('should automatically include get-actor-run when uiMode is enabled', async () => {
            client = await createClientFn({ uiMode: 'openai' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // When uiMode is enabled, default tools include call-actor, so get-actor-run should be included
            expect(toolNames).toContain(HelperTools.ACTOR_CALL);
            expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it.runIf(options.transport === 'sse' || options.transport === 'streamable-http')('should include get-actor-run without call-actor', async () => {
            client = await createClientFn({ uiMode: 'openai', tools: ['docs'] });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // get-actor-run should be included when uiMode is enabled, even if call-actor is not present
            expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET);
            // Docs tools should be present
            expect(toolNames).toContain(HelperTools.DOCS_SEARCH);
            expect(toolNames).toContain(HelperTools.DOCS_FETCH);
            // call-actor should NOT be present since only 'docs' was selected
            expect(toolNames).not.toContain(HelperTools.ACTOR_CALL);

            await client.close();
        });

        // Skyfire mode only works with Streamable-HTTP transport.
        it.runIf(options.transport === 'streamable-http')(
            'should inject skyfire-pay-id parameter into all SKYFIRE_ENABLED_TOOLS when skyfireMode is enabled',
            async () => {
                client = await createClientFn({
                    skyfireMode: true,
                    tools: Array.from(SKYFIRE_ENABLED_TOOLS),
                });

                const toolsList = await client.listTools();
                const skyfireEnabledToolNames = Array.from(SKYFIRE_ENABLED_TOOLS);

                // Check each skyfire-enabled tool
                for (const toolName of skyfireEnabledToolNames) {
                    const tool = toolsList.tools.find((t) => t.name === toolName);

                    // Tool should exist
                    expect(tool, `Tool "${toolName}" should exist in the tools list`).toBeDefined();

                    if (!tool) continue;

                    // Tool should have inputSchema with properties
                    expect(tool.inputSchema, `Tool "${toolName}" should have inputSchema`).toBeDefined();
                    expect(
                        tool.inputSchema && 'properties' in tool.inputSchema,
                        `Tool "${toolName}" should have inputSchema.properties`,
                    ).toBe(true);

                    if (!tool.inputSchema || !('properties' in tool.inputSchema)) continue;

                    const properties = tool.inputSchema.properties as Record<string, unknown>;

                    // skyfire-pay-id property should exist
                    expect(
                        properties['skyfire-pay-id'],
                        `Tool "${toolName}" should have skyfire-pay-id property in inputSchema`,
                    ).toBeDefined();

                    // Verify skyfire-pay-id has correct structure
                    const skyfireProperty = properties['skyfire-pay-id'] as Record<string, unknown>;
                    expect(skyfireProperty.type, `skyfire-pay-id should have type "string"`).toBe('string');
                    expect(
                        skyfireProperty.description,
                        `skyfire-pay-id should have description`,
                    ).toBeDefined();

                    // Tool description should contain skyfire instructions
                    expect(
                        tool.description?.includes('skyfire-pay-id'),
                        `Tool "${toolName}" description should mention skyfire-pay-id`,
                    ).toBe(true);
                }

                await client.close();
            },
        );

        it('should return required structuredContent fields for ActorRun widget (get-actor-run)', async () => {
            client = await createClientFn({ tools: ['actors', 'runs'] });

            // First, start an async actor run to get a runId
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    async: true,
                },
            });

            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            const runId = resultWithStructured.structuredContent!.runId!;

            // Now test get-actor-run
            const runResult = await client.callTool({
                name: HelperTools.ACTOR_RUNS_GET,
                arguments: { runId },
            });

            const runContent = runResult as { structuredContent?: {
                runId: string;
                actorName: string;
                status: string;
                startedAt: string;
                dataset?: {
                    datasetId: string;
                    itemCount: number;
                };
            } };

            expect(runContent.structuredContent).toBeDefined();
            expect(runContent.structuredContent?.runId).toBeDefined();
            expect(runContent.structuredContent?.actorName).toBeDefined();
            expect(runContent.structuredContent?.status).toBeDefined();
            expect(runContent.structuredContent?.startedAt).toBeDefined();

            // Wait for run to succeed to check dataset fields (might need polling in real scenario,
            // but for integration test on python-example it might be fast enough or we check basic fields)
            if (runContent.structuredContent?.status === 'SUCCEEDED') {
                expect(runContent.structuredContent?.dataset).toBeDefined();
                expect(runContent.structuredContent?.dataset?.datasetId).toBeDefined();
                expect(runContent.structuredContent?.dataset?.itemCount).toBeDefined();
            }
        });

        it('should return required structuredContent fields for ActorSearch widget (search-actors)', async () => {
            client = await createClientFn({
                tools: ['actors'],
                uiMode: 'openai', // Enable UI mode to get widgetActors
            });

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH,
                arguments: {
                    keywords: 'python',
                    limit: 5,
                },
            });

            const content = result as { structuredContent?: {
                actors: Record<string, unknown>[];
                widgetActors?: Record<string, unknown>[];
            } };

            expect(content.structuredContent).toBeDefined();
            expect(content.structuredContent?.actors).toBeDefined();
            expect(Array.isArray(content.structuredContent?.actors)).toBe(true);

            // Check widgetActors presence in OpenAI mode
            expect(content.structuredContent?.widgetActors).toBeDefined();
            expect(Array.isArray(content.structuredContent?.widgetActors)).toBe(true);

            // Check first widget actor for required fields
            if (content.structuredContent!.widgetActors && content.structuredContent!.widgetActors.length > 0) {
                const actor = content.structuredContent!.widgetActors[0];
                expect(actor).toHaveProperty('id');
                expect(actor).toHaveProperty('name');
                expect(actor).toHaveProperty('username');
                expect(actor).toHaveProperty('description');
            }
        });

        it('should return required structuredContent fields for ActorSearchDetail widget (fetch-actor-details)', async () => {
            client = await createClientFn({
                tools: ['actors'],
                uiMode: 'openai', // Enable UI mode to get widget structured content
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                },
            });

            const content = result as { structuredContent?: {
                actorDetails?: {
                    actorInfo: {
                        id: string;
                        name: string;
                        username: string;
                        description: string;
                    };
                    actorCard: string;
                    readme: string;
                };
            } };

            expect(content.structuredContent).toBeDefined();
            expect(content.structuredContent?.actorDetails).toBeDefined();

            const details = content.structuredContent!.actorDetails!;
            expect(details.actorCard).toBeDefined();
            expect(typeof details.actorCard).toBe('string');

            // OpenAI widget path always returns full readme
            expect(details.readme).toBeDefined();
            expect(typeof details.readme).toBe('string');

            expect(details.actorInfo).toBeDefined();
            expect(details.actorInfo).toHaveProperty('id');
            expect(details.actorInfo).toHaveProperty('name');
            expect(details.actorInfo).toHaveProperty('username');
            expect(details.actorInfo).toHaveProperty('description');
        });
    });
}
