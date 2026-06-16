import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import log from '@apify/log';

import { ActorsMcpServer } from '../../src/mcp/server.js';

/**
 * Covers the `server.onerror` wiring in `setupErrorHandling()`: client faults softFail with a
 * Mezmo-sanitized message, anything else logs at error level. The fault patterns themselves
 * are covered by the `isMcpClientFaultMessage()` tests in utils.logging.test.ts.
 */
describe('ActorsMcpServer onerror', () => {
    afterEach(() => vi.restoreAllMocks());

    it('soft-fails client faults with a sanitized message and error-logs the rest', async () => {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token: 'fake-token',
        });
        try {
            const softFail = vi.spyOn(log, 'softFail').mockImplementation(() => log);
            const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);

            server.server.onerror?.(new Error('Parse error: Invalid JSON-RPC message'));
            expect(errorLog).not.toHaveBeenCalled();
            expect(softFail).toHaveBeenCalledWith('MCP client fault, request could not be handled', {
                errMessage: 'Parse failure: Invalid JSON-RPC message',
            });

            server.server.onerror?.(new Error('Unexpected internal failure'));
            expect(errorLog).toHaveBeenCalledTimes(1);
        } finally {
            await server.close();
        }
    });
});
