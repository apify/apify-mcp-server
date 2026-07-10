import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { InitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';
import type { AvailableWidget } from '../../src/resources/widgets.js';
import { RESOURCE_MIME_TYPE } from '../../src/resources/widgets.js';
import { SERVER_MODE } from '../../src/types.js';

/**
 * Mock resolveAvailableWidgets at the module level to track invocations
 */
vi.mock('../../src/resources/widgets.js', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = (await vi.importActual('../../src/resources/widgets.js')) as any;
    return {
        ...actual,
        resolveAvailableWidgets: vi.fn(async () => {
            // Return a mock Map with widgets from the registry
            const resolvedWidgets = new Map<string, AvailableWidget>();
            for (const [uri, config] of Object.entries(actual.WIDGET_REGISTRY)) {
                const widget: AvailableWidget = {
                    ...(config as AvailableWidget),
                    jsPath: `/mock/path/${(config as AvailableWidget).jsFilename}`,
                    exists: true,
                };
                resolvedWidgets.set(uri, widget);
            }
            return resolvedWidgets;
        }),
    };
});

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

/**
 * Drive the SDK-registered `initialize` request handler directly (bypassing the
 * transport layer). Mirrors what the SDK does when a real client sends `initialize`.
 */
async function dispatchInitialize(server: ActorsMcpServer, request: InitializeRequest): Promise<void> {
    // eslint-disable-next-line no-underscore-dangle
    const handler = (
        server.server as unknown as {
            _requestHandlers: Map<string, (req: InitializeRequest, ctx: unknown) => Promise<unknown>>;
        }
    )._requestHandlers.get('initialize');
    if (!handler) throw new Error('initialize handler not registered');
    await handler(request, {});
}

describe('resolveWidgets memoization', () => {
    let servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            server?.tools.clear();
            await server?.close();
        }
    });

    it('scans the filesystem only once across multiple APPS-mode session initializations', async () => {
        const { resolveAvailableWidgets } = await import('../../src/resources/widgets.js');
        const mockResolveAvailableWidgets = vi.mocked(resolveAvailableWidgets);

        // Reset call count for this test
        mockResolveAvailableWidgets.mockClear();

        // Create two servers in APPS mode
        const server1 = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            serverMode: SERVER_MODE.APPS,
            telemetry: { enabled: false },
        });
        servers.push(server1);

        const server2 = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            serverMode: SERVER_MODE.APPS,
            telemetry: { enabled: false },
        });
        servers.push(server2);

        // Initialize both servers
        const request = makeInitializeRequest(true);
        await dispatchInitialize(server1, request);
        await dispatchInitialize(server2, request);

        // Verify the scan ran exactly once across both sessions
        expect(mockResolveAvailableWidgets).toHaveBeenCalledTimes(1);
    });
});
