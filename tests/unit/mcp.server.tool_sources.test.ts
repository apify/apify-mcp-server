import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import type { Input } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActorsFromInput } from '../../src/utils/tools_loader.js';

// Stub getActorsFromInput so a load runs without a network fetch to the Apify platform.
vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActorsFromInput: vi.fn() };
});

vi.mocked(getActorsFromInput).mockResolvedValue([]);

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
        server?.tools.clear();
        await server?.close();
    }
});

function makeServer(): ActorsMcpServer {
    const server = new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: SERVER_MODE.DEFAULT,
        telemetry: { enabled: false },
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
