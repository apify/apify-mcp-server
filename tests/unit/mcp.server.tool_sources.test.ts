import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import type { Input } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getActors } from '../../src/utils/tools_loader.js';

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

describe('registerFetchedActorTools()', () => {
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
});
