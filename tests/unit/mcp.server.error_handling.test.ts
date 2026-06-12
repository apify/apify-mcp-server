import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import type { ActorsMcpServer } from '../../src/mcp/server.js';

/**
 * Covers `setupErrorHandling()`'s classification in `server.onerror`. The SDK transport raises
 * client-fault protocol errors (malformed JSON-RPC, request before/after init) that must be
 * soft-failed, not logged at error level where they flood Mezmo alerts.
 */
async function withServer<T>(run: (server: ActorsMcpServer) => Promise<T>): Promise<T> {
    const { ActorsMcpServer: ActorsMcpServerClass } = await import('../../src/mcp/server.js');
    const server = new ActorsMcpServerClass({
        taskStore: new InMemoryTaskStore(),
        setupSigintHandler: false,
        telemetry: { enabled: false },
        token: 'fake-token',
    });
    try {
        return await run(server);
    } finally {
        await server.close();
    }
}

describe('ActorsMcpServer onerror', () => {
    afterEach(() => vi.restoreAllMocks());

    it('soft-fails invalid client requests instead of logging them as errors', async () => {
        await withServer(async (server) => {
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);

            for (const message of [
                'Parse error: Invalid JSON-RPC message',
                'Bad Request: Server not initialized',
                'Invalid Request: Only one initialization request is allowed',
            ]) {
                server.server.onerror?.(new Error(message));
            }

            expect(errorLog).not.toHaveBeenCalled();
            expect(softFail).toHaveBeenCalledTimes(3);
        });
    });

    it('still logs genuine server faults at error level', async () => {
        await withServer(async (server) => {
            const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);
            server.server.onerror?.(new Error('Unexpected internal failure'));
            expect(errorLog).toHaveBeenCalledTimes(1);
        });
    });
});
