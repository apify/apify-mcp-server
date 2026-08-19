import { expect } from 'vitest';

import { actorNameToToolName, getCategoryTools } from '@apify/actors-mcp-server/internals.js';
import { HELPER_TOOLS, MAX_LIMIT_WITH_INPUT_SCHEMA } from '@apify/actors-mcp-server/internals/test-kit.js';

import {
    ACTOR_EXAMPLE_MCP_SERVER,
    ACTOR_NORMAL_MODE,
    AUTO_INJECTED_TOOL_NAMES,
    expectNormalModeTestStructuredContent,
    expectReadmeInStructuredContent,
    expectToolNamesToContain,
    expectUsageCostMeta,
    findToolByName,
    getToolNames,
    validateStructuredOutput,
    validateStructuredOutputForTool,
    withClient,
} from '../helpers.js';
import type { Case } from '../types.js';

// call-actor calls Actors by name — this tool name must never appear in the tool list.
const NORMAL_MODE_TOOL_NAME = actorNameToToolName(ACTOR_NORMAL_MODE);

/** Actor tools: search, details, call-actor, get-actor-run. */
export const actorsCases: Case[] = [
    {
        name: 'calls an Actor directly via call-actor without a separate add step',
        isDeploymentTest: false,
        run: withClient({ tools: ['call-actor'] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toHaveLength(1 + AUTO_INJECTED_TOOL_NAMES.length);
            expect(names).toContain(HELPER_TOOLS.ACTOR_CALL);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            expect(names).not.toContain(NORMAL_MODE_TOOL_NAME);

            // No dynamic "add" step exists — call-actor calls any Actor by name directly.
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 } },
            });
            expectNormalModeTestStructuredContent(result);
        }),
    },
    {
        name: 'should call Actor dynamically via generic call-actor tool without need to add it first',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const names = getToolNames(await client.listTools());
            // actors category (already has call-actor) + auto-injected helpers.
            const numberOfTools = getCategoryTools('default').actors.length + AUTO_INJECTED_TOOL_NAMES.length;
            expect(names).toHaveLength(numberOfTools);
            // get-actor-run should be automatically included when call-actor is present
            expect(names).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
            expectToolNamesToContain(names, AUTO_INJECTED_TOOL_NAMES);
            // Check that the Actor is not in the tools list
            expect(names).not.toContain(NORMAL_MODE_TOOL_NAME);

            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 } },
            });

            const content = result.content as { text: string; type: string }[];
            // content[0] mirrors structuredContent as JSON; content[1] is "${summary}\n${nextStep}".
            expect(content[0]?.type).toBe('text');
            const mirrored = JSON.parse(content[0].text) as { runId?: string; status?: string };
            expect(mirrored.runId).toBeDefined();
            expect(mirrored.status).toBe('SUCCEEDED');

            // Validate structured output has run-response metadata for the normal-mode-test-actor.
            expectNormalModeTestStructuredContent(result);
        }),
    },
    {
        // isDeploymentTest: full-pipeline smoke (auth + real Actor run).
        name: 'should call Actor directly with required input',
        isDeploymentTest: true,
        run: withClient({ tools: ['actors'] }, async (client) => {
            // Should fail without input (AJV validation error)
            await expect(
                client.callTool({ name: HELPER_TOOLS.ACTOR_CALL, arguments: { actor: ACTOR_NORMAL_MODE } }),
            ).rejects.toThrow(/must have required property 'input'/);

            // Should succeed with input
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 } },
            });
            expect(callResult.content).toBeDefined();
        }),
    },
    {
        name: 'returns terminal RunResponse with usage cost meta when the run completes within waitSecs',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                // Max wait (45s) so the test does not flake on a slow run.
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 }, waitSecs: 45 },
            });

            validateStructuredOutputForTool(callResult, HELPER_TOOLS.ACTOR_CALL, 'default');
            expectNormalModeTestStructuredContent(callResult);

            const sc = (callResult as { structuredContent?: { status?: string; summary?: string } }).structuredContent;
            expect(sc?.status).toBe('SUCCEEDED');
            expect(sc?.summary).toMatch(/SUCCEEDED/);

            expectUsageCostMeta(callResult);
        }),
    },
    {
        name: 'returns immediately with a non-terminal RunResponse when waitSecs=0',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 }, waitSecs: 0 },
            });

            validateStructuredOutputForTool(callResult, HELPER_TOOLS.ACTOR_CALL, 'default');

            const sc = (callResult as { structuredContent?: { runId?: string; status?: string } }).structuredContent;
            expect(sc?.runId).toBeDefined();
            // Non-blocking: status is typically READY or RUNNING at this point (terminal also tolerated for very fast actors).
            expect(['READY', 'RUNNING', 'SUCCEEDED']).toContain(sc?.status);
        }),
    },
    {
        name: 'accepts but ignores the deprecated previewOutput field',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
                    input: { firstNumber: 1, secondNumber: 2 },
                    previewOutput: false,
                    waitSecs: 45,
                },
            });

            // previewOutput is ignored; still canonical RunResponse.
            validateStructuredOutputForTool(callResult, HELPER_TOOLS.ACTOR_CALL, 'default');
            expectNormalModeTestStructuredContent(callResult);
        }),
    },
    {
        name: 'accepts callOptions.maxItems on call-actor and runs successfully',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
                    input: { firstNumber: 1, secondNumber: 2 },
                    callOptions: { maxItems: 1 },
                    waitSecs: 45,
                },
            });

            expect(callResult.isError).not.toBe(true);
            const sc = (
                callResult as {
                    structuredContent?: { status?: string; storages?: { datasets?: { default?: { id?: string } } } };
                }
            ).structuredContent;
            expect(sc?.status).toBe('SUCCEEDED');
            expect(sc?.storages?.datasets?.default?.id).toBeDefined();
        }),
    },
    {
        name: 'surfaces dataset fields in the canonical response (no inline preview)',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 }, waitSecs: 45 },
            });

            // No inlined items — agents use dataset id + fields via get-dataset-items.
            validateStructuredOutputForTool(callResult, HELPER_TOOLS.ACTOR_CALL, 'default');
            expectNormalModeTestStructuredContent(callResult);

            const sc = (
                callResult as {
                    structuredContent?: { nextStep?: string; storages?: { datasets?: { default?: { id?: string } } } };
                }
            ).structuredContent;
            // nextStep should interpolate the datasetId so a text-only client can act without parsing storages.
            expect(sc?.nextStep).toContain(sc?.storages?.datasets?.default?.id ?? '__unset__');
        }),
    },
    {
        name: 'surfaces aliased storages from run.storageIds in the canonical response',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 }, waitSecs: 45 },
            });

            expect(callResult.isError).not.toBe(true);
            // Schema validation must accept the alias entries (additionalProperties: full dataset shape).
            validateStructuredOutputForTool(callResult, HELPER_TOOLS.ACTOR_CALL, 'default');
            const sc = (
                callResult as { structuredContent?: { storages?: { datasets?: Record<string, { id?: string }> } } }
            ).structuredContent;
            // Aliased `books` dataset must appear beside default.
            expect(sc?.storages?.datasets?.default?.id).toBeDefined();
            expect(sc?.storages?.datasets?.books?.id).toEqual(expect.any(String));
        }),
    },
    {
        // isDeploymentTest: store-search discovery path.
        name: 'should find Actors in store search',
        isDeploymentTest: true,
        run: withClient(undefined, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.STORE_SEARCH,
                arguments: { keywords: 'normal-mode-test-actor', limit: 5 },
            });
            const content = result.content as { text: string }[];
            expect(content.some((item) => item.text.includes(ACTOR_NORMAL_MODE))).toBe(true);
        }),
    },
    {
        name: 'should not return rental Actors from store search',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.STORE_SEARCH,
                arguments: { keywords: 'rental', limit: MAX_LIMIT_WITH_INPUT_SCHEMA },
            });
            const content = result.content as { text: string }[];
            expect(content.length).toBe(1);
            const outputText = content[0].text;
            expect(outputText).toContain('This Actor');
            expect(outputText).not.toContain('This Actor is rental');
        }),
    },
    {
        name: 'should return an Actor-not-found error when calling a non-existent actor via call-actor',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const nonExistentActor = 'apify/this-actor-does-not-exist';
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: nonExistentActor, input: {} },
            });
            expect(result).toBeDefined();
            expect(result.isError).toBe(true);
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(nonExistentActor);
            expect(content[0].text).toContain('was not found');
        }),
    },
    {
        name: 'should return structured output for fetch-actor-details matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const toolName = HELPER_TOOLS.ACTOR_GET_DETAILS;
            const result = await client.callTool({ name: toolName, arguments: { actor: ACTOR_NORMAL_MODE } });

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should return only input schema when output={ inputSchema: true }',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
        }),
    },
    {
        name: 'should return only description and stats when specified',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
        }),
    },
    {
        name: 'should list MCP tools when output={ mcpTools: true } for MCP server Actor',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_EXAMPLE_MCP_SERVER,
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
            expect(content.some((item) => item.text.includes('add'))).toBe(true);
        }),
    },
    {
        name: 'should return graceful note when output={ mcpTools: true } for regular Actor',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
        }),
    },
    {
        name: 'should return structured output for fetch-actor-details with selective output matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const toolName = HELPER_TOOLS.ACTOR_GET_DETAILS;

            // Test with output={ mcpTools: true } - should validate against schema even with selective fields
            const result = await client.callTool({
                name: toolName,
                arguments: {
                    actor: ACTOR_EXAMPLE_MCP_SERVER,
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
            validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should return structured output for fetch-actor-details with output={ description: true, readme: true } matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const toolName = HELPER_TOOLS.ACTOR_GET_DETAILS;

            // Test with output={ description: true, readme: true } - inputSchema should be undefined
            const result = await client.callTool({
                name: toolName,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should return only pricing when output={ pricing: true }',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should return only readme when output={ readme: true }',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should return README content (summary or full) in text and structured response for fetch-actor-details',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: 'fetch-actor-details',
                arguments: { actor: ACTOR_NORMAL_MODE, output: { description: true, readme: true, inputSchema: true } },
            });

            expect(result.content).toBeDefined();
            const content = result.content as { text: string }[];
            const allText = content.map((item) => item.text).join('\n');

            // Text should contain actor card, README section (summary or full fallback), and input schema
            expect(allText).toContain('Actor information');
            expect(allText).toMatch(/# README summary|# README/);
            expect(allText).toContain('Input schema');

            expectReadmeInStructuredContent(result, ACTOR_NORMAL_MODE);

            validateStructuredOutput(
                result,
                findToolByName(HELPER_TOOLS.ACTOR_GET_DETAILS, 'default')?.outputSchema,
                'fetch-actor-details',
            );
        }),
    },
    {
        name: 'should use default values when output object is not provided',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            // When output is not provided, all fields should default to their default values
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: { actor: ACTOR_NORMAL_MODE },
            });

            const content = result.content as { text: string }[];
            // Should contain all default sections (description, stats, pricing, rating, metadata, readme, inputSchema)
            // but NOT mcpTools (which defaults to false)
            expect(content.some((item) => item.text.includes('Actor information'))).toBe(true);
            expect(content.some((item) => item.text.includes('Input schema'))).toBe(true);
            expect(content.some((item) => item.text.includes('Available MCP Tools'))).toBe(false);
        }),
    },
    {
        name: 'should return all fields when output includes all standard options',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            const resultWithStructured = result as {
                structuredContent?: { actorInfo?: unknown; inputSchema?: unknown };
            };
            expect(resultWithStructured.structuredContent).toBeDefined();
            expect(resultWithStructured.structuredContent?.actorInfo).toBeDefined();
            expect(resultWithStructured.structuredContent?.inputSchema).toBeDefined();

            // Validate against schema
            validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should support granular output controls for rating and metadata',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            // Test 1: Only pricing (should include pricing, NOT other sections)
            const pricingOnlyResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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

            // Test 2: Only rating
            const ratingOnlyResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            // TODO: re-enable once apify/normal-mode-test-actor has reviews; Rating: is omitted when review count is 0
            // expect(ratingText).toContain('Rating:');
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
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            // TODO: re-enable once apify/normal-mode-test-actor has reviews; Rating: is omitted when review count is 0
            // expect(combinationText).toContain('Rating:');
            expect(combinationText).toContain('Developed by:');
            expect(combinationText).toContain('Categories:');
            expect(combinationText).toContain('Last modified:');
            // Should NOT include: description, stats, readme, input-schema
            expect(combinationText).not.toContain('Description:');
            expect(combinationText).not.toContain('Stats:');
            expect(combinationText).not.toContain('README');
            expect(combinationText).not.toContain('Input schema');

            // Validate structured output for all test cases
            validateStructuredOutputForTool(pricingOnlyResult, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
            validateStructuredOutputForTool(ratingOnlyResult, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
            validateStructuredOutputForTool(metadataOnlyResult, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
            validateStructuredOutputForTool(combinationResult, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should dynamically test all output options and verify section presence/absence',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            // Define all output options with their expected markers in text
            const outputOptions = [
                {
                    name: 'description',
                    field: 'description',
                    markers: ['Description:'],
                    notMarkers: [
                        'Developed by:',
                        'Categories:',
                        'Stats:',
                        'Pricing',
                        'Rating:',
                        'Last modified:',
                        'README',
                        'Input schema',
                    ],
                },
                {
                    name: 'stats',
                    field: 'stats',
                    markers: ['Stats:', 'total users', 'monthly users'],
                    notMarkers: [
                        'Developed by:',
                        'Categories:',
                        'Description:',
                        'Pricing',
                        'Rating:',
                        'Last modified:',
                        'README',
                        'Input schema',
                    ],
                },
                {
                    name: 'pricing',
                    field: 'pricing',
                    markers: ['Pricing'],
                    notMarkers: [
                        'Developed by:',
                        'Categories:',
                        'Description:',
                        'Stats:',
                        'Rating:',
                        'Last modified:',
                        'README',
                        'Input schema',
                    ],
                },
                {
                    name: 'rating',
                    field: 'rating',
                    // TODO: restore markers to ['Rating:', 'out of 5'] once apify/normal-mode-test-actor has reviews;
                    // Rating: is omitted when review count is 0
                    markers: [],
                    notMarkers: [
                        'Developed by:',
                        'Categories:',
                        'Description:',
                        'Stats:',
                        'Pricing',
                        'Last modified:',
                        'README',
                        'Input schema',
                    ],
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
                    notMarkers: [
                        'Developed by:',
                        'Description:',
                        'Stats:',
                        'Pricing',
                        'Rating:',
                        'Last modified:',
                        'README',
                    ],
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
                    name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                    arguments: {
                        actor: ACTOR_NORMAL_MODE,
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
                validateStructuredOutputForTool(result, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
            }

            // Test a combination: all actor card sections (description, stats, pricing, rating, metadata)
            const allCardSectionsResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_GET_DETAILS,
                arguments: {
                    actor: ACTOR_NORMAL_MODE,
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
            // TODO: re-enable once apify/normal-mode-test-actor has reviews; Rating: is omitted when review count is 0
            // expect(allCardText).toContain('Rating:');
            expect(allCardText).toContain('Developed by:');
            expect(allCardText).toContain('Categories:');
            expect(allCardText).toContain('Last modified:');

            // Should NOT include readme or input-schema
            expect(allCardText).not.toContain('README');
            expect(allCardText).not.toContain('Input schema');

            validateStructuredOutputForTool(allCardSectionsResult, HELPER_TOOLS.ACTOR_GET_DETAILS, 'default');
        }),
    },
    {
        name: 'should return structured output for search-actors matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const toolName = HELPER_TOOLS.STORE_SEARCH;
            const result = await client.callTool({
                name: toolName,
                arguments: { keywords: 'rag web browser', limit: 5, offset: 0 },
            });

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HELPER_TOOLS.STORE_SEARCH, 'default');
        }),
    },
    {
        name: 'should return structured output for get-actor-run matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors', 'runs'] }, async (client) => {
            // First, start an async actor run to get a runId
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 }, waitSecs: 0 },
            });

            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            expect(resultWithStructured.structuredContent?.runId).toBeDefined();
            const runId = resultWithStructured.structuredContent!.runId!;

            // Now test get-actor-run
            const runResult = await client.callTool({ name: HELPER_TOOLS.ACTOR_RUNS_GET, arguments: { runId } });

            expect(runResult.content).toBeDefined();
            // Validate structured output for get-actor-run
            validateStructuredOutputForTool(runResult, HELPER_TOOLS.ACTOR_RUNS_GET, 'default');
        }),
    },
    {
        name: 'should return Actor details both for full Actor name and ID',
        isDeploymentTest: false,
        run: withClient(undefined, async (client, ctx) => {
            const apifyClient = ctx.createApifyClient();
            const actor = await apifyClient.actor(ACTOR_NORMAL_MODE).get();
            expect(actor).toBeDefined();
            const actorId = actor!.id as string;

            // Fetch by full Actor name
            const resultByName = await client.callTool({
                name: 'fetch-actor-details',
                arguments: { actor: ACTOR_NORMAL_MODE },
            });
            const contentByName = resultByName.content as { text: string }[];
            expect(contentByName[0].text).toContain(ACTOR_NORMAL_MODE);

            // Fetch by Actor ID only
            const resultById = await client.callTool({
                name: 'fetch-actor-details',
                arguments: { actor: actorId },
            });
            const contentById = resultById.content as { text: string }[];
            expect(contentById[0].text).toContain(ACTOR_NORMAL_MODE);
        }),
    },
    {
        name: 'returns structuredContent for get-actor-run',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors', 'runs'] }, async (client) => {
            // First, start an async actor run to get a runId
            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: ACTOR_NORMAL_MODE, input: { firstNumber: 1, secondNumber: 2 }, waitSecs: 0 },
            });

            const resultWithStructured = callResult as { structuredContent?: { runId?: string } };
            const runId = resultWithStructured.structuredContent!.runId!;

            // Now test get-actor-run with waitSecs to drive it to terminal state.
            const runResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_RUNS_GET,
                arguments: { runId, waitSecs: 30 },
            });

            const runContent = runResult as {
                structuredContent?: {
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
                };
            };

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
        }),
    },
    {
        name: 'should return a run-not-found error when calling get-actor-log for a non-existent run',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors', 'runs'] }, async (client) => {
            // Syntactically valid but nonexistent run ID. The same literal appears in the
            // waitSecs-validation test below for the opposite reason: there it must NOT be
            // treated as missing, so the waitSecs check fires first.
            const nonExistentRunId = 'aaaaaaaaaaaaaaaaa';
            const result = await client.callTool({
                name: HELPER_TOOLS.ACTOR_RUNS_LOG,
                arguments: { runId: nonExistentRunId },
            });
            expect(result).toBeDefined();
            expect(result.isError).toBe(true);
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toBe(`Run with ID '${nonExistentRunId}' not found.`);
        }),
    },
    {
        name: 'rejects get-actor-run waitSecs above 45',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors', 'runs'] }, async (client) => {
            // Fake-but-plausible runId so failure is waitSecs validation, not missing run.
            await expect(
                client.callTool({
                    name: HELPER_TOOLS.ACTOR_RUNS_GET,
                    arguments: { runId: 'aaaaaaaaaaaaaaaaa', waitSecs: 46 },
                }),
            ).rejects.toThrow(/waitSecs|less than or equal to 45|<= 45/i);
        }),
    },
];
