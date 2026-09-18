import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ActorsMcpServer } from '../../src/mcp/server.js';

/**
 * End-to-end coverage stops at the `_meta` override (`tools.cases.ts`): HTTP
 * rejects a tokenless connection before `_meta` is parsed, and stdio refuses
 * to start without a token.
 */
describe('ActorsMcpServer', () => {
    const servers: ActorsMcpServer[] = [];

    function makeServer(token?: string): ActorsMcpServer {
        const server = new ActorsMcpServer({
            taskStore: new InMemoryTaskStore(),
            setupSigintHandler: false,
            telemetry: { enabled: false },
            token,
        });
        servers.push(server);
        return server;
    }

    afterEach(async () => {
        await Promise.all(servers.splice(0).map(async (server) => server.close()));
    });

    describe('resolveApifyToken()', () => {
        it('prefers the token the request carried in _meta', () => {
            expect(makeServer('configured-token').resolveApifyToken({ apifyToken: 'client-supplied-token' })).toBe(
                'client-supplied-token',
            );
        });

        it('falls back to the configured token when the request carries none', () => {
            expect(makeServer('configured-token').resolveApifyToken({})).toBe('configured-token');
        });

        it('falls back to the configured token when the request has no _meta at all', () => {
            expect(makeServer('configured-token').resolveApifyToken()).toBe('configured-token');
        });

        it('resolves to undefined when neither source supplies one', () => {
            expect(makeServer().resolveApifyToken({})).toBeUndefined();
        });

        it('ignores an empty _meta token rather than treating it as a value', () => {
            expect(makeServer('configured-token').resolveApifyToken({ apifyToken: '' })).toBe('configured-token');
        });
    });
});
