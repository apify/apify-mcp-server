import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { HELPER_TOOLS, SERVER_MODE_AUTO_DETECTION_ENABLED } from '../../src/const.js';
import type { ActorsMcpServer } from '../../src/mcp/server.js';
import type * as WidgetsModule from '../../src/resources/widgets.js';
import {
    RESOURCE_MIME_TYPE,
    resolveAvailableWidgets,
    WIDGET_REGISTRY,
    WIDGET_URIS,
} from '../../src/resources/widgets.js';
import * as telemetry from '../../src/telemetry.js';
import type { Input, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActorsFromInput } from '../../src/utils/tools_loader.js';
import { getRequestHandler, makeRecorderTool, withServer, withStatelessServer } from './helpers/mcp_server.js';

// Stub getActorsFromInput so a facade can be given tool sources without a network fetch. The compose path
// (getToolsForServerMode + the report-problem gate) stays real — that is what these tests exercise.
vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActorsFromInput: vi.fn() };
});

// Stub the widget disk scan so apps-mode widget resolution yields a deterministic registry whose
// files "exist" — without it every widget resolves as missing and the resource list stays empty.
vi.mock('../../src/resources/widgets.js', async (importOriginal) => {
    const actual = await importOriginal<typeof WidgetsModule>();
    return { ...actual, resolveAvailableWidgets: vi.fn() };
});

const getActorsFromInputMock = vi.mocked(getActorsFromInput);
const resolveAvailableWidgetsMock = vi.mocked(resolveAvailableWidgets);

async function loadSource(server: ActorsMcpServer, actorTools: ToolEntry[], input: Input = { tools: [] }) {
    getActorsFromInputMock.mockResolvedValue(actorTools);
    await server.loadToolsFromInput(input, {} as never);
}

function toolNames(result: Record<string, unknown> | undefined): string[] {
    return ((result?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
}

function listedTool(result: Record<string, unknown> | undefined, name: string): { description?: string } | undefined {
    return ((result?.tools ?? []) as { name: string; description?: string }[]).find((tool) => tool.name === name);
}

/** An Actor tool distinguishable by description, so a re-composed source can be told from another. */
function makeSourceTool(name: string, description: string): ToolEntry {
    return {
        type: TOOL_TYPE.ACTOR,
        name,
        description,
        inputSchema: { type: 'object', properties: {} } as ToolInputSchema,
        ajvValidate: compileSchema({ type: 'object', properties: {} }),
        actorId: `test/${name}`,
        actorFullName: `test/${name}`,
    } as ToolEntry;
}

/** A stateful handshake driven on the shared facade, to give it a client and a final tool set. */
const LEGACY_INITIALIZE = {
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        capabilities: {},
    },
};

/** The same handshake, declaring the UI capability that resolves `'auto'` server mode to apps. */
const UI_LEGACY_INITIALIZE = {
    method: 'initialize',
    params: {
        ...LEGACY_INITIALIZE.params,
        capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } },
    },
};

/** One resolved widget whose file "exists", as the stubbed disk scan reports it. */
function widgetRegistryWithSearchActors(): Map<string, WidgetsModule.AvailableWidget> {
    return new Map([
        [
            WIDGET_URIS.SEARCH_ACTORS,
            { ...WIDGET_REGISTRY[WIDGET_URIS.SEARCH_ACTORS], jsPath: '/tmp/search-actors.js', exists: true },
        ],
    ]);
}

function resourceUris(result: Record<string, unknown> | undefined): string[] {
    return ((result?.resources ?? []) as { uri: string }[]).map((resource) => resource.uri);
}

