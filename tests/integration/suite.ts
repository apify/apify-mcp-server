import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import {
    defaults,
    HelperTools,
    MAX_LIMIT_WITH_INPUT_SCHEMA,
    RAG_WEB_BROWSER,
    SERVER_MODE_AUTO_DETECTION_ENABLED,
} from '../../src/const.js';
import { SKYFIRE_ENABLED_TOOLS } from '../../src/payments/const.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import { CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG } from '../../src/tools/core/call_actor_common.js';
// Import tools from getCategoryTools instead of directly to avoid circular dependency during module initialization
import { getCategoryTools, getDefaultTools } from '../../src/tools/index.js';
import { getActorRunOutputSchema } from '../../src/tools/structured_output_schemas.js';
import { actorNameToToolName } from '../../src/tools/utils.js';
import type { ServerMode, ToolCategory, ToolEntry } from '../../src/types.js';
import { getExpectedToolNamesByCategories } from '../../src/utils/tool_categories_helpers.js';
import { AUTO_INJECTED_TOOLS } from '../../src/utils/tools_loader.js';
import { ACTOR_MCP_SERVER_ACTOR_NAME, ACTOR_PYTHON_EXAMPLE, DEFAULT_ACTOR_NAMES, getDefaultToolNames } from '../const.js';
import { addActor, type McpClientOptions } from '../helpers.js';
import { assertStatusMessagePropagated, captureInflightActorRunId, waitForRunAborted, waitForRunTerminal } from './utils/task_waits.js';

const AUTO_INJECTED_TOOL_NAMES = AUTO_INJECTED_TOOLS.map((t) => t.name);

