import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ApifyClient } from 'apify-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, SERVER_MODE_AUTO_DETECTION_ENABLED } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/mcp/server.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import { callActorApps } from '../../src/tools/actors/call_actor.js';
import { searchActors } from '../../src/tools/actors/search_actors.js';
import { searchActorsWidget } from '../../src/tools/widgets/search_actors_widget.js';
import type { ServerModeOption } from '../../src/types.js';
import { SERVER_MODE } from '../../src/types.js';
import { getRequestHandler } from './helpers/mcp_server.js';

function makeInitializeRequest(supportsUi: boolean): InitializeRequest {
    const extensions = supportsUi ? { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } : {};
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
    await getRequestHandler(server, 'initialize')(request as unknown as Record<string, unknown>, {});
}

describe('ActorsMcpServer initialize handler', () => {
    const servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            server?.tools.clear();
            await server?.close();
        }
    });

    const track = (server: ActorsMcpServer): ActorsMcpServer => {
        servers.push(server);
        return server;
    };

    describe('mode resolution', () => {
        const cases: { option: ServerModeOption; supportsUi: boolean; expectedMode: SERVER_MODE }[] = [
            { option: SERVER_MODE.APPS, supportsUi: true, expectedMode: SERVER_MODE.APPS },
            { option: SERVER_MODE.APPS, supportsUi: false, expectedMode: SERVER_MODE.APPS },
            { option: SERVER_MODE.DEFAULT, supportsUi: true, expectedMode: SERVER_MODE.DEFAULT },
            { option: SERVER_MODE.DEFAULT, supportsUi: false, expectedMode: SERVER_MODE.DEFAULT },
            {
                option: 'auto',
                supportsUi: true,
                expectedMode: SERVER_MODE_AUTO_DETECTION_ENABLED ? SERVER_MODE.APPS : SERVER_MODE.DEFAULT,
            },
            { option: 'auto', supportsUi: false, expectedMode: SERVER_MODE.DEFAULT },
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

    it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'flushes pending sources from loadToolsFromInput with the resolved mode after initialize',
        async () => {
            const server = track(makeServer('auto'));
            const apifyClient = new ApifyClient({ token: 'test-token' });

            await server.loadToolsFromInput({ tools: [HELPER_TOOLS.STORE_SEARCH] }, apifyClient);

            // Sources are pending — no tools visible yet
            expect(server.tools.has(HELPER_TOOLS.STORE_SEARCH)).toBe(false);

            await dispatchInitialize(server, makeInitializeRequest(true));

            // After initialize (apps mode): composed with APPS-mode variants
            // search-actors is mode-independent (data-only); search-actors-widget is the apps-only UI variant auto-added in apps mode.
            expect(server.tools.get(HELPER_TOOLS.STORE_SEARCH)).toBe(searchActors);
            expect(server.tools.get(HELPER_TOOLS.STORE_SEARCH_WIDGET)).toBe(searchActorsWidget);
        },
    );

    it('defaults to preliminary DEFAULT mode before initialize runs', () => {
        const server = track(makeServer('auto'));
        expect(server.serverMode).toBe(SERVER_MODE.DEFAULT);
        expect(server.clientSupportsUi).toBe(false);
    });

    it('preliminary mode is APPS when option=apps, even before initialize', () => {
        const server = track(makeServer(SERVER_MODE.APPS));
        expect(server.serverMode).toBe(SERVER_MODE.APPS);
    });

    it('explicit option bypasses auto-detect — apps-capable client does not override default', async () => {
        const server = track(makeServer(SERVER_MODE.DEFAULT));
        await dispatchInitialize(server, makeInitializeRequest(true));

        expect(server.serverMode).toBe(SERVER_MODE.DEFAULT);
        expect(server.clientSupportsUi).toBe(true);
    });

    it('populates options.initializeRequestData so telemetry paths can read client info', async () => {
        const server = track(makeServer('auto'));
        const request = makeInitializeRequest(true);

        await dispatchInitialize(server, request);

        expect((server.options as { initializeRequestData?: InitializeRequest }).initializeRequestData).toEqual(
            request,
        );
    });

    it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'defers helper tools before initialize and recomposes them as apps variants after initialize resolves auto mode to apps',
        async () => {
            const server = track(makeServer('auto'));
            const apifyClient = new ApifyClient({ token: 'test-token' });

            await server.loadToolsByName([HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_CALL], apifyClient);

            expect(server.tools.has(HELPER_TOOLS.STORE_SEARCH)).toBe(false);
            expect(server.tools.has(HELPER_TOOLS.ACTOR_CALL)).toBe(false);

            await dispatchInitialize(server, makeInitializeRequest(true));

            expect(server.tools.get(HELPER_TOOLS.STORE_SEARCH)).toBe(searchActors);
            expect(server.tools.get(HELPER_TOOLS.ACTOR_CALL)).toBe(callActorApps);
            expect(server.tools.get(HELPER_TOOLS.STORE_SEARCH_WIDGET)).toBe(searchActorsWidget);
        },
    );

    it.runIf(SERVER_MODE_AUTO_DETECTION_ENABLED)(
        'defers apps-only tool names before initialize and registers them after initialize resolves auto mode to apps',
        async () => {
            const server = track(makeServer('auto'));
            const apifyClient = new ApifyClient({ token: 'test-token' });
            const loadActorsAsTools = vi
                .spyOn(server, 'loadActorsAsTools')
                .mockResolvedValue({ tools: [], errors: [] });

            await server.loadToolsByName([HELPER_TOOLS.STORE_SEARCH_WIDGET], apifyClient);

            expect(loadActorsAsTools).not.toHaveBeenCalled();
            expect(server.tools.has(HELPER_TOOLS.STORE_SEARCH_WIDGET)).toBe(false);

            await dispatchInitialize(server, makeInitializeRequest(true));

            expect(server.tools.get(HELPER_TOOLS.STORE_SEARCH_WIDGET)).toBe(searchActorsWidget);
        },
    );
});