describe('createStatelessServer() request context', () => {
    afterEach(() => {
        getActorsFromInputMock.mockReset();
        getActorsFromInputMock.mockResolvedValue([]);
        vi.restoreAllMocks();
    });

    describe('client identity', () => {
        it('resolves client identity from the request envelope, with no session id', async () => {
            const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
            await withStatelessServer(
                async ({ server, call }) => {
                    const { tool } = makeRecorderTool('probe-tool');
                    await loadSource(server, [tool]);

                    const response = await call(
                        'tools/call',
                        { name: 'probe-tool', arguments: {} },
                        { client: { name: 'envelope-client', version: '4.5.6' } },
                    );

                    expect(response.error).toBeUndefined();
                    expect(trackSpy.mock.calls).toHaveLength(1);
                    expect(trackSpy.mock.calls[0][2]).toMatchObject({
                        mcp_client_name: 'envelope-client',
                        mcp_client_version: '4.5.6',
                        mcp_protocol_version: '2026-07-28',
                        // No session exists on this path, so nothing is minted for one.
                        mcp_session_id: '',
                    });
                },
                { token: undefined, allowUnauthMode: true, telemetry: { enabled: true } },
            );
        });

        it('reports the declared client capabilities in telemetry', async () => {
            const trackSpy = vi.spyOn(telemetry, 'trackToolCall').mockImplementation(() => {});
            await withStatelessServer(
                async ({ server, call }) => {
                    const { tool } = makeRecorderTool('probe-tool');
                    await loadSource(server, [tool]);

                    await call('tools/call', { name: 'probe-tool', arguments: {} }, { client: { supportsUi: true } });

                    expect(trackSpy.mock.calls[0][2].mcp_client_capabilities).toMatchObject({
                        extensions: { 'io.modelcontextprotocol/ui': expect.anything() },
                    });
                },
                { token: undefined, allowUnauthMode: true, telemetry: { enabled: true } },
            );
        });
    });

    describe('server mode', () => {
        it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
            'resolves auto mode to apps for a request declaring the UI capability',
            async () => {
                await withStatelessServer(
                    async ({ server, call }) => {
                        await loadSource(server, [], { tools: [HELPER_TOOLS.STORE_SEARCH] });

                        const response = await call('tools/list', {}, { client: { supportsUi: true } });

                        expect(toolNames(response.result)).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
                    },
                    { serverMode: 'auto' },
                );
            },
        );

        it('resolves auto mode to default for a request without the UI capability', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.STORE_SEARCH] });

                    const response = await call('tools/list', {}, { client: { supportsUi: false } });

                    expect(toolNames(response.result)).toContain(HELPER_TOOLS.STORE_SEARCH);
                    expect(toolNames(response.result)).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
                },
                { serverMode: 'auto' },
            );
        });

        it('leaves the shared facade widget map untouched while serving apps-mode widgets', async () => {
            resolveAvailableWidgetsMock.mockResolvedValue(widgetRegistryWithSearchActors());

            await withStatelessServer(
                async ({ server, call }) => {
                    const response = await call('resources/list');

                    // The request itself is served the resolved widget registry...
                    expect(resourceUris(response.result)).toEqual([WIDGET_URIS.SEARCH_ACTORS]);
                    // ...while the facade's own map — what a legacy connection on the same facade
                    // reads through its instance resourceService — is never written to.
                    expect((await server.resourceService.listResources()).resources).toEqual([]);
                },
                { serverMode: 'apps' },
            );
        });

        it('re-runs widget resolution for a later request after a failed first attempt', async () => {
            // The memo exists for speed, not to freeze the answer: before it, every call re-ran the
            // disk scan, so a transient failure (widget files not written yet) could recover on the
            // next one. Caching the failure would silently drop that.
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            resolveAvailableWidgetsMock
                .mockReset()
                .mockRejectedValueOnce(new Error('widget dist not written yet'))
                .mockResolvedValue(widgetRegistryWithSearchActors());

            await withStatelessServer(
                async ({ call }) => {
                    const failed = await call('resources/list');
                    const retried = await call('resources/list');

                    // The failed attempt serves no widgets and is reported, not thrown...
                    expect(resourceUris(failed.result)).toEqual([]);
                    expect(softFail.mock.calls.map(([message]) => String(message))).toContain(
                        'Failed to resolve widgets: widget dist not written yet',
                    );
                    // ...and the next request re-runs the scan instead of reusing the failure.
                    expect(resourceUris(retried.result)).toEqual([WIDGET_URIS.SEARCH_ACTORS]);
                    expect(resolveAvailableWidgetsMock).toHaveBeenCalledTimes(2);
                },
                { serverMode: 'apps' },
            );
        });

        it('reports one failure when concurrent requests share a failed widget resolution', async () => {
            // Concurrent requests awaiting one rejected scan see one root cause, so it must be
            // reported once — not once per awaiter — while the next request stays free to retry.
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            resolveAvailableWidgetsMock
                .mockReset()
                .mockRejectedValueOnce(new Error('widget dist not written yet'))
                .mockResolvedValue(widgetRegistryWithSearchActors());

            await withServer(
                async (server) => {
                    // Driven through the facade, not the HTTP entry: two snapshot builds started in
                    // one tick provably share the in-flight scan, where two HTTP requests would race
                    // and the second could just as well arrive after the first attempt settled.
                    const [first, second] = await Promise.all([
                        server.createRequestSnapshot(undefined),
                        server.createRequestSnapshot(undefined),
                    ]);
                    const retried = await server.createRequestSnapshot(undefined);

                    expect(
                        softFail.mock.calls
                            .map(([message]) => String(message))
                            .filter((message) => message === 'Failed to resolve widgets: widget dist not written yet'),
                    ).toHaveLength(1);
                    // Both callers of the failed attempt are served no widgets...
                    expect((await first.resourceService.listResources()).resources).toEqual([]);
                    expect((await second.resourceService.listResources()).resources).toEqual([]);
                    // ...and the retry the memo drop exists for still happens.
                    expect(
                        (await retried.resourceService.listResources()).resources.map((resource) => resource.uri),
                    ).toEqual([WIDGET_URIS.SEARCH_ACTORS]);
                    expect(resolveAvailableWidgetsMock).toHaveBeenCalledTimes(2);
                },
                { serverMode: 'apps' },
            );
        });

        it('leaves the shared facade mode untouched, whatever a request resolves to', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.STORE_SEARCH] });

                    await call('tools/list', {}, { client: { supportsUi: true } });

                    // The facade keeps its preliminary mode: a request resolves its own view only.
                    expect(server.serverMode).toBe('default');
                    expect(server.clientSupportsUi).toBe(false);
                },
                { serverMode: 'auto' },
            );
        });
    });

    describe('report-problem gating', () => {
        it('serves report-problem to an allowed client', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.PROBLEM_REPORT] });

                    const response = await call('tools/list', {}, { client: { name: 'test-client' } });

                    expect(toolNames(response.result)).toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { telemetry: { enabled: true } },
            );
        });

        it('hides report-problem from a blocklisted client', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.PROBLEM_REPORT] });

                    const response = await call('tools/list', {}, { client: { name: 'claude-ai' } });

                    expect(toolNames(response.result)).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { telemetry: { enabled: true } },
            );
        });

        // `client-info` is optional in the stateless envelope. A request declaring no client name
        // matches no blocked substring and is served the tool by policy.
        it('serves report-problem to a request whose envelope declares no client', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.PROBLEM_REPORT] });

                    const response = await call('tools/list', {}, { client: null });

                    expect(toolNames(response.result)).toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { telemetry: { enabled: true } },
            );
        });

        it('hides report-problem when telemetry is disabled, even for an allowed client', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.PROBLEM_REPORT] });

                    const response = await call('tools/list', {}, { client: { name: 'test-client' } });

                    expect(toolNames(response.result)).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { telemetry: { enabled: false } },
            );
        });
    });

    describe('instructions', () => {
        // Instructions are configuration-level: the SDK answers server/discover from them, fixed
        // before any envelope is seen. They therefore never mention report-problem — while the
        // tool's actual visibility is still decided per request (see the gating tests above).
        it('never mentions report-problem, even when the tool is served', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], { tools: [HELPER_TOOLS.PROBLEM_REPORT] });
                    // Drive the stateful handshake on the same facade first, so its own tool map
                    // really holds report-problem. Without that the assertion below would pass for
                    // the wrong reason: an implementation reading `this.tools` (the legacy pattern)
                    // would also find nothing to mention.
                    await getRequestHandler(server, 'initialize')(LEGACY_INITIALIZE, {});
                    expect(server.tools.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(true);

                    const listed = await call('tools/list', {}, { client: { name: 'test-client' } });
                    const discovered = await call('server/discover', {}, { client: { name: 'test-client' } });

                    // Both must hold at once: the tool is served, and the instructions stay silent.
                    expect(toolNames(listed.result)).toContain(HELPER_TOOLS.PROBLEM_REPORT);
                    expect(discovered.result?.instructions).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { telemetry: { enabled: true } },
            );
        });

        it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
            'keeps instructions at the configured mode after a legacy handshake resolves auto',
            async () => {
                // One facade serves both eras at once, and a stateful `initialize` resolves `'auto'`
                // in place. Configuration-level instructions must not follow that resolution: reading
                // the mutable resolved mode would let one legacy client decide what every later
                // stateless request is told.
                resolveAvailableWidgetsMock.mockResolvedValue(new Map());

                await withStatelessServer(
                    async ({ server, call }) => {
                        await loadSource(server, [], { tools: [HELPER_TOOLS.STORE_SEARCH] });
                        const before = await call('server/discover');

                        await getRequestHandler(server, 'initialize')(UI_LEGACY_INITIALIZE, {});
                        // The premise: the handshake really did move the facade's resolved mode.
                        expect(server.serverMode).toBe('apps');

                        const after = await call('server/discover');

                        expect(after.result?.instructions).toBe(before.result?.instructions);
                        // And what they held to is the configured `'auto'` generic text, not the apps
                        // guidance that legacy client resolved to.
                        expect(before.result?.instructions).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
                    },
                    { serverMode: 'auto' },
                );
            },
        );
    });

    describe('retained tool sources', () => {
        it('recomposes every distinct retained source, the last load winning a name collision', async () => {
            // A facade retains one source per distinct input, so a request composes the whole set.
            // Two sources sharing a tool name pin the merge order: last load wins, matching how the
            // stateful path upserts them.
            await withStatelessServer(async ({ server, call }) => {
                await loadSource(
                    server,
                    [
                        makeSourceTool('shared-tool', 'from the first source'),
                        makeSourceTool('first-only-tool', 'only in the first source'),
                    ],
                    { actors: ['test/first-source'] },
                );
                await loadSource(
                    server,
                    [
                        makeSourceTool('shared-tool', 'from the second source'),
                        makeSourceTool('second-only-tool', 'only in the second source'),
                    ],
                    { actors: ['test/second-source'] },
                );

                const response = await call('tools/list');

                // Both sources are composed, not just the latest one.
                expect(toolNames(response.result)).toEqual(
                    expect.arrayContaining(['first-only-tool', 'second-only-tool', 'shared-tool']),
                );
                expect(listedTool(response.result, 'shared-tool')?.description).toBe('from the second source');
            });
        });
    });

    describe('concurrent requests', () => {
        it('resolves each concurrent request from its own declared identity only', async () => {
            await withStatelessServer(
                async ({ server, call }) => {
                    await loadSource(server, [], {
                        tools: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.PROBLEM_REPORT],
                    });

                    const [uiClient, blockedClient] = await Promise.all([
                        call('tools/list', {}, { client: { name: 'ui-client', supportsUi: true } }),
                        call('tools/list', {}, { client: { name: 'claude-ai', supportsUi: false } }),
                    ]);

                    // Mode: only the UI-capable request gets the widget variant.
                    if (SERVER_MODE_AUTO_DETECTION_ENABLED) {
                        expect(toolNames(uiClient.result)).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
                    }
                    expect(toolNames(blockedClient.result)).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
                    // Gating: only the non-blocklisted request gets report-problem.
                    expect(toolNames(uiClient.result)).toContain(HELPER_TOOLS.PROBLEM_REPORT);
                    expect(toolNames(blockedClient.result)).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
                },
                { serverMode: 'auto', telemetry: { enabled: true } },
            );
        });
    });
});