// Helper to find tool by name, resolving categories for the given mode on each call.
// This ensures we always validate against the correct mode-specific tool definition
// (e.g. outputSchema may diverge between modes in the future).
function findToolByName(name: string, mode: ServerMode): ToolEntry | undefined {
    const resolved = getCategoryTools(mode);
    for (const tools of Object.values(resolved)) {
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

async function callPythonExampleActor(client: Client, selectedToolName: string) {
    const result = await client.callTool({
        name: selectedToolName,
        arguments: {
            first_number: 1,
            second_number: 2,
        },
    });

    expectPythonExampleStructuredContent(result);
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

function validateStructuredOutputForTool(result: unknown, toolName: string, mode: ServerMode): void {
    validateStructuredOutput(result, findToolByName(toolName, mode)?.outputSchema, toolName);
}

/** Validates that the listed tools have widget metadata (_meta) with MCP Apps ui.* keys. */
function expectWidgetToolMeta(tools: { tools: { name: string; _meta?: Record<string, unknown> }[] }): void {
    const toolNames = [HelperTools.STORE_SEARCH_WIDGET, HelperTools.ACTOR_GET_DETAILS_WIDGET, HelperTools.ACTOR_CALL_WIDGET];
    for (const toolName of toolNames) {
        const tool = tools.tools.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
        expect(tool?._meta).toBeDefined();
        // MCP Apps standard keys (SEP-1865)
        const ui = tool?._meta?.ui as Record<string, unknown> | undefined;
        expect(ui).toBeDefined();
        expect(ui?.resourceUri).toBeDefined();
        expect(ui?.visibility).toEqual(['model', 'app']);
    }
}

/**
 * Validates the canonical run response from `call-actor` against the python-example Actor.
 * The response does not inline dataset items. `itemCount` is not asserted because Apify's
 * dataset metadata propagation can lag past the server's probe window; the dataset id plus a
 * non-empty `fields` list is the reliable signal that items were written.
 */
function expectPythonExampleStructuredContent(result: unknown): void {
    const resultWithStructured = result as { structuredContent?: {
         runId?: string;
         status?: string;
         storages?: {
             datasets?: { default?: { id?: string; fields?: string[] } };
         };
         summary?: string;
         nextStep?: string;
     } };
    const sc = resultWithStructured.structuredContent;
    expect(sc).toBeDefined();
    expect(sc?.runId).toBeDefined();
    expect(sc?.status).toBe('SUCCEEDED');
    expect(sc?.storages?.datasets?.default?.id).toBeDefined();
    expect(sc?.storages?.datasets?.default?.fields ?? []).toEqual(
        expect.arrayContaining(['first_number', 'second_number', 'sum']),
    );
    expect(sc?.summary).toBeDefined();
    expect(sc?.nextStep).toBeDefined();
}

/** Validates that the result contains Apify usage cost metadata with expected structure. */
function expectUsageCostMeta(result: unknown): void {
    const resultWithMeta = result as {
        _meta?: { 'com.apify/ActorRun'?: { usageTotalUsd?: number; usageUsd?: Record<string, number> } };
    };
    expect(resultWithMeta._meta).toBeDefined();
    const actorRun = resultWithMeta._meta?.['com.apify/ActorRun'];
    expect(actorRun).toBeDefined();
    expect(typeof actorRun?.usageTotalUsd).toBe('number');
    expect(actorRun!.usageTotalUsd!).toBeGreaterThanOrEqual(0);
    const usageUsd = actorRun?.usageUsd;
    if (usageUsd !== undefined) {
        expect(typeof usageUsd).toBe('object');
    }
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
            expect(tools.tools.length).toEqual(getDefaultTools('default').length + defaults.actors.length + 4);

            const names = getToolNames(tools);
            expectToolNamesToContain(names, getDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            // get-actor-run + storage/abort helpers are auto-injected alongside call-actor.
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            await client.close();
        });

        it('should match spec default: actors,docs,apify/rag-web-browser when no params provided', async () => {
            client = await createClientFn();
            const tools = await client.listTools();
            const names = getToolNames(tools);

            // Should be equivalent to tools=actors,docs,apify/rag-web-browser
            // Note: UI tools (search-actors-widget, fetch-actor-details-widget) are only available in apps mode
            const expectedActorsTools = [
                'fetch-actor-details',
                'search-actors',
                'call-actor',
            ];
            const expectedDocsTools = ['search-apify-docs', 'fetch-apify-docs'];
            const expectedActors = [actorNameToToolName('apify/rag-web-browser')];

            const expectedTotal = expectedActorsTools.concat(expectedDocsTools, expectedActors);
            expect(names).toHaveLength(expectedTotal.length + 4);

            expectToolNamesToContain(names, expectedActorsTools);
            expectToolNamesToContain(names, expectedDocsTools);
            expectToolNamesToContain(names, expectedActors);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it('should auto-inject storage and abort tools when enableAddingActors is true', async () => {
            client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            // add-actor triggers storage/abort helpers but NOT get-actor-run (no call-actor; not apps mode).
            expect(names.length).toEqual(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain('add-actor');
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            await client.close();
        });

        it('should return outputSchema, title, and icons in tools list response', async () => {
            client = await createClientFn();
            const response = await client.listTools();

            // Find a tool with outputSchema (e.g., search-apify-docs)
            const searchApiifyDocsTool = response.tools.find((tool) => tool.name === 'search-apify-docs');
            expect(searchApiifyDocsTool).toBeDefined();

            // Verify that outputSchema is present
            expect(typeof searchApiifyDocsTool?.outputSchema).toBe('object');
            expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('type');
            expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('properties');

            await client.close();
        });

        it('should list all default tools and Actors when enableAddingActors is false', async () => {
            client = await createClientFn({ enableAddingActors: false });
            const names = getToolNames(await client.listTools());
            expect(names.length).toEqual(getDefaultTools('default').length + defaults.actors.length + 4);

            expectToolNamesToContain(names, getDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it('should override enableAddingActors false with experimental tool category', async () => {
            client = await createClientFn({ enableAddingActors: false, tools: ['experimental'] });

            const names = getToolNames(await client.listTools());
            // experimental category provides add-actor; no call-actor → no get-actor-run.
            expect(names).toHaveLength(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain('add-actor');
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

            await client.close();
        });

        it('should list two loaded Actors plus auto-injected storage and abort tools', async () => {
            const actors = ['apify/python-example', 'apify/rag-web-browser'];
            client = await createClientFn({ actors, enableAddingActors: false, serverMode: 'default' });
            const names = getToolNames(await client.listTools());
            // Actor tools trigger storage/abort helpers; default mode skips get-actor-run for actor tools.
            expect(names.length).toEqual(actors.length + AUTO_INJECTED_TOOL_NAMES.length);
            expectToolNamesToContain(names, actors.map((actor) => actorNameToToolName(actor)));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

            await client.close();
        });

        it('should load only specified actors when actors param is provided (no other tools)', async () => {
            const actors = ['apify/python-example'];
            client = await createClientFn({ actors, serverMode: 'default' });
            const names = getToolNames(await client.listTools());

            // Should only load the specified actor plus auto-injected storage/abort helpers
            expect(names.length).toEqual(actors.length + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(actors[0]));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

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
            client = await createClientFn({ tools: actors, serverMode: 'default' });
            const names = getToolNames(await client.listTools());
            // The Actor plus auto-injected storage/abort helpers.
            expect(names).toHaveLength(actors.length + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(actors[0]));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

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
            expect(names).toContain(actorNameToToolName('apify/python-example'));
        });

        it('should merge actors param into tools selectors (backward compatibility)', async () => {
            const actors = ['apify/python-example'];
            const categories = ['docs'] as ToolCategory[];

            client = await createClientFn({ tools: categories, actors });

            const names = getToolNames(await client.listTools());
            const docsToolNames = getExpectedToolNamesByCategories(categories);
            const expected = [...docsToolNames, actorNameToToolName(actors[0])];
            // Actor tool triggers auto-injection of storage/abort helpers.
            expect(names).toHaveLength(expected.length + AUTO_INJECTED_TOOL_NAMES.length);

            const containsExpected = expected.every((n) => names.includes(n));
            expect(containsExpected).toBe(true);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

            await client.close();
        });

        it('should handle mixed categories and specific tools in tools param', async () => {
            client = await createClientFn({
                tools: ['docs', 'fetch-actor-details', 'add-actor'],
            });
            const names = getToolNames(await client.listTools());

            // docs (2) + fetch-actor-details + add-actor + auto-injected helpers
            expect(names).toHaveLength(4 + AUTO_INJECTED_TOOL_NAMES.length);

            // Should include: docs category + specific tools
            expect(names).toContain('search-apify-docs'); // from docs category
            expect(names).toContain('fetch-apify-docs'); // from docs category
            expect(names).toContain('fetch-actor-details'); // specific tool
            expect(names).toContain('add-actor'); // specific tool

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
            // Actor tool triggers storage/abort helpers; default mode skips get-actor-run for actor tools.
            expect(names.length).toEqual(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(actorNameToToolName(ACTOR_PYTHON_EXAMPLE));
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);

            await client.close();
        });

        it('should add Actor dynamically and call it directly', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            client = await createClientFn({ enableAddingActors: true });
            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain('add-actor');
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            expect(names).not.toContain(selectedToolName);
            // Add Actor dynamically
            await addActor(client, ACTOR_PYTHON_EXAMPLE);

            // add-actor + auto-injected + newly added actor
            const namesAfterAdd = getToolNames(await client.listTools());
            expect(namesAfterAdd.length).toEqual(2 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(namesAfterAdd).toContain(selectedToolName);
            expectToolNamesToContain(namesAfterAdd, AUTO_INJECTED_TOOL_NAMES);
            await callPythonExampleActor(client, selectedToolName);
        });

        it('should call Actor dynamically via generic call-actor tool without need to add it first', async () => {
            const selectedToolName = actorNameToToolName(ACTOR_PYTHON_EXAMPLE);
            client = await createClientFn({ enableAddingActors: true, tools: ['actors'] });
            const names = getToolNames(await client.listTools());
            // actors category + add-actor + get-actor-run + auto-injected storage/abort helpers
            const numberOfTools = getCategoryTools('default').actors.length + 2 + AUTO_INJECTED_TOOL_NAMES.length;
            expect(names).toHaveLength(numberOfTools);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
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

            const content = result.content as { text: string; type: string }[];
            // content[0] mirrors structuredContent as JSON; content[1] is "${summary}\n${nextStep}".
            expect(content[0]?.type).toBe('text');
            const mirrored = JSON.parse(content[0].text) as { runId?: string; status?: string };
            expect(mirrored.runId).toBeDefined();
            expect(mirrored.status).toBe('SUCCEEDED');

            // Validate structured output has run-response metadata for the python-example Actor.
            expectPythonExampleStructuredContent(result);
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

        it('returns terminal RunResponse with usage cost meta when the run completes within waitSecs', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    // Max wait (45s) so the test does not flake on a slow run.
                    waitSecs: 45,
                },
            });

            validateStructuredOutputForTool(callResult, HelperTools.ACTOR_CALL, 'default');
            expectPythonExampleStructuredContent(callResult);

            const sc = (callResult as { structuredContent?: { status?: string; summary?: string } }).structuredContent;
            expect(sc?.status).toBe('SUCCEEDED');
            expect(sc?.summary).toMatch(/SUCCEEDED/);

            expectUsageCostMeta(callResult);
        });

        it('returns immediately with a non-terminal RunResponse when waitSecs=0', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    waitSecs: 0,
                },
            });

            validateStructuredOutputForTool(callResult, HelperTools.ACTOR_CALL, 'default');

            const sc = (callResult as { structuredContent?: { runId?: string; status?: string } }).structuredContent;
            expect(sc?.runId).toBeDefined();
            // Non-blocking: status is typically READY or RUNNING at this point (terminal also tolerated for very fast actors).
            expect(['READY', 'RUNNING', 'SUCCEEDED']).toContain(sc?.status);
        });

        it('accepts but ignores the deprecated previewOutput field', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    previewOutput: false,
                    waitSecs: 45,
                },
            });

            // previewOutput is deprecated and ignored; the response is the canonical RunResponse
            // regardless of the flag. Validate the metadata is intact.
            validateStructuredOutputForTool(callResult, HelperTools.ACTOR_CALL, 'default');
            expectPythonExampleStructuredContent(callResult);
        });

        it('accepts callOptions.maxItems on call-actor and runs successfully', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: RAG_WEB_BROWSER,
                    input: { query: 'hello', maxResults: 3 },
                    callOptions: { maxItems: 3 },
                    waitSecs: 45,
                },
            });

            expect(callResult.isError).not.toBe(true);
            const sc = (callResult as { structuredContent?: {
                status?: string;
                storages?: { datasets?: { default?: { id?: string } } };
            } }).structuredContent;
            // `waitSecs: 45` is the `WAIT_SECS_MAX` cap; rag-web-browser occasionally
            // doesn't reach a terminal status within that window. This test is about
            // `callOptions.maxItems` being accepted by the API — not about the actor
            // finishing fast — so accept RUNNING as well.
            expect(['RUNNING', 'SUCCEEDED']).toContain(sc?.status);
            expect(sc?.storages?.datasets?.default?.id).toBeDefined();
        });

        it('surfaces dataset fields in the canonical response (no inline preview)', async () => {
            client = await createClientFn({ tools: ['actors'] });

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    waitSecs: 45,
                },
            });

            // The canonical response doesn't inline preview items — agents fetch them via
            // get-dataset-items using the dataset id and the fields list surfaced here.
            validateStructuredOutputForTool(callResult, HelperTools.ACTOR_CALL, 'default');
            expectPythonExampleStructuredContent(callResult);

            const sc = (callResult as { structuredContent?: {
                nextStep?: string;
                storages?: { datasets?: { default?: { id?: string } } };
            } }).structuredContent;
            // nextStep should interpolate the datasetId so a text-only client can act without parsing storages.
            expect(sc?.nextStep).toContain(sc?.storages?.datasets?.default?.id ?? '__unset__');
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

        // Upstream-contract canary: apify-core's `AGENT_SAFE_PRICING_MODELS` filter
        // (`GET /v2/store`) is what excludes rental Actors. If that contract ever
        // drifts, this test catches the regression on the MCP side.
        it('should not return rental Actors from store search', async () => {
            client = await createClientFn();

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH,
                arguments: {
                    keywords: 'rental',
                    limit: MAX_LIMIT_WITH_INPUT_SCHEMA,
                },
            });
            const content = result.content as { text: string }[];
            expect(content.length).toBe(1);
            const outputText = content[0].text;

            // Sanity check that the output format hasn't drifted in a way that
            // would make the negative assertion below silently meaningless.
            expect(outputText).toContain('This Actor');
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

        it.runIf(options.transport === 'streamable-http')(
            'should return error when adding a standby Actor in x402 payment mode',
            async () => {
                client = await createClientFn({ enableAddingActors: true, payment: 'x402' });
                const result = await client.callTool({
                    name: HelperTools.ACTOR_ADD,
                    arguments: { actor: 'apify/rag-web-browser' },
                });
                expect(result).toBeDefined();
                const content = result.content as { text: string }[];
                expect(content.length).toBeGreaterThan(0);
                expect(content[0].text).toContain('standby Actor, which is not supported in agentic payment mode');
                await client.close();
            },
        );

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

            const callContent = callResult.content as { text: string }[];
            expect(callContent.some((item) => item.text.includes(`Fetched content from ${DOCS_URL}`))).toBe(true);
        });

        // Regression: `call-actor` declares an `outputSchema` (since #415), but the MCP-server pass-through
        // path in `handleMcpToolCall` returns `{ content }` only — no `structuredContent`. SDK ≥ 1.11.4
        // throws -32600 "has an output schema but did not return structured content" once it has cached
        // the tool validators (which happens on `listTools()` — every real client does this on connect).
        // The happy-path test above never calls `listTools()`, so the SDK skips validation and the bug stays
        // invisible at the integration layer. This test surfaces it.
        it('MCP server actor:tool pass-through returns structuredContent satisfying outputSchema', async () => {
            client = await createClientFn({ tools: ['actors'] });

            // Populates the SDK's `_cachedToolOutputValidators` map so callTool runs schema validation.
            await client.listTools();

            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: `${ACTOR_MCP_SERVER_ACTOR_NAME}:fetch-apify-docs`,
                    input: { url: 'https://docs.apify.com' },
                },
            });

            // structuredContent must be present and carry the keys declared `required` on
            // `getActorRunOutputSchema`. The pass-through path has no Apify run, so the fix is expected to
            // synthesize sentinel values (e.g. `runId: 'mcp-passthrough'`) rather than real run identifiers.
            const sc = (callResult as { structuredContent?: Record<string, unknown> }).structuredContent;
            expect(sc).toBeDefined();
            expect(sc).toHaveProperty('runId');
            expect(sc).toHaveProperty('actorId');
            expect(sc).toHaveProperty('status');
            expect(sc).toHaveProperty('storages');
            expect(sc).toHaveProperty('summary');
            expect(sc).toHaveProperty('nextStep');

            // The remote MCP tool's actual result must still flow through `content` — the fix must not
            // lose the payload while satisfying the schema.
            const content = callResult.content as { text: string }[];
            expect(content.some((item) => item.text.includes('Fetched content from'))).toBe(true);

            // `isError` must reflect the remote tool's status — false on the happy path. Forwarding this
            // closes a second drop on the same line: `handleMcpToolCall` currently discards `result.isError`.
            expect(callResult.isError ?? false).toBe(false);
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

            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            // Should contain at least one apify docs url
            const standbyDocUrl = 'https://docs.apify.com';
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

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HelperTools.DOCS_SEARCH, 'default');
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

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            // This should validate successfully - structured output must match schema
            validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            // This should validate successfully - structured output must match schema
            validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            const content = result.content as { text: string }[];
            // Should contain actor info (pricing is part of actor card) but NOT readme or schema
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(true);
            expect(content.some((item) => item.text.includes('README'))).toBe(false);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(false);

            // Validate structured output
            validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            const content = result.content as { text: string }[];
            // Should contain readme text but NOT actor info card or input schema
            expect(content.length).toBeGreaterThan(0);
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(false);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(false);

            // Validate structured output
            validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            validateStructuredOutput(result, findToolByName(HelperTools.ACTOR_GET_DETAILS, 'default')?.outputSchema, 'fetch-actor-details');
        });

        it('should render widget payload via fetch-actor-details-widget in apps mode', async () => {
            client = await createClientFn({
                tools: ['actors'],
                serverMode: 'apps',
            });

            // fetch-actor-details-widget is only available in apps mode
            const result = await client.callTool({
                name: 'fetch-actor-details-widget',
                arguments: {
                    actor: RAG_WEB_BROWSER,
                },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            const allText = content.map((item) => item.text).join('\n');

            // Widget tool returns a short text pointer to the rendered widget
            expect(allText).toContain('Actor information');
            expect(allText).toContain('interactive widget');

            const structured = result.structuredContent as {
                actorDetails?: { actorInfo?: unknown; readme?: string };
            };
            expect(structured.actorDetails).toBeDefined();
            expect(structured.actorDetails!.actorInfo).toBeDefined();
            expect(typeof structured.actorDetails!.readme).toBe('string');
            expect(structured.actorDetails!.readme!.length).toBeGreaterThan(0);
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
            validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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
            validateStructuredOutputForTool(pricingOnlyResult, HelperTools.ACTOR_GET_DETAILS, 'default');
            validateStructuredOutputForTool(ratingOnlyResult, HelperTools.ACTOR_GET_DETAILS, 'default');
            validateStructuredOutputForTool(metadataOnlyResult, HelperTools.ACTOR_GET_DETAILS, 'default');
            validateStructuredOutputForTool(combinationResult, HelperTools.ACTOR_GET_DETAILS, 'default');
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
                validateStructuredOutputForTool(result, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            validateStructuredOutputForTool(allCardSectionsResult, HelperTools.ACTOR_GET_DETAILS, 'default');
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

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HelperTools.STORE_SEARCH, 'default');
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

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HelperTools.DOCS_FETCH, 'default');
        });

        it.for(Object.keys(getCategoryTools('default')))('should load correct tools for %s category', async (category) => {
            client = await createClientFn({
                tools: [category as ToolCategory],
            });

            const loadedTools = await client.listTools();
            const toolNames = getToolNames(loadedTools);

            const expectedToolNames = getExpectedToolNamesByCategories([category as ToolCategory]);
            // Only assert that all tools from the selected category are present.
            for (const expectedToolName of expectedToolNames) {
                expect(toolNames).toContain(expectedToolName);
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

        // Cancel an in-flight `tools/call` via `notifications/cancelled` and verify the
        // underlying Apify run is aborted. The runId isn't reachable through the client (no
        // response after cancel, no runId in progress notifications), so we race the Apify API
        // for the just-started run while the call is in flight, then trigger the cancel.
        it.runIf(options.transport === 'streamable-http')('should abort actor run on notifications/cancelled', { retry: 1 }, async () => {
            const ACTOR_NAME = 'apify/rag-web-browser';
            const selectedToolName = actorNameToToolName(ACTOR_NAME);
            client = await createClientFn({ enableAddingActors: true });
            await addActor(client, ACTOR_NAME);

            const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
            const actor = await api.actor(ACTOR_NAME).get();
            expect(actor).toBeDefined();
            const actId = actor!.id as string;

            const capturingSince = new Date();
            const controller = new AbortController();
            const requestPromise = client.request({
                method: 'tools/call' as const,
                params: {
                    name: selectedToolName,
                    arguments: { query: 'restaurants in San Francisco', maxResults: 10 },
                },
            }, CallToolResultSchema, { signal: controller.signal })
                // Swallow "AbortError: This operation was aborted" — expected after cancel.
                .catch(() => undefined);

            const runId = await captureInflightActorRunId(api, actId, capturingSince);
            controller.abort();
            await requestPromise;

            await waitForRunAborted(api, runId);
        });

        it.runIf(options.transport === 'streamable-http')('should abort call-actor tool on notifications/cancelled', { retry: 1 }, async () => {
            const ACTOR_NAME = 'apify/rag-web-browser';
            client = await createClientFn({ tools: ['actors'] });

            const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
            const actor = await api.actor(ACTOR_NAME).get();
            expect(actor).toBeDefined();
            const actId = actor!.id as string;

            const capturingSince = new Date();
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
                .catch(() => undefined);

            const runId = await captureInflightActorRunId(api, actId, capturingSince);
            controller.abort();
            await requestPromise;

            await waitForRunAborted(api, runId);
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
            expect(names.length).toEqual(getDefaultTools('default').length + defaults.actors.length + 4);

            expectToolNamesToContain(names, getDefaultToolNames());
            expectToolNamesToContain(names, DEFAULT_ACTOR_NAMES);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it.runIf(options.transport === 'stdio')(
            'should respect ENABLE_ADDING_ACTORS env var and auto-inject storage tools alongside add-actor',
            async () => {
                client = await createClientFn({ enableAddingActors: true, useEnv: true });
                const names = getToolNames(await client.listTools());
                expectToolNamesToContain(names, ['add-actor', ...AUTO_INJECTED_TOOL_NAMES]);

                await client.close();
            },
        );

        it.runIf(options.transport === 'stdio')('should load tool categories from TOOLS environment variable', async () => {
            // Verifies env-var threading (`TOOLS=docs` → loader input) end-to-end via stdio.
            // `docs` is chosen because it doesn't trigger auto-inject — the loader's union/dedup
            // logic has its own unit coverage and isn't what this test should be asserting.
            client = await createClientFn({ tools: ['docs'], useEnv: true });
            const toolNames = getToolNames(await client.listTools());

            expect(toolNames).toContain(HelperTools.DOCS_SEARCH);
            expect(toolNames).toContain(HelperTools.DOCS_FETCH);
            expect(toolNames).not.toContain(HelperTools.ACTOR_CALL);
            expect(toolNames).not.toContain(HelperTools.ACTOR_RUNS_GET);
        });

        it('should auto-inject storage and abort tools after call-actor in expected order', async () => {
            client = await createClientFn();
            const tools = await client.listTools();
            const names = tools.tools.map((t) => t.name);

            const callIndex = names.indexOf(HelperTools.ACTOR_CALL);
            const runIndex = names.indexOf(HelperTools.ACTOR_RUNS_GET);
            const datasetIndex = names.indexOf(HelperTools.DATASET_GET_ITEMS);
            const kvIndex = names.indexOf(HelperTools.KEY_VALUE_STORE_RECORD_GET);
            const abortIndex = names.indexOf(HelperTools.ACTOR_RUNS_ABORT);

            expect(callIndex).toBeGreaterThanOrEqual(0);
            expect(callIndex).toBeLessThan(runIndex);
            expect(runIndex).toBeLessThan(datasetIndex);
            expect(datasetIndex).toBeLessThan(kvIndex);
            expect(kvIndex).toBeLessThan(abortIndex);

            await client.close();
        });

        it('should not auto-inject storage and abort tools when no actor-touching tools are present', async () => {
            client = await createClientFn({ tools: ['docs'] });
            const names = getToolNames(await client.listTools());
            for (const name of AUTO_INJECTED_TOOL_NAMES) expect(names).not.toContain(name);
            expect(names).not.toContain(HelperTools.ACTOR_OUTPUT_GET);
            expect(names).not.toContain(HelperTools.ACTOR_RUNS_GET);
            await client.close();
        });

        describe('rag-web-browser run reads via storage tools', () => {
            let datasetId: string;
            let runId: string;

            beforeAll(async () => {
                const setupClient = await createClientFn({ tools: ['actors', 'storage'] });
                const callResult = await setupClient.callTool({
                    name: HelperTools.ACTOR_CALL,
                    arguments: {
                        actor: RAG_WEB_BROWSER,
                        input: { query: 'https://apify.com', maxResults: 1 },
                        // `WAIT_SECS_MAX = 45` — same pattern as the other rag-web-browser tests
                        // in this file (PR #863 fix). Without it the call defaults to 30s,
                        // which is not always enough for the actor to write its first item
                        // before the dataset-read tests in this describe block start.
                        waitSecs: 45,
                    },
                });
                const callStructured = callResult as { structuredContent?: {
                    runId?: string;
                    storages?: { datasets?: { default?: { id?: string } } };
                } };
                const sc = callStructured.structuredContent;
                expect(sc?.runId).toBeDefined();
                expect(sc?.storages?.datasets?.default?.id).toBeDefined();
                datasetId = sc!.storages!.datasets!.default!.id!;
                runId = sc!.runId!;
                await setupClient.close();
            }, 60_000);

            it('auto-flattens dot-notation `fields` on get-dataset-items', async () => {
                client = await createClientFn({ tools: ['storage'] });
                const result = await client.callTool({
                    name: HelperTools.DATASET_GET_ITEMS,
                    arguments: { datasetId, fields: 'metadata.url,markdown' },
                });
                expect(result.isError).not.toBe(true);
                const items = (result as { structuredContent?: { items?: Record<string, unknown>[] } })
                    .structuredContent?.items;
                expect(Array.isArray(items)).toBe(true);
                expect(items?.length).toBeGreaterThan(0);
                expect(items?.[0]).toHaveProperty('metadata.url');
                await client.close();
            });

            it('honors explicit `flatten` override on get-dataset-items', async () => {
                client = await createClientFn({ tools: ['storage'] });
                const result = await client.callTool({
                    name: HelperTools.DATASET_GET_ITEMS,
                    arguments: { datasetId, fields: 'metadata.url', flatten: 'other' },
                });
                expect(result.isError).not.toBe(true);
                const items = (result as { structuredContent?: { items?: Record<string, unknown>[] } })
                    .structuredContent?.items;
                expect(Array.isArray(items)).toBe(true);
                // No item should have a flat `metadata.url` key — flatten="other" did not flatten metadata.
                const itemsWithFlatMetadataUrl = (items ?? []).filter((item) => 'metadata.url' in item);
                expect(itemsWithFlatMetadataUrl).toHaveLength(0);
                await client.close();
            });

            it('applies the default `limit` of 20 when omitted on get-dataset-items', async () => {
                client = await createClientFn({ tools: ['storage'] });
                const result = await client.callTool({
                    name: HelperTools.DATASET_GET_ITEMS,
                    arguments: { datasetId },
                });
                expect(result.isError).not.toBe(true);
                const structured = (result as { structuredContent?: { items?: unknown[]; limit?: number } })
                    .structuredContent;
                expect(structured?.limit).toBe(20);
                expect((structured?.items ?? []).length).toBeLessThanOrEqual(20);
                await client.close();
            });

            it('reads INPUT from the run\'s default KV store via get-actor-run + get-key-value-store-record', async () => {
                client = await createClientFn({ tools: ['runs', 'storage'] });
                const runResult = await client.callTool({
                    name: HelperTools.ACTOR_RUNS_GET,
                    arguments: { runId },
                });
                expect(runResult.isError).not.toBe(true);
                const runText = (runResult.content as { text: string }[])[0].text;
                // content[0] is JSON.stringify(structuredContent), not markdown-embedded JSON.
                const runData = JSON.parse(runText) as {
                    storages?: { keyValueStores?: { default?: { id?: string } } };
                };
                const kvId = runData.storages?.keyValueStores?.default?.id;
                expect(kvId).toBeDefined();

                const kvResult = await client.callTool({
                    name: HelperTools.KEY_VALUE_STORE_RECORD_GET,
                    arguments: { keyValueStoreId: kvId!, recordKey: 'INPUT' },
                });
                expect(kvResult.isError).not.toBe(true);
                expect((kvResult.content as { text: string }[])[0].text).toContain('apify.com');
                await client.close();
            });
        });

        it('rejects get-key-value-store-record when required keyValueStoreId is missing', async () => {
            client = await createClientFn({ tools: ['storage'] });
            await expect(client.callTool({
                name: HelperTools.KEY_VALUE_STORE_RECORD_GET,
                arguments: { recordKey: 'INPUT' },
            })).rejects.toThrow(/must have required property 'keyValueStoreId'/);
            await client.close();
        });

        it('calls rag-web-browser, verifies canonical shape with dot-notation fields, and fetches via get-dataset-items', async () => {
            client = await createClientFn({ tools: ['actors', 'storage'] });

            const callResult = await client.callTool({
                name: 'call-actor',
                arguments: {
                    actor: RAG_WEB_BROWSER,
                    // Max wait (45s) — see neighbouring rag-web-browser tests; the follow-up
                    // dataset read needs items, which require the run to reach SUCCEEDED.
                    input: { query: 'https://apify.com' },
                    waitSecs: 45,
                },
            });

            // content[0] mirrors structuredContent as JSON; content[1] is "${summary}\n${nextStep}".
            const content = callResult.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            const sc = (callResult as { structuredContent?: {
                runId?: string;
                status?: string;
                storages?: { datasets?: { default?: { id?: string; fields?: string[] } } };
                nextStep?: string;
            } }).structuredContent;
            // `waitSecs: 45` is the `WAIT_SECS_MAX` server-side cap; accept RUNNING and
            // wait for terminal via the Apify API before reading items.
            expect(['RUNNING', 'SUCCEEDED']).toContain(sc?.status);
            const datasetId = sc?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();
            expect(sc?.runId).toBeDefined();

            if (sc?.status !== 'SUCCEEDED') {
                const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
                await waitForRunTerminal(api, sc!.runId!);
            }

            // Dataset field paths surface in `storages.datasets.default.fields` (dot notation).
            const fields = sc?.storages?.datasets?.default?.fields ?? [];
            expect(fields.some((f) => f.startsWith('metadata.'))).toBe(true);
            expect(fields.some((f) => f === 'crawl' || f.startsWith('crawl.'))).toBe(true);

            const outputResult = await client.callTool({
                name: HelperTools.DATASET_GET_ITEMS,
                arguments: {
                    datasetId: datasetId!,
                    fields: 'metadata.title,crawl',
                },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBeGreaterThan(0);
            expect(items![0]).toHaveProperty('metadata.title');
            expect(typeof items![0]['metadata.title']).toBe('string');
            expect(items![0]).toHaveProperty('crawl');
            expect(typeof items![0].crawl).toBe('object');

            await client.close();
        });

        it('calls apify/rag-web-browser tool directly and retrieves metadata.title via get-dataset-items', async () => {
            client = await createClientFn({ tools: ['storage'], actors: ['apify/rag-web-browser'] });

            const result = await client.callTool({
                name: actorNameToToolName('apify/rag-web-browser'),
                // Max wait (45s) — the server-side cap. If the actor hasn't terminated
                // by then, we follow up with `waitForRunTerminal` below so the dataset
                // read sees the populated items.
                arguments: { query: 'https://apify.com', waitSecs: 45 },
            });

            // content[0] mirrors structuredContent as JSON; content[1] is "${summary}\n${nextStep}".
            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            // Direct actor tools return the canonical RunResponse shape — same as call-actor.
            const ragWebBrowserToolName = actorNameToToolName('apify/rag-web-browser');
            validateStructuredOutput(result, getActorRunOutputSchema, ragWebBrowserToolName);
            const sc = (result as { structuredContent?: {
                runId?: string;
                status?: string;
                storages?: { datasets?: { default?: { id?: string; fields?: string[] } } };
                nextStep?: string;
            } }).structuredContent;
            // `waitSecs: 45` is the `WAIT_SECS_MAX` server-side cap. Accept RUNNING too —
            // we wait for terminal status via the Apify API below before reading items.
            expect(['RUNNING', 'SUCCEEDED']).toContain(sc?.status);
            const datasetId = sc?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();
            expect(sc?.runId).toBeDefined();

            if (sc?.status !== 'SUCCEEDED') {
                const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
                await waitForRunTerminal(api, sc!.runId!);
            }

            // content[1] is the LLM-readable summary+nextStep; it must reference the datasetId
            // and the follow-up tool name so the LLM can act on the result.
            expect(content[1].text).toContain(datasetId);
            expect(content[1].text).toContain(HelperTools.DATASET_GET_ITEMS);

            // Dataset field paths surface in `storages.datasets.default.fields` (dot notation).
            const fields = sc?.storages?.datasets?.default?.fields ?? [];
            expect(fields.some((f) => f.startsWith('metadata.'))).toBe(true);
            expect(fields.some((f) => f === 'crawl' || f.startsWith('crawl.'))).toBe(true);

            const outputResult = await client.callTool({
                name: HelperTools.DATASET_GET_ITEMS,
                arguments: { datasetId: datasetId!, fields: 'metadata.title' },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBeGreaterThan(0);
            expect(items![0]).toHaveProperty('metadata.title');
            expect(typeof items![0]['metadata.title']).toBe('string');

            validateStructuredOutputForTool(outputResult, HelperTools.DATASET_GET_ITEMS, 'default');

            await client.close();
        });

        it('calls apify/python-example tool directly and retrieves full dataset via get-dataset-items', async () => {
            client = await createClientFn({ tools: ['storage'], actors: ['apify/python-example'] });
            const selectedToolName = actorNameToToolName('apify/python-example');
            const input = { first_number: 5, second_number: 7 };

            const result = await client.callTool({
                name: selectedToolName,
                arguments: input,
            });

            const content = result.content as { text: string; type: string }[];
            expect(content.length).toBe(2);

            // Direct actor tools return the canonical RunResponse shape — same as call-actor.
            validateStructuredOutput(result, getActorRunOutputSchema, selectedToolName);
            expectPythonExampleStructuredContent(result);
            expectUsageCostMeta(result);

            const datasetId = (result as { structuredContent?: {
                storages?: { datasets?: { default?: { id?: string } } };
            } }).structuredContent?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();

            const outputResult = await client.callTool({
                name: HelperTools.DATASET_GET_ITEMS,
                arguments: { datasetId: datasetId! },
            });

            const items = (outputResult as { structuredContent?: { items?: Record<string, unknown>[] } })
                .structuredContent?.items;
            expect(Array.isArray(items)).toBe(true);
            expect(items!.length).toBe(1);
            expect(items![0]).toHaveProperty('first_number', input.first_number);
            expect(items![0]).toHaveProperty('second_number', input.second_number);
            expect(items![0]).toHaveProperty('sum', input.first_number + input.second_number);

            validateStructuredOutputForTool(outputResult, HelperTools.DATASET_GET_ITEMS, 'default');
        });

        it('should return structured output for get-actor-run matching outputSchema', async () => {
            client = await createClientFn({ tools: ['actors', 'runs'] });

            // First, start an async actor run to get a runId
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    waitSecs: 0,
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
            validateStructuredOutputForTool(runResult, HelperTools.ACTOR_RUNS_GET, 'default');
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
            const contentByName = resultByName.content as { text: string }[];
            expect(contentByName[0].text).toContain(actorName);

            // Fetch by Actor ID only
            const resultById = await client.callTool({
                name: 'fetch-actor-details',
                arguments: { actor: actorId },
            });
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
                },
            });

            const resultWithStructured = callResult as { structuredContent?: {
                storages?: { datasets?: { default?: { id?: string } } };
            } };
            const datasetId = resultWithStructured.structuredContent?.storages?.datasets?.default?.id;
            expect(datasetId).toBeDefined();

            // Now test get-dataset-items
            const datasetResult = await client.callTool({
                name: HelperTools.DATASET_GET_ITEMS,
                arguments: { datasetId },
            });

            expect(datasetResult.content).toBeDefined();
            // Validate structured output for get-dataset-items
            validateStructuredOutputForTool(datasetResult, HelperTools.DATASET_GET_ITEMS, 'default');

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

        // TODO: if we add more streamable task tool call tests it might be worth it to abstract the common logic but now it's not worth it
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
            let taskStatusCount = 0;
            let resultReceived = false;
            for await (const message of stream) {
                switch (message.type) {
                    case 'taskCreated':
                        // Task created successfully with ID: message.task.taskId
                        break;
                    case 'taskStatus':
                        taskStatusCount++;
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
            // Regression guard: notifications/tasks/status must reach the client over the
            // session-level transport (standalone SSE on streamable HTTP). If notifications
            // are dropped, callToolStream emits no taskStatus events.
            expect(taskStatusCount).toBeGreaterThan(0);
            expect(lastStatus).not.toBe('');
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

        // Without the chained AbortController, the task flips to `cancelled` but the underlying
        // Apify run keeps consuming compute until natural finish.
        it('should abort the Apify run when tasks/cancel is sent (direct actor tool)', { retry: 3 }, async () => {
            client = await createClientFn({ tools: [RAG_WEB_BROWSER] });

            const api = new ApifyClient({ token: process.env.APIFY_TOKEN as string });
            const actor = await api.actor(RAG_WEB_BROWSER).get();
            expect(actor).toBeDefined();
            const actId = actor!.id as string;

            // Discover runId in parallel with the stream so it's ready by the time we verify.
            const runIdPromise = captureInflightActorRunId(api, actId, new Date());

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(RAG_WEB_BROWSER),
                    arguments: { query: 'restaurants in San Francisco', maxResults: 10 },
                },
                CallToolResultSchema,
                { task: { ttl: 60000 } },
            );

            let cancelled = false;
            for await (const message of stream) {
                if (message.type === 'taskCreated') {
                    // Cancel mid-run, not before the run starts.
                    await new Promise((resolve) => { setTimeout(resolve, 2000); });
                    await client.experimental.tasks.cancelTask(message.task.taskId);
                    cancelled = true;
                } else if (message.type === 'result') {
                    throw new Error('Task should have been cancelled before completion');
                }
            }
            expect(cancelled).toBe(true);

            const runId = await runIdPromise;
            await waitForRunAborted(api, runId);
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

        // WARNING: These tests can be flaky on streamable HTTP transport due to timing —
        // the Actor may complete before the progress polling interval (PROGRESS_NOTIFICATION_INTERVAL_MS)
        // fires a statusMessage. See: https://github.com/apify/apify-mcp-server/issues/558
        it('should propagate statusMessage to tasks/get and tasks/list for internal tools in task mode', { retry: 1 }, async () => {
            client = await createClientFn({ tools: ['actors'] });

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: HelperTools.ACTOR_CALL,
                    arguments: {
                        actor: RAG_WEB_BROWSER,
                        input: {
                            query: 'https://apify.com',
                        },
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000,
                    },
                },
            );

            await assertStatusMessagePropagated(client, stream);
        });

        it('should propagate statusMessage to tasks/get and tasks/list for actor tools in task mode', { retry: 1 }, async () => {
            client = await createClientFn({ tools: [RAG_WEB_BROWSER] });

            const stream = client.experimental.tasks.callToolStream(
                {
                    name: actorNameToToolName(RAG_WEB_BROWSER),
                    arguments: {
                        query: 'https://apify.com',
                    },
                },
                CallToolResultSchema,
                {
                    task: {
                        ttl: 60000,
                    },
                },
            );

            await assertStatusMessagePropagated(client, stream);
        });

        // Uses the deprecated 'openai' alias deliberately to verify it is silently
        // normalized to 'apps' at the CLI/env ingestion boundary (no warning emitted).
        it.runIf(options.transport === 'stdio')('should use UI_MODE env var (deprecated "openai" alias) when CLI arg is not provided', async () => {
            client = await createClientFn({ useEnv: true, serverMode: 'openai' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            // Verify that apps-only internal tools are present in apps mode
            expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
            expect(toolNames).toContain(HelperTools.STORE_SEARCH_WIDGET);
            expect(toolNames).toContain(HelperTools.ACTOR_CALL_WIDGET);

            // Verify that tools have widget metadata when UI mode is enabled
            expectWidgetToolMeta(tools);

            await client.close();
        });

        it('should enable apps mode when serverMode is apps', async () => {
            client = await createClientFn({ serverMode: 'apps' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
            expect(toolNames).toContain(HelperTools.STORE_SEARCH_WIDGET);
            expect(toolNames).toContain(HelperTools.ACTOR_CALL_WIDGET);

            // Verify that tools have widget metadata when UI mode is enabled via URL parameter
            expectWidgetToolMeta(tools);

            await client.close();
        });

        it('should treat serverMode=true the same as serverMode=apps', async () => {
            // 'true' is the standard external value for ?ui= (maps to 'apps' internally via parseServerMode)
            client = await createClientFn({ serverMode: 'true' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);
            expect(tools.tools.length).toBeGreaterThan(0);

            expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
            expect(toolNames).toContain(HelperTools.STORE_SEARCH_WIDGET);
            expect(toolNames).toContain(HelperTools.ACTOR_CALL_WIDGET);
            expectWidgetToolMeta(tools);

            await client.close();
        });

        it('should automatically include get-actor-run for default settings when call-actor is enabled', async () => {
            client = await createClientFn({ serverMode: 'apps' });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // When serverMode is enabled, default tools include call-actor, so get-actor-run should be included
            expect(toolNames).toContain(HelperTools.ACTOR_CALL);
            expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET);

            await client.close();
        });

        it('should not include get-actor-run when only docs tools are selected', async () => {
            client = await createClientFn({ serverMode: 'apps', tools: ['docs'] });
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            // No actor tools selected — get-actor-run and its widget must not appear
            expect(toolNames).not.toContain(HelperTools.ACTOR_RUNS_GET);
            expect(toolNames).not.toContain(HelperTools.ACTOR_RUNS_GET_WIDGET);
            // Docs tools should be present
            expect(toolNames).toContain(HelperTools.DOCS_SEARCH);
            expect(toolNames).toContain(HelperTools.DOCS_FETCH);
            // call-actor should NOT be present since only 'docs' was selected
            expect(toolNames).not.toContain(HelperTools.ACTOR_CALL);

            await client.close();
        });

        it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)('auto mode: client advertising UI capability receives apps-mode tools with widget metadata', async () => {
            // serverMode omitted → server defaults to 'auto'; client sends UI capability → server resolves to 'apps'
            client = await createClientFn({
                clientCapabilities: {
                    extensions: {
                        'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] },
                    },
                },
            });
            const tools = await client.listTools();
            expectWidgetToolMeta(tools);
            await client.close();
        });

        it('auto mode: client without UI capability receives default-mode tools without widget metadata', async () => {
            // serverMode omitted → server defaults to 'auto'; client sends no UI capability → server resolves to 'default'
            client = await createClientFn();
            const tools = await client.listTools();
            const toolNames = getToolNames(tools);

            expect(toolNames).not.toContain(HelperTools.STORE_SEARCH_WIDGET);
            expect(toolNames).not.toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
            for (const toolName of [HelperTools.STORE_SEARCH, HelperTools.ACTOR_GET_DETAILS, HelperTools.ACTOR_CALL]) {
                const tool = tools.tools.find((t) => t.name === toolName);
                expect(tool).toBeDefined();
                expect((tool?._meta as Record<string, unknown> | undefined)?.ui).toBeUndefined();
            }

            await client.close();
        });

        // Skyfire mode only works with Streamable-HTTP transport.
        it.runIf(options.transport === 'streamable-http')(
            'should inject skyfire-pay-id parameter into all SKYFIRE_ENABLED_TOOLS when skyfireMode is enabled',
            async () => {
                client = await createClientFn({
                    payment: 'skyfire',
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
                    expect(tool.inputSchema && 'properties' in tool.inputSchema, `Tool "${toolName}" should have inputSchema.properties`).toBe(true);

                    if (!tool.inputSchema || !('properties' in tool.inputSchema)) continue;

                    const properties = tool.inputSchema.properties as Record<string, unknown>;

                    // skyfire-pay-id property should exist
                    expect(properties['skyfire-pay-id'], `Tool "${toolName}" should have skyfire-pay-id property in inputSchema`).toBeDefined();

                    // Verify skyfire-pay-id has the correct structure
                    const skyfireProperty = properties['skyfire-pay-id'] as Record<string, unknown>;
                    expect(skyfireProperty.type, `skyfire-pay-id should have type "string"`).toBe('string');
                    expect(skyfireProperty.description, `skyfire-pay-id should have description`).toBeDefined();

                    // Tool description should contain skyfire instructions
                    expect(tool.description?.includes('skyfire-pay-id'), `Tool "${toolName}" description should mention skyfire-pay-id`).toBe(true);
                }

                await client.close();
            },
        );

        // x402 payment mode only works with Streamable-HTTP transport (requires HTTP headers).
        it.runIf(options.transport === 'streamable-http')(
            'should advertise x402 metadata on all paymentRequired tools when x402 payment is enabled',
            async () => {
                // Hardcoded list of tools expected to advertise _meta.x402 (i.e. paymentRequired: true).
                // Kept independent of any production constant so this test pins the expected paid set
                // and any silent drift (e.g. a tool losing paymentRequired) is caught here.
                const paidToolNames = [
                    HelperTools.ACTOR_CALL,
                    HelperTools.ACTOR_OUTPUT_GET,
                    HelperTools.ACTOR_RUNS_GET,
                    HelperTools.ACTOR_RUNS_LOG,
                    HelperTools.ACTOR_RUNS_ABORT,
                    HelperTools.DATASET_GET,
                    HelperTools.DATASET_GET_ITEMS,
                    HelperTools.DATASET_SCHEMA_GET,
                    HelperTools.KEY_VALUE_STORE_GET,
                    HelperTools.KEY_VALUE_STORE_KEYS_GET,
                    HelperTools.KEY_VALUE_STORE_RECORD_GET,
                ];
                const freeToolNames = [HelperTools.STORE_SEARCH, HelperTools.DOCS_SEARCH];

                client = await createClientFn({
                    payment: 'x402',
                    tools: [...paidToolNames, ...freeToolNames],
                });

                const toolsList = await client.listTools();

                // Positive: paid tools advertise _meta.x402 with both shapes —
                // flat preferred-scheme fields (back-compat) and the full accepts[] array.
                for (const toolName of paidToolNames) {
                    const tool = toolsList.tools.find((t) => t.name === toolName);
                    expect(tool, `Tool "${toolName}" should exist in the tools list`).toBeDefined();

                    const x402 = tool?._meta?.x402 as Record<string, unknown> | undefined;
                    expect(x402, `Tool "${toolName}" should advertise _meta.x402`).toBeDefined();
                    expect(x402?.paymentRequired, `Tool "${toolName}" x402.paymentRequired should be true`).toBe(true);

                    for (const field of ['scheme', 'network', 'asset', 'payTo', 'amount'] as const) {
                        expect(x402?.[field], `Tool "${toolName}" should advertise x402.${field}`).toBeDefined();
                    }

                    const accepts = x402?.accepts as Record<string, unknown>[] | undefined;
                    expect(accepts, `Tool "${toolName}" should advertise x402.accepts[]`).toBeInstanceOf(Array);
                    expect(accepts?.length, `Tool "${toolName}" should advertise at least one accept entry`).toBeGreaterThan(0);
                    for (const entry of accepts ?? []) {
                        expect(entry.scheme, `Tool "${toolName}" accepts entry should have a scheme`).toBeTypeOf('string');
                    }
                }

                // Negative: free tools must not advertise _meta.x402.
                for (const toolName of freeToolNames) {
                    const tool = toolsList.tools.find((t) => t.name === toolName);
                    expect(tool, `Tool "${toolName}" should exist in the tools list`).toBeDefined();
                    const meta = tool?._meta as Record<string, unknown> | undefined;
                    expect(meta?.x402, `Tool "${toolName}" should not advertise _meta.x402`).toBeUndefined();
                }

                await client.close();
            },
        );

        // x402 payment mode only works with Streamable-HTTP transport (requires HTTP headers).
        it.runIf(options.transport === 'streamable-http')(
            'should not load the default standby Actor apify/rag-web-browser in x402 payment mode',
            async () => {
                // Connect with ?payment=x402 — should load defaults, but filter out standby/MCP actors
                client = await createClientFn({ payment: 'x402' });

                const toolsList = await client.listTools();
                const ragWebBrowserTool = toolsList.tools.find((t) => t.name === 'apify--rag-web-browser');

                expect(ragWebBrowserTool, 'apify--rag-web-browser (standby) should not be loaded in payment mode').toBeUndefined();

                await client.close();

                // Connect without payment mode (standard token auth) — standby/MCP actors should load normally
                client = await createClientFn();

                const normalToolsList = await client.listTools();
                const normalRagWebBrowserTool = normalToolsList.tools.find((t) => t.name === 'apify--rag-web-browser');

                expect(normalRagWebBrowserTool, 'apify--rag-web-browser (standby) should be loaded under standard token auth').toBeDefined();

                await client.close();
            },
        );

        // x402 payment mode only works with Streamable-HTTP transport (requires HTTP headers).
        it.runIf(options.transport === 'streamable-http')(
            'should return x402 payment error when calling paymentRequired tool without payment signature',
            async () => {
                client = await createClientFn({ tools: ['actors'], payment: 'x402' });

                const result = await client.callTool({
                    name: HelperTools.ACTOR_CALL,
                    arguments: {
                        actor: ACTOR_PYTHON_EXAMPLE,
                        input: { first_number: 1, second_number: 2 },
                    },
                });

                expect(result.isError).toBe(true);
                const content = result.content as { text: string }[];
                expect(content[0].text).toContain('x402');

                // x402 MCP transport spec: 402 tool results MUST also expose the PaymentRequired
                // payload via structuredContent (preferred over content[0].text JSON parsing).
                const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
                expect(structured, 'x402 402 tool result should expose structuredContent').toBeDefined();
                expect(structured?.x402Version, 'structuredContent.x402Version should be set').toBeDefined();
                expect(structured?.accepts, 'structuredContent.accepts should be an array').toBeInstanceOf(Array);

                await client.close();
            },
        );

        it('returns structuredContent for get-actor-run', async () => {
            client = await createClientFn({ tools: ['actors', 'runs'] });

            // First, start an async actor run to get a runId
            const callResult = await client.callTool({
                name: HelperTools.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_PYTHON_EXAMPLE,
                    input: { first_number: 1, second_number: 2 },
                    waitSecs: 0,
                },
            });

            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            const runId = resultWithStructured.structuredContent!.runId!;

            // Now test get-actor-run with waitSecs to drive it to terminal state.
            const runResult = await client.callTool({
                name: HelperTools.ACTOR_RUNS_GET,
                arguments: { runId, waitSecs: 30 },
            });

            const runContent = runResult as { structuredContent?: {
                runId: string;
                actorId: string;
                actorName?: string;
                status: string;
                summary: string;
                nextStep: string;
                storages: {
                    datasets?: { default: { id: string; itemCount?: number; fields?: string[] } };
                    keyValueStores?: { default: { id: string } };
                };
            } };

            expect(runContent.structuredContent).toBeDefined();
            expect(runContent.structuredContent?.runId).toBe(runId);
            expect(runContent.structuredContent?.actorId).toBeDefined();
            expect(runContent.structuredContent?.status).toBeDefined();
            expect(runContent.structuredContent?.summary).toBeDefined();
            expect(runContent.structuredContent?.nextStep).toBeDefined();
            expect(runContent.structuredContent?.storages).toBeDefined();

            // No inlined dataset items or KV record bodies anywhere on the response.
            const dump = JSON.stringify(runContent.structuredContent);
            expect(dump).not.toContain('previewItems');

            if (runContent.structuredContent?.status === 'SUCCEEDED') {
                expect(runContent.structuredContent?.storages.datasets?.default.id).toBeDefined();
            }
        });

        it('rejects get-actor-run waitSecs above 45', async () => {
            client = await createClientFn({ tools: ['actors', 'runs'] });
            // runId is a real-looking value so a missing-run path can't accidentally satisfy this
            // assertion; the failure must come from waitSecs validation, not from run lookup.
            await expect(client.callTool({
                name: HelperTools.ACTOR_RUNS_GET,
                arguments: { runId: 'aaaaaaaaaaaaaaaaa', waitSecs: 46 },
            })).rejects.toThrow(/waitSecs|less than or equal to 45|<= 45/i);
        });

        it('should return required structuredContent fields for ActorSearch widget (search-actors-widget)', async () => {
            client = await createClientFn({
                tools: ['actors'],
                serverMode: 'apps', // Enable UI mode to get widgetActors
            });

            const result = await client.callTool({
                name: HelperTools.STORE_SEARCH_WIDGET,
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
            expect(Array.isArray(content.structuredContent?.actors)).toBe(true);

            // Check widgetActors presence in apps mode
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

        it('should return required structuredContent fields for ActorSearchDetail widget (fetch-actor-details-widget)', async () => {
            client = await createClientFn({
                tools: ['actors'],
                serverMode: 'apps', // Enable UI mode to get widget structured content
            });

            const result = await client.callTool({
                name: HelperTools.ACTOR_GET_DETAILS_WIDGET,
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
            expect(typeof details.actorCard).toBe('string');

            // Apps widget path always returns full readme
            expect(details.readme).toBeDefined();
            expect(typeof details.readme).toBe('string');

            expect(details.actorInfo).toHaveProperty('id');
            expect(details.actorInfo).toHaveProperty('name');
            expect(details.actorInfo).toHaveProperty('username');
            expect(details.actorInfo).toHaveProperty('description');
        });
    });
}
