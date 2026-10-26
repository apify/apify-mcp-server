import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { searchActors } from '../../src/tools/actors/search_actors.js';
import { SERVER_MODE, type ToolEntry } from '../../src/types.js';
import type * as ToolsLoaderModule from '../../src/utils/tools_loader.js';
import { getRequestHandler } from './helpers/mcp_server.js';
import { mockApifyClient } from './helpers/tool_context.js';

vi.mock('../../src/utils/tools_loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsLoaderModule>();
    return { ...actual, getActors: vi.fn().mockResolvedValue([]) };
});

const properties = (tool: ToolEntry | undefined) =>
    (tool?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
const hasUseCase = (tool: ToolEntry | undefined) => 'useCase' in properties(tool);

function makeServer(
    options: { telemetryEnabled?: boolean; clientParam?: string; serverMode?: SERVER_MODE } = {},
): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode: options.serverMode ?? SERVER_MODE.DEFAULT,
        telemetry: { enabled: options.telemetryEnabled ?? true },
        clientParam: options.clientParam,
    });
}

async function dispatchInitialize(server: ActorsMcpServer, clientName: string): Promise<void> {
    await getRequestHandler(server, 'initialize')(
        {
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                clientInfo: { name: clientName, version: '1.0.0' },
                capabilities: {},
            },
        },
        {},
    );
}

const loadSearch = (server: ActorsMcpServer) => server.loadToolsByName([HELPER_TOOLS.STORE_SEARCH], mockApifyClient());

describe('search-actors useCase gating', () => {
    const servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) await servers.pop()?.close();
    });

    const track = (server: ActorsMcpServer): ActorsMcpServer => {
        servers.push(server);
        return server;
    };

    it('serves the use case to a named client, composed before and after initialize', async () => {
        const before = track(makeServer());
        await loadSearch(before);
        await dispatchInitialize(before, 'cursor');
        expect(hasUseCase(before.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(true);

        const after = track(makeServer());
        await dispatchInitialize(after, 'cursor');
        await loadSearch(after);
        expect(hasUseCase(after.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(true);
    });

    it('serves the use case on the widget search tool too', async () => {
        const server = track(makeServer({ serverMode: SERVER_MODE.APPS }));
        await dispatchInitialize(server, 'cursor');
        await server.loadToolsByName([HELPER_TOOLS.STORE_SEARCH_WIDGET], mockApifyClient());
        expect(hasUseCase(server.tools.get(HELPER_TOOLS.STORE_SEARCH_WIDGET))).toBe(true);
    });

    it.each([
        { name: 'an Anthropic client', client: 'claude-ai', options: {} },
        { name: 'a ?client=claude connection', client: 'cursor', options: { clientParam: 'claude' } },
        { name: 'a client with telemetry off', client: 'cursor', options: { telemetryEnabled: false } },
    ])('hides the use case from $name', async ({ client, options }) => {
        const server = track(makeServer(options));
        await loadSearch(server);
        await dispatchInitialize(server, client);
        expect(server.tools.has(HELPER_TOOLS.STORE_SEARCH)).toBe(true);
        expect(hasUseCase(server.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(false);
    });

    it('hides it before the client is known', async () => {
        const server = track(makeServer());
        await loadSearch(server);
        expect(hasUseCase(server.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(false);
    });

    it('serves each stateless request the schema for its own client, concurrently', async () => {
        const server = track(makeServer());
        await loadSearch(server);
        const ctx = (name: string) => ({
            protocolVersion: '2026-07-28',
            clientInfo: { name, version: '1' },
            capabilities: {},
        });
        const [cursor, claude, unnamed] = await Promise.all([
            server.createRequestSnapshot(ctx('cursor')),
            server.createRequestSnapshot(ctx('claude-code')),
            server.createRequestSnapshot(undefined),
        ]);
        expect(hasUseCase(cursor.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(true);
        expect(hasUseCase(claude.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(false);
        expect(hasUseCase(unnamed.tools.get(HELPER_TOOLS.STORE_SEARCH))).toBe(false);
        // The shared tool is never written to.
        expect(hasUseCase(searchActors)).toBe(false);
    });

    it('tells the model never to send personal information or secrets, in the field and in the tool description', async () => {
        const server = track(makeServer());
        await dispatchInitialize(server, 'cursor');
        await loadSearch(server);
        const tool = server.tools.get(HELPER_TOOLS.STORE_SEARCH);
        const description = properties(tool).useCase.description ?? '';
        expect(description).toMatch(/Never include personal information/);
        expect(description).toMatch(/secrets, API tokens or credentials/);
        expect(description).toMatch(/Respect the user's privacy/);
        expect(tool?.description).toMatch(/Never send personal information or secrets/);
        expect(tool?.description).toMatch(/respect the user's privacy/);
        expect(tool?.buildDescription?.({ hasTool: () => true })).toMatch(/Never send personal information/);
    });
});
