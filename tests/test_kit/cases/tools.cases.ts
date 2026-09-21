import type { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';

import { CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG, HELPER_TOOLS } from '@apify/actors-mcp-server/internals/test-kit.js';

import {
    ACTOR_EXAMPLE_MCP_SERVER,
    buildExampleMcpServerAddToolContent,
    getToolNames,
    skipOnStatefulEra,
    skipUnlessLegacyHttp,
    skipUnlessStatefulEra,
    validateStructuredOutputForTool,
    withClient,
} from '../helpers.js';
import type { Case } from '../types.js';

/** Protocol/tool behavior: prompts, docs, report-problem, schemas, MCP passthrough. */
export const toolsCases: Case[] = [
    {
        // telemetry off → report-problem absent; serve/hide paths are unit-tested.
        name: 'report-problem is not served when telemetry is disabled',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
        }),
    },
    {
        name: 'should return outputSchema, title, and icons in tools list response',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            const response = await client.listTools();

            // Find a tool with outputSchema (e.g., search-apify-docs)
            const searchApiifyDocsTool = response.tools.find((tool) => tool.name === 'search-apify-docs');
            expect(searchApiifyDocsTool).toBeDefined();

            // Verify that outputSchema is present
            expect(typeof searchApiifyDocsTool?.outputSchema).toBe('object');
            expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('type');
            expect(searchApiifyDocsTool?.outputSchema).toHaveProperty('properties');
        }),
    },
    {
        // Regression #415: after listTools caches validators, MCP passthrough must return structuredContent.
        name: 'MCP server actor:tool pass-through returns structuredContent satisfying outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            // Populates the SDK's `_cachedToolOutputValidators` map so callTool runs schema validation.
            await client.listTools();

            const callResult = await client.callTool({
                name: HELPER_TOOLS.ACTOR_CALL,
                arguments: { actor: `${ACTOR_EXAMPLE_MCP_SERVER}:add`, input: { firstNumber: 2, secondNumber: 3 } },
            });

            // Passthrough has no Apify run — expect sentinel structuredContent fields.
            const sc = (callResult as { structuredContent?: Record<string, unknown> }).structuredContent;
            expect(sc).toBeDefined();
            expect(sc).toHaveProperty('runId');
            expect(sc).toHaveProperty('actorId');
            expect(sc).toHaveProperty('status');
            expect(sc).toHaveProperty('storages');
            expect(sc).toHaveProperty('summary');
            expect(sc).toHaveProperty('nextStep');

            // Remote payload must still flow through content.
            const content = callResult.content as { text: string }[];
            expect(content).toEqual(buildExampleMcpServerAddToolContent(2, 3));

            // isError must be forwarded from the remote tool.
            expect(callResult.isError ?? false).toBe(false);
        }),
    },
    {
        name: 'should search Apify documentation',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const toolName = HELPER_TOOLS.DOCS_SEARCH;
            const query = 'standby actor';
            const result = await client.callTool({ name: toolName, arguments: { query, limit: 5, offset: 0 } });

            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            // Should contain at least one apify docs url
            const standbyDocUrl = 'https://docs.apify.com';
            expect(content.some((item) => item.text.includes(standbyDocUrl))).toBe(true);
        }),
    },
    {
        name: 'should fetch Apify documentation page',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const documentUrl = 'https://docs.apify.com/academy/getting-started/creating-actors';
            const result = await client.callTool({ name: HELPER_TOOLS.DOCS_FETCH, arguments: { url: documentUrl } });

            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(documentUrl);
        }),
    },
    {
        name: 'should reject fetch-apify-docs with forbidden URL (not from allowed domains)',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const forbiddenUrl = 'https://example.com/some-page';
            const result = await client.callTool({ name: HELPER_TOOLS.DOCS_FETCH, arguments: { url: forbiddenUrl } });

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);
            // Verify it's an error response
            expect(result.isError).toBe(true);
            // Verify the error message contains helpful information
            expect(content[0].text).toContain('Invalid URL');
            expect(content[0].text).toContain('https://docs.apify.com');
            expect(content[0].text).toContain('https://crawlee.dev');
        }),
    },
    {
        name: 'should allow fetch-apify-docs from Crawlee domain (https://crawlee.dev)',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const crawleeDocsUrl = 'https://crawlee.dev/js/docs/quick-start';
            const result = await client.callTool({ name: HELPER_TOOLS.DOCS_FETCH, arguments: { url: crawleeDocsUrl } });

            // Should not have error status
            expect(result.isError).not.toBe(true);
            const content = result.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            // Verify the response contains the URL we fetched
            expect(content[0].text).toContain('Fetched content from');
        }),
    },
    {
        name: 'should return structured output for search-apify-docs matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const toolName = HELPER_TOOLS.DOCS_SEARCH;
            const query = 'standby actor';
            const result = await client.callTool({ name: toolName, arguments: { query, limit: 5, offset: 0 } });

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HELPER_TOOLS.DOCS_SEARCH, 'default');
        }),
    },
    {
        name: 'should return structured output for fetch-apify-docs matching outputSchema',
        isDeploymentTest: false,
        run: withClient({ tools: ['docs'] }, async (client) => {
            const toolName = HELPER_TOOLS.DOCS_FETCH;
            const result = await client.callTool({
                name: toolName,
                arguments: { url: 'https://docs.apify.com/platform/actors/development' },
            });

            const content = result.content as { text: string; isError?: boolean }[];
            expect(content.length).toBeGreaterThan(0);

            validateStructuredOutputForTool(result, HELPER_TOOLS.DOCS_FETCH, 'default');
        }),
    },
    {
        name: 'should list all prompts',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            const prompts = await client.listPrompts();
            expect(prompts.prompts.length).toBe(0);
        }),
    },
    {
        // Session termination is only possible for streamable HTTP transport.
        name: 'should successfully terminate streamable session',
        isDeploymentTest: false,
        skipIf: skipUnlessLegacyHttp,
        run: withClient(undefined, async (client) => {
            await client.listTools();
            await expect(
                ((client as ClientV1).transport as StreamableHTTPClientTransport).terminateSession(),
            ).resolves.toBeUndefined();
        }),
    },
    {
        name: 'should connect to MCP server and at least one tool is available',
        isDeploymentTest: false,
        run: withClient({ tools: [ACTOR_EXAMPLE_MCP_SERVER] }, async (client) => {
            const tools = await client.listTools();
            expect(tools.tools.length).toBeGreaterThan(0);
        }),
    },
    {
        name: 'should serve call-actor when a dynamic-tools client selects the actors category',
        isDeploymentTest: false,
        run: withClient({ clientName: 'Visual Studio Code', tools: ['actors'] }, async (client) => {
            const names = getToolNames(await client.listTools());
            // call-actor is served for a dynamic-tools-capable client
            expect(names).toContain('call-actor');
        }),
    },
    {
        name: 'should serve call-actor for a dynamic-tools client with the default tool set',
        isDeploymentTest: false,
        run: withClient({ clientName: 'Visual Studio Code' }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toContain('call-actor');
        }),
    },
    {
        name: 'should serve call-actor for a dynamic-tools client that selects call-actor explicitly',
        isDeploymentTest: false,
        run: withClient({ clientName: 'Visual Studio Code', tools: ['call-actor'] }, async (client) => {
            const names = getToolNames(await client.listTools());
            expect(names).toContain('call-actor');
        }),
    },
    {
        name: 'should return error message when trying to call MCP server Actor without tool name in actor parameter',
        isDeploymentTest: false,
        run: withClient({ tools: ['actors'] }, async (client) => {
            const response = await client.callTool({
                name: 'call-actor',
                arguments: { actor: ACTOR_EXAMPLE_MCP_SERVER, input: { firstNumber: 1, secondNumber: 2 } },
            });

            const content = response.content as { text: string }[];
            expect(content.length).toBeGreaterThan(0);
            expect(content[0].text).toContain(CALL_ACTOR_MCP_MISSING_TOOL_NAME_MSG);
            expect(response.isError).toBe(true);
        }),
    },
    {
        // Legacy era only: the stateless server prefers the header over `_meta`.
        name: 'overrides the connection token with _meta.apifyToken',
        isDeploymentTest: false,
        skipIf: skipUnlessLegacyHttp,
        run: withClient({ tools: ['storage'] }, async (client) => {
            const response = await client.callTool({
                name: HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
                arguments: {},
                _meta: { apifyToken: 'apify_api_invalid_token' },
            });

            expect(response.isError).toBe(true);
            const content = response.content as { text: string }[];
            expect(content[0].text).toContain('Authentication failed');
        }),
    },
    {
        name: 'exposes serverInfo, instructions and the shared capability set',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            const serverInfo = client.getServerVersion();
            expect(serverInfo?.name).toBe('apify-mcp-server');
            expect(serverInfo?.version).toMatch(/^\d+\.\d+\.\d+/);
            expect(client.getInstructions()).toContain(HELPER_TOOLS.ACTOR_CALL);

            const capabilities = client.getServerCapabilities();
            // #1232: `tools` must stay `{}` (no listChanged).
            expect(capabilities?.tools).toEqual({});
            expect(capabilities?.resources).toEqual({});
            expect(capabilities?.prompts).toEqual({});
        }),
    },
    {
        name: 'declares tasks and logging capabilities on the stateful era',
        isDeploymentTest: false,
        skipIf: skipUnlessStatefulEra,
        run: withClient(undefined, async (client) => {
            const capabilities = client.getServerCapabilities();
            expect(capabilities?.logging).toEqual({});
            // `SuiteClient` is v1|v2; only v1 reaches here.
            expect(capabilities?.tasks as unknown).toEqual({
                list: {},
                cancel: {},
                requests: { tools: { call: {} } },
            });
        }),
    },
    {
        // Complements the case above so a 2026-07-28 leak is not skipped away (SEP-2577).
        name: 'omits tasks and logging capabilities on the stateless era',
        isDeploymentTest: false,
        skipIf: skipOnStatefulEra,
        run: withClient(undefined, async (client) => {
            const capabilities = client.getServerCapabilities();
            expect(capabilities?.logging).toBeUndefined();
            expect(capabilities?.tasks).toBeUndefined();
        }),
    },
    {
        // v2 client refuses ping; the request never reaches the server.
        name: 'answers ping on the stateful era',
        isDeploymentTest: false,
        skipIf: skipUnlessStatefulEra,
        run: withClient(undefined, async (client) => {
            await expect(client.ping()).resolves.toEqual({});
        }),
    },
    {
        name: 'rejects tools/call with an unknown tool name',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            // Protocol error, not an isError result — the name never resolves to a tool.
            await expect(client.callTool({ name: 'no-such-tool', arguments: {} })).rejects.toMatchObject({
                code: ErrorCode.InvalidParams,
                message: expect.stringContaining('Tool "no-such-tool" was not found'),
            });
        }),
    },
    {
        name: 'rejects prompts/get with an unknown prompt name',
        isDeploymentTest: false,
        run: withClient(undefined, async (client) => {
            // Wording differs from the tool path above ("not found", no "was"), so pin the whole
            // phrase rather than a substring that looks shared but is not.
            await expect(client.getPrompt({ name: 'no-such-prompt' })).rejects.toMatchObject({
                code: ErrorCode.InvalidParams,
                message: expect.stringContaining('Prompt no-such-prompt not found'),
            });
        }),
    },
];
