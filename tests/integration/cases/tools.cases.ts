import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../../src/const.js';
import { CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG } from '../../../src/tools/actors/call_actor.js';
import { ACTOR_EXAMPLE_MCP_SERVER } from '../../const.js';
import { asLegacyClient, type McpSuiteClient } from '../../helpers.js';
import {
    buildExampleMcpServerAddToolContent,
    type CasesCtx,
    getToolNames,
    validateStructuredOutputForTool,
} from './shared.js';

/**
 * Generic MCP protocol/tool behavior not tied to a specific Actor: prompts, docs search/
 * fetch, report-problem gating, outputSchema/title/icons shape, session termination, and
 * the MCP-server-Actor passthrough family (calling another MCP server through call-actor).
 */
export function registerToolsCases(ctx: CasesCtx): void {
    const { itc, createClientFn, transport } = ctx;

    describe('report-problem', () => {
        // report-problem is served only when telemetry is enabled; this suite runs with telemetry
        // off, so end-to-end it must be absent. That gating is what we can verify here without
        // emitting telemetry. The served path (listed for non-Anthropic clients, hidden from
        // Anthropic clients, acknowledges a submission) is covered by the unit tests
        // tests/unit/mcp.server.report_problem_gating.test.ts and tests/unit/tools.report_problem.test.ts.
        itc('is not served when telemetry is disabled', undefined, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
        });
    });

    itc('should return outputSchema, title, and icons in tools list response', undefined, async (client) => {
        const response = await client.listTools();

        // Find a tool with outputSchema (e.g., search-apify-docs)
        const searchApiifyDocsTool = response.tools.find((tool) => tool.name === 'search-apify-docs');
        expect(searchApiifyDocsTool).toBeDefined();

        // Verify that outputSchema is present
        expect(typeof searchApiifyDocsTool?.outputSchema).toBe('object');
        expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('type');
        expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('properties');
    });

    // Regression: `call-actor` declares an `outputSchema` (since #415), but the MCP-server pass-through
    // path in `handleMcpToolCall` returns `{ content }` only — no `structuredContent`. SDK ≥ 1.11.4
    // throws -32600 "has an output schema but did not return structured content" once it has cached
    // the tool validators (which happens on `listTools()` — every real client does this on connect).
    // The happy-path test above never calls `listTools()`, so the SDK skips validation and the bug stays
    // invisible at the integration layer. This test surfaces it.
    itc(
        'MCP server actor:tool pass-through returns structuredContent satisfying outputSchema',
        { tools: ['actors'] },
        async (client) => {
            // Populates the SDK's `_cachedToolOutputValidators` map so callTool runs schema validation.
            await client.listTools();

            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: {
                    actor: `${ACTOR_EXAMPLE_MCP_SERVER}:add`,
                    input: { firstNumber: 2, secondNumber: 3 },
                },
            });

            // structuredContent must be present and carry the keys declared `required` on
            // `actorRunOutputSchema`. The pass-through path has no Apify run, so the fix is expected to
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
            expect(content).toEqual(buildExampleMcpServerAddToolContent(2, 3));

            // `isError` must reflect the remote tool's status — false on the happy path. Forwarding this
            // closes a second drop on the same line: `handleMcpToolCall` currently discards `result.isError`.
            expect(callResult.isError ?? false).toBe(false);
        },
    );

    itc(
        'should search Apify documentation',
        {
            tools: ['docs'],
        },
        async (client) => {
            const toolName = HELPER_TOOLS.DOCS_SEARCH;

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
        },
    );

    itc(
        'should fetch Apify documentation page',
        {
            tools: ['docs'],
        },
        async (client) => {
            const documentUrl = 'https://docs.apify.com/academy/getting-started/creating-actors';
            const result = await client.callTool({
                name: HELPER_TOOLS.DOCS_FETCH,
                arguments: {
                    url: documentUrl,
                },
            });

            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(documentUrl);
        },
    );

    itc(
        'should reject fetch-apify-docs with forbidden URL (not from allowed domains)',
        {
            tools: ['docs'],
        },
        async (client) => {
            const forbiddenUrl = 'https://example.com/some-page';
            const result = await client.callTool({
                name: HELPER_TOOLS.DOCS_FETCH,
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
        },
    );

    itc(
        'should allow fetch-apify-docs from Crawlee domain (https://crawlee.dev)',
        {
            tools: ['docs'],
        },
        async (client) => {
            const crawleeDocsUrl = 'https://crawlee.dev/js/docs/quick-start';
            const result = await client.callTool({
                name: HELPER_TOOLS.DOCS_FETCH,
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
        },
    );

    itc(
        'should return structured output for search-apify-docs matching outputSchema',
        {
            tools: ['docs'],
        },
        async (client) => {
            const toolName = HELPER_TOOLS.DOCS_SEARCH;

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

            validateStructuredOutputForTool(result, HELPER_TOOLS.DOCS_SEARCH, 'default');
        },
    );

    itc(
        'should return structured output for fetch-apify-docs matching outputSchema',
        {
            tools: ['docs'],
        },
        async (client) => {
            const toolName = HELPER_TOOLS.DOCS_FETCH;

            const result = await client.callTool({
                name: toolName,
                arguments: {
                    url: 'https://docs.apify.com/platform/actors/development',
                },
            });

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HELPER_TOOLS.DOCS_FETCH, 'default');
        },
    );

    itc('should list all prompts', undefined, async (client) => {
        const prompts = await client.listPrompts();
        expect(prompts.prompts.length).toBe(0);
    });

    // Session termination is only possible for streamable HTTP transport.
    it.runIf(transport === 'streamable-http')('should successfully terminate streamable session', async () => {
        let client: McpSuiteClient | undefined;
        try {
            client = await createClientFn();
            await client.listTools();
            await expect(
                (asLegacyClient(client).transport as StreamableHTTPClientTransport).terminateSession(),
            ).resolves.toBeUndefined();
        } finally {
            await client?.close();
        }
    });

    itc(
        'should connect to MCP server and at least one tool is available',
        { tools: [ACTOR_EXAMPLE_MCP_SERVER] },
        async (client) => {
            const tools = await client.listTools();
            expect(tools.tools.length).toBeGreaterThan(0);
        },
    );

    it.runIf(transport === 'streamable-http')(
        'should serve call-actor when a dynamic-tools client selects the actors category',
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ clientName: 'Visual Studio Code', tools: ['actors'] });
                const names = getToolNames(await client.listTools());

                // call-actor is served for a dynamic-tools-capable client
                expect(names).toContain('call-actor');
            } finally {
                await client?.close();
            }
        },
    );

    it.runIf(transport === 'streamable-http')(
        `should serve call-actor for a dynamic-tools client with the default tool set`,
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ clientName: 'Visual Studio Code' });
                const names = getToolNames(await client.listTools());

                // call-actor is served for a dynamic-tools-capable client
                expect(names).toContain('call-actor');
            } finally {
                await client?.close();
            }
        },
    );

    it.runIf(transport === 'streamable-http')(
        `should serve call-actor for a dynamic-tools client that selects call-actor explicitly`,
        async () => {
            let client: McpSuiteClient | undefined;
            try {
                client = await createClientFn({ clientName: 'Visual Studio Code', tools: ['call-actor'] });
                const names = getToolNames(await client.listTools());

                // call-actor is served for a dynamic-tools-capable client
                expect(names).toContain('call-actor');
            } finally {
                await client?.close();
            }
        },
    );

    itc(
        'should return error message when trying to call MCP server Actor without tool name in actor parameter',
        { tools: ['actors'] },
        async (client) => {
            const response = await client.callTool({
                name: 'call-actor',
                arguments: {
                    actor: ACTOR_EXAMPLE_MCP_SERVER,
                    input: { firstNumber: 1, secondNumber: 2 },
                },
            });

            const content = response.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG);
            expect(response.isError).toBe(true);
        },
    );
}
