import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS, WEB_SEARCH } from '../../src/const.js';
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

function seedActor(
    name: string,
    opts: {
        webServerMcpPath?: string;
        isStandbyEnabled?: boolean;
        hasWebServerSchema?: boolean;
        input?: unknown;
        cacheKey?: string;
    },
): void {
    const id = name.replace('/', '-');
    actorDefinitionCache.set(opts.cacheKey ?? name, {
        definition: {
            id,
            actorFullName: name,
            description: 'test Actor',
            defaultRunOptions: { memoryMbytes: 1024 },
            ...(opts.webServerMcpPath && { webServerMcpPath: opts.webServerMcpPath }),
            hasWebServerSchema: opts.hasWebServerSchema,
            ...(opts.input !== undefined && { input: opts.input }),
        },
        info: {
            id,
            isPublic: true,
            userId: 'owner',
            ...(opts.isStandbyEnabled && {
                actorStandby: { isEnabled: true },
                standbyUrl: `https://${id}.apify.actor`,
            }),
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

function preExecute(actor: string, loadedToolNames?: string[]) {
    return callActorPreExecute(
        stubToolCallContext({ actor, input: {} }, new ApifyClient({ token: 'test-token' }), { loadedToolNames }),
        { route: HELPER_TOOLS.ACTOR_CALL },
    );
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
    seedActor(WEB_SEARCH, { webServerMcpPath: '/mcp', isStandbyEnabled: true, input: NON_EMPTY_INPUT });
    seedActor(STANDBY_INPUT, { isStandbyEnabled: true, input: NON_EMPTY_INPUT });
    seedActor(STANDBY_EMPTY, { isStandbyEnabled: true });
    seedActor(STANDBY_EMPTY, { isStandbyEnabled: true, cacheKey: STANDBY_EMPTY_ID });
});

describe('Actor run/standby mode decision table', () => {
    // One row per cell of the decision table: which tools the Actor contributes to tools/list.
    it.each([
        ['a run-only Actor', RUN_ONLY, ['acme--run-only']],
        ['a run-only Actor carrying a leftover webServerMcpPath', RUN_ONLY_STALE_PATH, ['acme--run-only-stale-path']],
        ['a standby Actor exposing an MCP server (proxied tools only)', STANDBY_MCP, ['acme--standby-mcp--add']],
        ['an input-interface Actor carrying an MCP path', WEB_SEARCH, ['apify--web-search']],
        ['a standby Actor with no MCP server but a non-empty input schema', STANDBY_INPUT, ['acme--standby-input']],
        ['a standby Actor with no MCP server and an empty input schema', STANDBY_EMPTY, []],
    ])('tools/list surface for %s', async (_label, actor, expected) => {
        expect(await loadedToolNames(actor)).toEqual(expected);
    });

    describe('call-actor routing', () => {
        it.each([RUN_ONLY_STALE_PATH, WEB_SEARCH])(
            'runs %s through its input schema despite its MCP path',
            async (actor) => {
                const result = await preExecute(actor);

                expect('earlyResponse' in result).toBe(false);
            },
        );

        it('runs a standby Actor with no MCP server but a non-empty input schema', async () => {
            const result = await preExecute(STANDBY_INPUT);

            expect('earlyResponse' in result).toBe(false);
        });

        it('rejects a standby Actor exposing an MCP server, naming call-actor-mcp-tool only when the session has it', async () => {
            const withMcpTool = earlyResponseOf(await preExecute(STANDBY_MCP));
            const withoutMcpTool = earlyText(await preExecute(STANDBY_MCP, [HELPER_TOOLS.ACTOR_CALL]));

            expect(firstText(withMcpTool)).toContain(
                `Its MCP tools can be called with ${HELPER_TOOLS.ACTOR_MCP_TOOL_CALL}.`,
            );
            expect(withMcpTool.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
                }),
            );
            expect(withoutMcpTool).not.toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
            // No dead end: without the tool, the remedy is the session's own configuration.
            expect(withoutMcpTool).toContain('cannot be called in this configuration');
        });

        it('rejects removed syntax even when the Actor is unknown', async () => {
            const text = earlyText(await preExecute('apify/unknown-actor:add'));

            expect(text).toContain('no longer supported');
            expect(text).toContain(HELPER_TOOLS.ACTOR_MCP_TOOL_CALL);
        });

        it('rejects an unsupported standby Actor during pre-execution, with its canonical name when addressed by Actor ID', async () => {
            const text = earlyText(await preExecute(STANDBY_EMPTY_ID));

            expect(text).toContain('has no MCP tools or input interface');
            expect(text).toContain(STANDBY_EMPTY);
            expect(text).not.toContain(STANDBY_EMPTY_ID);
        });

        it.each([true, false])('names the HTTP request tool only when loaded: %s', async (hasRequestTool) => {
            seedActor(STANDBY_EMPTY, { isStandbyEnabled: true, hasWebServerSchema: true });
            const client = new ApifyClient({ token: 'test-token' });
            const options = {
                loadedToolNames: hasRequestTool ? [HELPER_TOOLS.ACTOR_SERVER_REQUEST] : [],
            };
            const bare = await executeCallActor(
                stubToolCallContext({ actor: STANDBY_EMPTY, input: {} }, client, options),
            );
            const text = firstText(bare);
            expect(text.includes(HELPER_TOOLS.ACTOR_SERVER_REQUEST)).toBe(hasRequestTool);
            expect(text).toContain('has no MCP tools or input interface');
            expect(bare.toolTelemetry).toMatchObject({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
            });
        });
    });
});
