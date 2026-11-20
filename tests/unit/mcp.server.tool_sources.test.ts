import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { SkyfirePaymentProvider } from '../../src/payments/skyfire.js';
import { X402PaymentProvider } from '../../src/payments/x402.js';
import { getServerActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorDefinitionPruned, Input } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';
import { mockActor } from './helpers/actor_build_client.js';
import { makePaymentProvider } from './helpers/mcp_server.js';

// Stub getActors so a load runs without a network fetch to the Apify platform.
vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActors: vi.fn() };
});

vi.mocked(getActors).mockResolvedValue([]);

/** `toolSources` is private and has no reader yet; read it directly to assert it stays bounded. */
function toolSourceKeys(server: ActorsMcpServer): string[] {
    return [...(server as unknown as { toolSources: Map<string, unknown> }).toolSources.keys()];
}

/** The pending queue is private too; read it directly to assert reloads replace instead of append. */
function pendingToolKeys(server: ActorsMcpServer): string[] {
    const { pendingToolsUntilClientKnown } = server as unknown as {
        pendingToolsUntilClientKnown: Map<string, unknown>;
    };
    return [...pendingToolsUntilClientKnown.keys()];
}

const servers: ActorsMcpServer[] = [];

afterEach(async () => {
    while (servers.length > 0) {
        const server = servers.pop();
        await server?.close();
    }
});

function makeServer(options: Partial<ConstructorParameters<typeof ActorsMcpServer>[0]> = {}): ActorsMcpServer {
    const server = new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: SERVER_MODE.DEFAULT,
        telemetry: { enabled: false },
        ...options,
    });
    servers.push(server);
    return server;
}

/** Telemetry on and a known, non-blocklisted client: the conditions under which report-problem is otherwise served. */
const REPORT_PROBLEM_SERVABLE_OPTIONS = {
    telemetry: { enabled: true },
    initializeRequestData: {
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: {},
        },
    },
} satisfies Partial<ConstructorParameters<typeof ActorsMcpServer>[0]>;

const load = async (server: ActorsMcpServer, input: Input) =>
    server.loadToolsFromInput(input, new ApifyClient({ token: 'test-token' }));

describe('registerFetchedActorTools()', () => {
    it('retains one source per distinct input when the same input is loaded repeatedly', async () => {
        const server = makeServer();

        await load(server, { actors: ['apify/rag-web-browser'] });
        await load(server, { actors: ['apify/rag-web-browser'] });
        await load(server, { actors: ['apify/rag-web-browser'] });

        expect(toolSourceKeys(server)).toHaveLength(1);
    });

    it('treats inputs differing only in property order as the same source', async () => {
        const server = makeServer();

        await load(server, { actors: ['apify/rag-web-browser'], tools: ['docs'] });
        await load(server, { tools: ['docs'], actors: ['apify/rag-web-browser'] });

        expect(toolSourceKeys(server)).toHaveLength(1);
    });

    it('retains distinct inputs separately', async () => {
        const server = makeServer();

        await load(server, { actors: ['apify/rag-web-browser'] });
        await load(server, { actors: ['apify/website-content-crawler'] });

        expect(toolSourceKeys(server)).toHaveLength(2);
    });

    it('re-queues a reloaded input in place while the client is unknown', async () => {
        // A facade that never sees a legacy initialize (the stateless-only host shape) never drains
        // the pending queue, so a reload must replace its entry — like `toolSources` — not append.
        const server = makeServer();

        await load(server, { actors: ['apify/rag-web-browser'] });
        await load(server, { actors: ['apify/rag-web-browser'] });
        await load(server, { actors: ['apify/rag-web-browser'] });

        expect(pendingToolKeys(server)).toHaveLength(1);
    });
});

describe('composing tools in a payment-provider session', () => {
    it("drops a Server Actor's own tool that a loader without the provider fetched", async () => {
        // `processParamsGetTools` and other loaders fetch without the provider, so the list-time filter is not enough.
        const definition = {
            id: 'server-actor-id',
            actorFullName: 'apify/server-actor-test',
            webServerToolInfo: { methods: ['GET'], operationLines: [], operationCount: 1 },
        } as unknown as ActorDefinitionPruned;
        const actor = mockActor({ actorStandby: { isEnabled: true } });
        vi.mocked(getActors).mockResolvedValueOnce(
            getServerActorsAsTools([{ definition, actor, webServerMcpPath: null }]),
        );
        const server = makeServer({ paymentProvider: makePaymentProvider() });

        await load(server, { actors: ['apify/server-actor-test'] });

        expect(server.listToolNames()).not.toContain('apify--server-actor-test');
    });

    const DEFAULT_SET: Input = {};
    const EXPLICIT_SELECTION: Input = { tools: [HELPER_TOOLS.PROBLEM_REPORT] };

    it.each([
        { provider: 'x402', paymentProvider: new X402PaymentProvider(), selection: 'default set', input: DEFAULT_SET },
        {
            provider: 'x402',
            paymentProvider: new X402PaymentProvider(),
            selection: 'explicit selection',
            input: EXPLICIT_SELECTION,
        },
        {
            provider: 'skyfire',
            paymentProvider: new SkyfirePaymentProvider(),
            selection: 'default set',
            input: DEFAULT_SET,
        },
        {
            provider: 'skyfire',
            paymentProvider: new SkyfirePaymentProvider(),
            selection: 'explicit selection',
            input: EXPLICIT_SELECTION,
        },
    ])('does not serve report-problem in a $provider session ($selection)', async ({ paymentProvider, input }) => {
        const server = makeServer({ paymentProvider, ...REPORT_PROBLEM_SERVABLE_OPTIONS });

        await load(server, input);

        expect(server.listToolNames()).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
        const snapshot = await server.createRequestSnapshot(server.clientContext);
        expect([...snapshot.tools.keys()]).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it.each([
        { session: 'token', options: { token: 'test-token' } },
        { session: 'token-less non-payment', options: { allowUnauthMode: true } },
    ])('serves a selected report-problem in a $session session', async ({ options }) => {
        const server = makeServer({ ...options, ...REPORT_PROBLEM_SERVABLE_OPTIONS });

        await load(server, { tools: [HELPER_TOOLS.PROBLEM_REPORT] });

        expect(server.listToolNames()).toContain(HELPER_TOOLS.PROBLEM_REPORT);
        const snapshot = await server.createRequestSnapshot(server.clientContext);
        expect([...snapshot.tools.keys()]).toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});

describe('close()', () => {
    it('releases both retained source maps, so a later snapshot composes no tools', async () => {
        // Each retained source holds its fetched `ToolEntry` list with a compiled AJV validator per
        // tool, and neither map is drained while serving — close is the only release point, and a
        // long-lived host churning facades per session depends on it.
        const server = makeServer();
        await load(server, { tools: ['docs'] });
        expect((await server.createRequestSnapshot(undefined)).tools.size).toBeGreaterThan(0);

        await server.close();

        expect(toolSourceKeys(server)).toEqual([]);
        expect(pendingToolKeys(server)).toEqual([]);
        expect((await server.createRequestSnapshot(undefined)).tools.size).toBe(0);
    });
});
