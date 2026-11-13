import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import { getServerActorsAsTools } from '../../src/tools/actors/actor_tools_factory.js';
import type { ActorDefinitionPruned, Input } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';
import { mockActor } from './helpers/actor_build_client.js';
import { getRequestHandler, makePaymentProvider } from './helpers/mcp_server.js';

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
});

describe('telling the client about tools left out of a load', () => {
    const NOTICE =
        'Tool "search" of Actor "apify/example-mcp-server" was not loaded because its input schema is too large.';
    const listTools = async (server: ActorsMcpServer, sendNotification: (notification: unknown) => Promise<void>) =>
        getRequestHandler(server, 'tools/list')({ method: 'tools/list', params: {} }, { sendNotification });

    async function loadWithNotice(): Promise<ActorsMcpServer> {
        vi.mocked(getActors).mockImplementationOnce(async (_input, _apifyClient, options) => {
            options?.onToolNotLoaded?.(NOTICE);
            return [];
        });
        const server = makeServer();
        await load(server, { actors: ['apify/example-mcp-server'] });
        return server;
    }

    it('sends each notice once, as a warning log message with the tool list', async () => {
        const server = await loadWithNotice();
        const sendNotification = vi.fn().mockResolvedValue(undefined);

        await listTools(server, sendNotification);
        await listTools(server, sendNotification);

        expect(sendNotification).toHaveBeenCalledExactlyOnceWith({
            method: 'notifications/message',
            params: { level: 'warning', data: NOTICE },
        });
    });

    it('sends the first notices and one sentence counting the others', async () => {
        const notices = Array.from({ length: 8 }, (_, index) => NOTICE.replace('search', `search-${index}`));
        vi.mocked(getActors).mockImplementationOnce(async (_input, _apifyClient, options) => {
            for (const notice of notices) options?.onToolNotLoaded?.(notice);
            return [];
        });
        const server = makeServer();
        await load(server, { actors: ['apify/example-mcp-server'] });
        const sendNotification = vi.fn().mockResolvedValue(undefined);

        await listTools(server, sendNotification);

        const sent = sendNotification.mock.calls.map(([notification]) => notification.params.data);
        expect(sent).toEqual([...notices.slice(0, 5), '3 more tools were not loaded because of the input schema.']);
    });

    it('keeps a fixed number of notices and only counts the ones over it', async () => {
        vi.mocked(getActors).mockImplementationOnce(async (_input, _apifyClient, options) => {
            // Reported twice: a kept notice is not repeated, and one over the number is counted each time.
            for (let index = 0; index < 500; index++) options?.onToolNotLoaded?.(`${NOTICE} ${index % 250}`);
            return [];
        });
        const server = makeServer();
        await load(server, { actors: ['apify/example-mcp-server'] });

        const notices = server.takeToolLoadNotices();

        expect(notices).toHaveLength(6);
        expect(notices.at(-1)).toBe('395 more tools were not loaded because of the input schema.');
    });

    it('sends nothing when the client asked for errors only', async () => {
        const server = await loadWithNotice();
        const sendNotification = vi.fn().mockResolvedValue(undefined);
        await getRequestHandler(server, 'logging/setLevel')(
            { method: 'logging/setLevel', params: { level: 'error' } },
            {},
        );

        await listTools(server, sendNotification);

        expect(sendNotification).not.toHaveBeenCalled();
    });

    it('lists the tools when the notice cannot be sent', async () => {
        const server = await loadWithNotice();
        const sendNotification = vi.fn().mockRejectedValue(new Error('Not connected'));

        await expect(listTools(server, sendNotification)).resolves.toEqual({ tools: expect.any(Array) });
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
