import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import type { ServerModeOption, ToolEntry } from '../../src/types.js';
import { ServerMode } from '../../src/types.js';

type InitHandler = (req: InitializeRequest, ctx: unknown) => Promise<unknown>;

function makeInitializeRequest(supportsUi: boolean): InitializeRequest {
    const extensions = supportsUi
        ? { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } }
        : {};
    return {
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'test-client', version: '1.0.0' },
            capabilities: { extensions } as InitializeRequest['params']['capabilities'],
        },
    } as InitializeRequest;
}

function makeServer(serverMode: ServerModeOption): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        serverMode,
        telemetry: { enabled: false },
    });
}

/**
 * Drive the SDK-registered `initialize` request handler directly (bypassing the
 * transport layer). Mirrors what the SDK does when a real client sends `initialize`.
 */
async function dispatchInitialize(server: ActorsMcpServer, request: InitializeRequest): Promise<void> {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (server.server as unknown as {
        _requestHandlers: Map<string, InitHandler>;
    })._requestHandlers.get('initialize');
    if (!handler) throw new Error('initialize handler not registered');
    await handler(request, {});
}

describe('ActorsMcpServer initialize handler', () => {
    const servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            await server?.close();
        }
    });

    const track = (server: ActorsMcpServer): ActorsMcpServer => {
        servers.push(server);
        return server;
    };

    describe('mode resolution', () => {
        const cases: { option: ServerModeOption; supportsUi: boolean; expectedMode: ServerMode }[] = [
            { option: ServerMode.APPS, supportsUi: true, expectedMode: ServerMode.APPS },
            { option: ServerMode.APPS, supportsUi: false, expectedMode: ServerMode.APPS },
            { option: ServerMode.DEFAULT, supportsUi: true, expectedMode: ServerMode.DEFAULT },
            { option: ServerMode.DEFAULT, supportsUi: false, expectedMode: ServerMode.DEFAULT },
            { option: 'auto', supportsUi: true, expectedMode: ServerMode.APPS },
            { option: 'auto', supportsUi: false, expectedMode: ServerMode.DEFAULT },
        ];

        for (const { option, supportsUi, expectedMode } of cases) {
            it(`option=${option} supportsUi=${supportsUi} finalizes mode=${expectedMode}`, async () => {
                const server = track(makeServer(option));
                await dispatchInitialize(server, makeInitializeRequest(supportsUi));

                expect(server.serverMode).toBe(expectedMode);
                expect(server.clientSupportsUi).toBe(supportsUi);
            });
        }
    });

    it('runs the deferred tools loader after finalizing the mode', async () => {
        const server = track(makeServer('auto'));
        const loader = vi.fn<() => Promise<ToolEntry[]>>(async () => {
            // Loader reads the resolved mode — verify it sees APPS, not preliminary DEFAULT.
            expect(server.serverMode).toBe(ServerMode.APPS);
            return [];
        });
        server.setDeferredToolsLoader(loader);

        await dispatchInitialize(server, makeInitializeRequest(true));

        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('defaults to preliminary DEFAULT mode before initialize runs', () => {
        const server = track(makeServer('auto'));
        expect(server.serverMode).toBe(ServerMode.DEFAULT);
        expect(server.clientSupportsUi).toBe(false);
    });

    it('preliminary mode is APPS when option=apps, even before initialize', () => {
        const server = track(makeServer(ServerMode.APPS));
        expect(server.serverMode).toBe(ServerMode.APPS);
    });

    it('explicit option bypasses auto-detect — apps-capable client does not override default', async () => {
        const server = track(makeServer(ServerMode.DEFAULT));
        await dispatchInitialize(server, makeInitializeRequest(true));

        expect(server.serverMode).toBe(ServerMode.DEFAULT);
        expect(server.clientSupportsUi).toBe(true);
    });

    it('populates options.initializeRequestData so telemetry paths can read client info', async () => {
        const server = track(makeServer('auto'));
        const request = makeInitializeRequest(true);

        await dispatchInitialize(server, request);

        expect((server.options as { initializeRequestData?: InitializeRequest }).initializeRequestData).toEqual(request);
    });
});
