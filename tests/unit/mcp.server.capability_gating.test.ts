import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import type { ServerModeOption, ToolEntry } from '../../src/types.js';
import { ServerMode } from '../../src/types.js';

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

describe('ActorsMcpServer prepareForInitialize', () => {
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
                await server.prepareForInitialize(makeInitializeRequest(supportsUi));

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

        await server.prepareForInitialize(makeInitializeRequest(true));

        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — second call does not re-run the loader', async () => {
        const server = track(makeServer('auto'));
        const loader = vi.fn<() => Promise<ToolEntry[]>>(async () => []);
        server.setDeferredToolsLoader(loader);

        await server.prepareForInitialize(makeInitializeRequest(true));
        await server.prepareForInitialize(makeInitializeRequest(false));

        expect(loader).toHaveBeenCalledTimes(1);
        // Mode stays at the first resolution — subsequent calls are no-ops.
        expect(server.serverMode).toBe(ServerMode.APPS);
        expect(server.clientSupportsUi).toBe(true);
    });

    it('defaults to preliminary DEFAULT mode before prepareForInitialize runs', () => {
        const server = track(makeServer('auto'));
        expect(server.serverMode).toBe(ServerMode.DEFAULT);
        expect(server.clientSupportsUi).toBe(false);
    });

    it('preliminary mode is APPS when option=apps, even before prepareForInitialize', () => {
        const server = track(makeServer(ServerMode.APPS));
        expect(server.serverMode).toBe(ServerMode.APPS);
    });

    it('explicit option bypasses auto-detect — apps-capable client does not override default', async () => {
        const server = track(makeServer(ServerMode.DEFAULT));
        await server.prepareForInitialize(makeInitializeRequest(true));

        expect(server.serverMode).toBe(ServerMode.DEFAULT);
        expect(server.clientSupportsUi).toBe(true);
    });
});
