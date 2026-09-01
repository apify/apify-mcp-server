import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { actorDefinitionCache } from '../../src/state.js';
import { callActorPreExecute, executeCallActor } from '../../src/tools/actors/call_actor.js';
import type { ActorDefinitionWithInfo } from '../../src/types.js';
import type { ToolResponse } from '../../src/utils/mcp.js';
import { withServer } from './helpers/mcp_server.js';
import { textOf, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

// Any Actor not seeded into the definition cache is unknown; the fetch fallback must not hit the network.
vi.mock('../../src/tools/actors/actor_definition.js', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../src/tools/actors/actor_definition.js');
    return { ...actual, getActorDefinition: vi.fn(async () => null) };
});

vi.mock('../../src/mcp/client.js', () => ({
    connectMCPClient: vi.fn(async () => ({
        listTools: async () => ({
            tools: [{ name: 'add', description: 'adds', inputSchema: { type: 'object', properties: {} } }],
        }),
        callTool: async () => ({ content: [{ type: 'text', text: 'MCP result' }] }),
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

/** Asserts the pre-execution stopped early, and returns the response it answered with. */
function earlyResponseOf(result: Awaited<ReturnType<typeof preExecute>>): ToolResponse {
    expect('earlyResponse' in result).toBe(true);
    return (result as { earlyResponse: ToolResponse }).earlyResponse;
}

function earlyText(result: Awaited<ReturnType<typeof preExecute>>): string {
    return firstText(earlyResponseOf(result));
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
    // One row per cell of the decision table: which tools the Actor contributes to tools/list.
    it.each([
        ['a run-only Actor', RUN_ONLY, ['acme--run-only']],
        ['a run-only Actor carrying a leftover webServerMcpPath', RUN_ONLY_STALE_PATH, ['acme--run-only-stale-path']],
        ['a standby Actor exposing an MCP server (proxied tools only)', STANDBY_MCP, ['acme--standby-mcp--add']],
        ['a standby Actor with no MCP server but a non-empty input schema', STANDBY_INPUT, ['acme--standby-input']],
        ['a standby Actor with no MCP server and an empty input schema', STANDBY_EMPTY, []],
    ])('tools/list surface for %s', async (_label, actor, expected) => {
        expect(await loadedToolNames(actor)).toEqual(expected);
    });

    describe('call-actor routing', () => {
        it('runs a run-only Actor with a leftover webServerMcpPath instead of demanding a tool name', async () => {
            const result = await preExecute(RUN_ONLY_STALE_PATH);

            expect('earlyResponse' in result).toBe(false);
        });

        it('answers "is not an MCP server" for the actor:tool shape on a run-only Actor with a leftover path', async () => {
            const result = await preExecute(`${RUN_ONLY_STALE_PATH}:add`);

            expect(earlyText(result)).toContain('is not an MCP server');
        });

        it('records the "is not an MCP server" rejection as a caller mistake, not a server fault', async () => {
            const result = await preExecute(`${RUN_ONLY_STALE_PATH}:add`);

            expect(earlyResponseOf(result).toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                }),
            );
        });

        it('runs a standby Actor with no MCP server but a non-empty input schema', async () => {
            const result = await preExecute(STANDBY_INPUT);

            expect('earlyResponse' in result).toBe(false);
        });

        it('rejects the actor:tool shape for a standby Actor with no MCP server but a non-empty input schema', async () => {
            const result = await preExecute(`${STANDBY_INPUT}:add`);

            expect(earlyText(result)).toContain('is not an MCP server');
        });

        it('demands a tool name for a bare call on a standby Actor exposing an MCP server', async () => {
            const result = await preExecute(STANDBY_MCP);

            expect(earlyText(result)).toContain('tool name');
        });

        it('proxies an MCP tool call on a standby Actor exposing an MCP server', async () => {
            const result = await callActor(`${STANDBY_MCP}:add`);

            expect(firstText(result)).toBe('MCP result');
            expect(result.isError).toBe(false);
        });

        it('rejects a bare unsupported standby Actor during pre-execution', async () => {
            const result = await preExecute(STANDBY_EMPTY);

            expect('earlyResponse' in result).toBe(true);
        });

        it('answers the canonical standby-without-MCP message for both call shapes on the unsupported cell', async () => {
            const bare = await callActor(STANDBY_EMPTY);
            const withToolName = await preExecute(`${STANDBY_EMPTY}:add`);

            const withToolNameText = earlyText(withToolName);

            expect(firstText(bare)).toBe(withToolNameText);
            expect(withToolNameText).toContain('standby mode without an MCP server');
            expect(bare.isError).toBe(true);
            expect(earlyResponseOf(withToolName).isError).toBe(true);
        });

        it('answers with the canonical Actor name for both call shapes when addressed by Actor ID', async () => {
            const bare = await callActor(STANDBY_EMPTY_ID);
            const withToolName = await preExecute(`${STANDBY_EMPTY_ID}:add`);

            const withToolNameText = earlyText(withToolName);

            expect(firstText(bare)).toBe(withToolNameText);
            expect(withToolNameText).toContain(STANDBY_EMPTY);
            expect(withToolNameText).not.toContain(STANDBY_EMPTY_ID);
        });

        it('answers "is not an MCP server" with the canonical Actor name when addressed by Actor ID', async () => {
            const result = await preExecute(`${RUN_ONLY_ID}:add`);

            expect('earlyResponse' in result).toBe(true);
            const text = earlyText(result);
            expect(text).toContain(RUN_ONLY);
            expect(text).not.toContain(RUN_ONLY_ID);
        });

        it('answers not-found instead of "is not an MCP server" for the actor:tool shape on an unknown Actor', async () => {
            const result = await preExecute('acme/ghost:add');

            const text = earlyText(result);
            expect(text).toContain("Actor 'acme/ghost' was not found");
            expect(text).not.toContain('is not an MCP server');
        });

        it('keeps the unsupported-cell message distinct from the "is not an MCP server" wording', async () => {
            const unsupported = await preExecute(`${STANDBY_EMPTY}:add`);
            const runOnly = await preExecute(`${RUN_ONLY_STALE_PATH}:add`);

            const unsupportedText = earlyText(unsupported);
            const runOnlyText = earlyText(runOnly);

            expect(unsupportedText).not.toBe(runOnlyText);
            expect(unsupportedText).not.toContain('is not an MCP server');
        });
    });
});
