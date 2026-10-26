import { describe, expect, it, vi } from 'vitest';

import { CHATGPT_SUBMISSION_TOOLS, CHATGPT_SUBMISSION_URL } from '../../src/chatgpt_submission.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { parseInputParamsFromUrl } from '../../src/mcp/utils.js';
import { getToolPublicFieldOnly } from '../../src/utils/tools.js';
import { getToolsForServerMode } from '../../src/utils/tools_loader.js';
import { getLegacyServer, getRequestHandler, withServer, withStatelessServer } from './helpers/mcp_server.js';
import { mockApifyClient } from './helpers/tool_context.js';

// Literal review inventory: adding a tool requires an explicit submission-contract change.
const EXPECTED_TOOL_NAMES = [
    'chatgpt-web-search',
    'chatgpt-web-fetch',
    'chatgpt-website-content',
    'chatgpt-screenshot',
    'chatgpt-sitemap',
    'chatgpt-google-maps',
    'chatgpt-amazon-products',
    'chatgpt-youtube',
    'chatgpt-tiktok',
    'chatgpt-instagram',
    'chatgpt-facebook-posts',
    'chatgpt-booking',
    'chatgpt-tripadvisor',
    'create-private-actor',
    'get-private-actor-version',
    'create-private-actor-version',
    'update-private-actor-version',
    'build-private-actor',
    'get-private-actor-build',
    'get-private-actor-build-list',
    'get-private-actor-build-log',
    'run-owned-actor',
    'get-actor-run',
    'get-actor-run-log',
    'abort-actor-run',
    'get-dataset-items',
    'get-key-value-store-record',
    'search-apify-docs',
    'fetch-apify-docs',
].sort();

describe('ChatGPT submission contract', () => {
    it('loads exactly the reviewed inventory in both server modes without fetching Actor schemas', () => {
        const input = parseInputParamsFromUrl(CHATGPT_SUBMISSION_URL);
        const normal = getToolsForServerMode(input, [], 'default');
        const apps = getToolsForServerMode(input, [], 'apps');
        expect(normal.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
        expect(apps.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
        const context = { presentTools: new Set(normal.map((tool) => tool.name)) };
        expect(apps.map((tool) => getToolPublicFieldOnly(tool, context))).toEqual(
            normal.map((tool) => getToolPublicFieldOnly(tool, context)),
        );
        expect([...CHATGPT_SUBMISSION_TOOLS].sort()).toEqual(EXPECTED_TOOL_NAMES);
    });

    it('keeps restricted tools out of existing default selections and categories', () => {
        const categories = ['actors', 'docs', 'runs', 'storage', 'builds', 'versions'];
        const tools = getToolsForServerMode({ tools: categories }, [], 'default');
        expect(tools.some((tool) => tool.name === HELPER_TOOLS.OWNED_ACTOR_RUN)).toBe(false);
        expect(tools.some((tool) => tool.name.startsWith('chatgpt-'))).toBe(false);
    });

    it('does not change tools when the attribution parameter changes', () => {
        const withoutAttribution = CHATGPT_SUBMISSION_URL.replace('&client=openai', '');
        const names = (url: string) =>
            getToolsForServerMode(parseInputParamsFromUrl(url), [], 'default').map((tool) => tool.name);
        expect(names(withoutAttribution)).toEqual(names(CHATGPT_SUBMISSION_URL));
    });

    it('closes generic resources and unrelated prompts on the stateful transport', async () => {
        await withServer(
            async (server) => {
                await server.loadToolsFromUrl(CHATGPT_SUBMISSION_URL, mockApifyClient({}));
                const listing = await getRequestHandler(server, 'tools/list')({ method: 'tools/list' }, {});
                expect((listing.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
                    EXPECTED_TOOL_NAMES,
                );
                expect(await server.resourceService.listResourceTemplates()).toEqual({ resourceTemplates: [] });
                expect(await server.resourceService.listResources()).toEqual({ resources: [] });
                await expect(server.resourceService.readResource('https://api.apify.com/v2/users/me')).rejects.toThrow(
                    'unavailable',
                );
                expect(server.promptService.listPrompts()).toEqual({ prompts: [] });
                expect(server.getServerInstructions()).not.toContain('resources/read');
                expect(server.getServerInstructions()).not.toContain('Search the Apify Store first');
            },
            { serverMode: 'default' },
        );
    });

    it('enforces the same resource boundary in stateless request snapshots', async () => {
        await withStatelessServer(
            async ({ server, call }) => {
                await server.loadToolsFromUrl(CHATGPT_SUBMISSION_URL, mockApifyClient({}));
                const listing = await call('tools/list');
                expect(((listing.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
                    EXPECTED_TOOL_NAMES,
                );
                expect((await call('resources/templates/list')).result).toMatchObject({ resourceTemplates: [] });
                expect((await call('resources/list')).result).toMatchObject({ resources: [] });
                expect((await call('resources/read', { uri: 'https://api.apify.com/v2/users/me' })).error?.code).toBe(
                    -32602,
                );
                expect((await call('prompts/list')).result).toMatchObject({ prompts: [] });
            },
            { serverMode: 'auto' },
        );
    });

    it('preserves API resources for a custom configuration explicitly selecting the API read tool', async () => {
        await withServer(
            async (server) => {
                await server.loadToolsByName(
                    [HELPER_TOOLS.OWNED_ACTOR_RUN, HELPER_TOOLS.API_READ],
                    mockApifyClient({}),
                );
                expect((await server.resourceService.listResourceTemplates()).resourceTemplates.length).toBeGreaterThan(
                    0,
                );
                expect(server.getServerInstructions()).toContain('resources/read');
            },
            { serverMode: 'default' },
        );
    });

    it('rejects excluded input before a run and withholds unapproved releases through both adapters', async () => {
        const invalidCases = [
            { name: HELPER_TOOLS.CHATGPT_WEB_SEARCH, arguments: { query: 'test', actorId: 'unapproved' } },
            { name: HELPER_TOOLS.DATASET_GET_ITEMS, arguments: { datasetId: 'test', limit: 101 } },
            { name: HELPER_TOOLS.ACTOR_RUNS_LOG, arguments: { runId: 'test', lines: 0 } },
        ];
        const unapproved = { name: HELPER_TOOLS.CHATGPT_WEB_SEARCH, arguments: { query: 'test' } };
        await withServer(
            async (server) => {
                await server.loadToolsFromUrl(CHATGPT_SUBMISSION_URL, mockApifyClient({}));
                vi.spyOn(getLegacyServer(server), 'sendLoggingMessage').mockResolvedValue(undefined);
                const call = (params: Record<string, unknown>) =>
                    getRequestHandler(server, 'tools/call')(
                        { method: 'tools/call', params: { ...params, _meta: { mcpSessionId: 'submission-test' } } },
                        { signal: new AbortController().signal, sendNotification: vi.fn() },
                    );
                for (const params of invalidCases) {
                    await expect(call(params)).rejects.toMatchObject({ code: -32602 });
                }
                const result = await call(unapproved);
                expect(result.isError).toBe(true);
                expect(JSON.stringify(result)).toContain('no valid approval');
            },
            { serverMode: 'default' },
        );
        await withStatelessServer(async ({ server, call }) => {
            await server.loadToolsFromUrl(CHATGPT_SUBMISSION_URL, mockApifyClient({}));
            for (const params of invalidCases) {
                const response = await call('tools/call', params);
                expect(response.error?.code).toBe(-32602);
            }
            const response = await call('tools/call', unapproved);
            expect(response.result?.isError).toBe(true);
            expect(JSON.stringify(response.result)).toContain('no valid approval');
        });
    });
});
