import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import { callActorPreExecute, executeCallActor } from '../../src/tools/actors/call_actor.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';
import type { ToolResponse } from '../../src/utils/mcp.js';
import { withServer } from './helpers/mcp_server.js';
import { textOf, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

vi.mock('../../src/mcp/client.js', () => ({
    connectMCPClient: vi.fn(async () => ({
        listTools: async () => ({
            tools: [{ name: 'add', description: 'adds', inputSchema: { type: 'object', properties: {} } }],
        }),
        close: async () => {},
    })),
}));

const NON_EMPTY_INPUT = { type: 'object', properties: { url: { type: 'string', description: 'a url' } } };

/** Every cell of the decision table, seeded as a public Actor so the cache's owner gate is bypassed. */
const RUN_ONLY = 'acme/run-only';
const RUN_ONLY_STALE_PATH = 'acme/run-only-stale-path';
const STANDBY_MCP = 'acme/standby-mcp';
const STANDBY_INPUT = 'acme/standby-input';
const STANDBY_EMPTY = 'acme/standby-empty';
/** The unsupported cell addressed by its Actor ID — an identifier that is not the canonical `username/name`. */
const STANDBY_EMPTY_ID = 'aBcD1234';
/** A run-only Actor addressed by its Actor ID. */
const RUN_ONLY_ID = 'zXyW9876';

function seedActor(
    name: string,
    opts: { webServerMcpPath?: string; isStandbyEnabled?: boolean; input?: unknown; cacheKey?: string },
): void {
    const id = name.replace('/', '-');
    actorDefinitionCache.set(opts.cacheKey ?? name, {
        definition: {
            id,
            actorFullName: name,
            description: 'test Actor',
            defaultRunOptions: { memoryMbytes: 1024 },
            ...(opts.webServerMcpPath && { webServerMcpPath: opts.webServerMcpPath }),
            ...(opts.input !== undefined && { input: opts.input }),
        },
        info: {
            id,
            isPublic: true,
            userId: 'owner',
            ...(opts.isStandbyEnabled && { actorStandby: { isEnabled: true } }),
        },
    } as unknown as ActorDefinitionWithInfo);
}

/** Tool names the server holds after loading exactly one Actor. */
async function loadedToolNames(actorFullName: string): Promise<string[]> {
    return withServer(async (server) => {
        await server.loadToolsByName([actorFullName], new ApifyClient({ token: 'test-token' }));
        return [...server.tools.keys()];
    });
}

function callActor(actor: string): Promise<ToolResponse> {
    return executeCallActor(stubToolCallContext({ actor, input: {} }, new ApifyClient({ token: 'test-token' })));
}

function preExecute(actor: string) {
    return callActorPreExecute(stubToolCallContext({ actor, input: {} }, new ApifyClient({ token: 'test-token' })), {
        route: HELPER_TOOLS.ACTOR_CALL,
    });
}

function firstText(response: ToolResponse): string {
    return textOf((response as TextToolResult).content[0]);
}

beforeEach(() => {
    seedActor(RUN_ONLY, { input: NON_EMPTY_INPUT });
    seedActor(RUN_ONLY_STALE_PATH, { webServerMcpPath: '/mcp', input: NON_EMPTY_INPUT });
    seedActor(STANDBY_MCP, { webServerMcpPath: '/mcp', isStandbyEnabled: true, input: NON_EMPTY_INPUT });
    seedActor(STANDBY_INPUT, { isStandbyEnabled: true, input: NON_EMPTY_INPUT });
    seedActor(STANDBY_EMPTY, { isStandbyEnabled: true });
    seedActor(STANDBY_EMPTY, { isStandbyEnabled: true, cacheKey: STANDBY_EMPTY_ID });
    seedActor(RUN_ONLY, { input: NON_EMPTY_INPUT, cacheKey: RUN_ONLY_ID });
});

describe('Actor run/standby mode decision table', () => {
    describe('tools/list surface', () => {
        it('loads a run tool for a run-only Actor', async () => {
            expect(await loadedToolNames(RUN_ONLY)).toEqual(['acme--run-only']);
        });

        it('loads a run tool for a run-only Actor carrying a leftover webServerMcpPath', async () => {
            expect(await loadedToolNames(RUN_ONLY_STALE_PATH)).toEqual(['acme--run-only-stale-path']);
        });

        it('loads only proxied MCP tools for a standby Actor exposing an MCP server', async () => {
            expect(await loadedToolNames(STANDBY_MCP)).toEqual(['acme--standby-mcp--add']);
        });

        it('loads a run tool for a standby Actor with no MCP server but a non-empty input schema', async () => {
            expect(await loadedToolNames(STANDBY_INPUT)).toEqual(['acme--standby-input']);
        });

        it('loads no tool for a standby Actor with no MCP server and an empty input schema', async () => {
            expect(await loadedToolNames(STANDBY_EMPTY)).toEqual([]);
        });
    });

    describe('call-actor routing', () => {
        it('runs a run-only Actor with a leftover webServerMcpPath instead of demanding a tool name', async () => {
            const result = await preExecute(RUN_ONLY_STALE_PATH);

            expect('earlyResponse' in result).toBe(false);
        });

        it('answers "is not an MCP server" for the actor:tool shape on a run-only Actor with a leftover path', async () => {
            const result = await preExecute(`${RUN_ONLY_STALE_PATH}:add`);

            expect('earlyResponse' in result).toBe(true);
            expect(firstText((result as { earlyResponse: ToolResponse }).earlyResponse)).toContain(
                'is not an MCP server',
            );
        });

        it('demands a tool name for a bare call on a standby Actor exposing an MCP server', async () => {
            const result = await preExecute(STANDBY_MCP);

            expect('earlyResponse' in result).toBe(true);
            expect(firstText((result as { earlyResponse: ToolResponse }).earlyResponse)).toContain('tool name');
        });

        it('answers the canonical standby-without-MCP message for both call shapes on the unsupported cell', async () => {
            const bare = await callActor(STANDBY_EMPTY);
            const withToolName = await preExecute(`${STANDBY_EMPTY}:add`);

            expect('earlyResponse' in withToolName).toBe(true);
            const withToolNameText = firstText((withToolName as { earlyResponse: ToolResponse }).earlyResponse);

            expect(firstText(bare)).toBe(withToolNameText);
            expect(withToolNameText).toContain('standby mode without an MCP server');
            expect(bare.isError).toBe(true);
            expect((withToolName as { earlyResponse: ToolResponse }).earlyResponse.isError).toBe(true);
        });

        it('answers with the canonical Actor name for both call shapes when addressed by Actor ID', async () => {
            const bare = await callActor(STANDBY_EMPTY_ID);
            const withToolName = await preExecute(`${STANDBY_EMPTY_ID}:add`);

            expect('earlyResponse' in withToolName).toBe(true);
            const withToolNameText = firstText((withToolName as { earlyResponse: ToolResponse }).earlyResponse);

            expect(firstText(bare)).toBe(withToolNameText);
            expect(withToolNameText).toContain(STANDBY_EMPTY);
            expect(withToolNameText).not.toContain(STANDBY_EMPTY_ID);
        });

        it('answers "is not an MCP server" with the canonical Actor name when addressed by Actor ID', async () => {
            const result = await preExecute(`${RUN_ONLY_ID}:add`);

            expect('earlyResponse' in result).toBe(true);
            const text = firstText((result as { earlyResponse: ToolResponse }).earlyResponse);
            expect(text).toContain(RUN_ONLY);
            expect(text).not.toContain(RUN_ONLY_ID);
        });

        it('keeps the unsupported-cell message distinct from the "is not an MCP server" wording', async () => {
            const unsupported = await preExecute(`${STANDBY_EMPTY}:add`);
            const runOnly = await preExecute(`${RUN_ONLY_STALE_PATH}:add`);

            const unsupportedText = firstText((unsupported as { earlyResponse: ToolResponse }).earlyResponse);
            const runOnlyText = firstText((runOnly as { earlyResponse: ToolResponse }).earlyResponse);

            expect(unsupportedText).not.toBe(runOnlyText);
            expect(unsupportedText).not.toContain('is not an MCP server');
        });
    });
});
