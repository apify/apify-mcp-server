import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { ActorsMcpServer } from '../../src/mcp/server.js';

function makeServer(): ActorsMcpServer {
    return new ActorsMcpServer({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        telemetry: { enabled: false },
    });
}

describe('ActorsMcpServer onerror handler', () => {
    const servers: ActorsMcpServer[] = [];

    afterEach(async () => {
        while (servers.length > 0) {
            const server = servers.pop();
            await server?.close();
        }
        vi.restoreAllMocks();
    });

    const track = (server: ActorsMcpServer): ActorsMcpServer => {
        servers.push(server);
        return server;
    };

    it('downgrades "Controller is already closed" SSE-write errors to softFail', () => {
        const server = track(makeServer());
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => undefined);
        const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

        const err = new TypeError('Invalid state: Controller is already closed');
        (err as unknown as { code?: string }).code = 'ERR_INVALID_STATE';
        server.server.onerror?.(err);

        expect(softFail).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();
    });

    it.each([
        'Not connected',
        'Failed to send response: Error: Not connected',
        'No connection established for request ID: 42',
        'Conflict: Only one SSE stream is allowed per session',
    ])('downgrades known client-disconnect noise: %s', (message) => {
        const server = track(makeServer());
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => undefined);
        const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

        server.server.onerror?.(new Error(message));

        expect(softFail).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();
    });

    it('still logs unexpected errors at error level', () => {
        const server = track(makeServer());
        const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => undefined);
        const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

        server.server.onerror?.(new Error('Boom: something unexpected'));

        expect(error).toHaveBeenCalledOnce();
        expect(softFail).not.toHaveBeenCalled();
    });
});
