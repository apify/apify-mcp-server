import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { McpClient } from '../../evals/workflows/mcp_client.js';

/** Minimal stand-in for a spawned child_process.ChildProcess, enough for cleanup()'s liveness check. */
function makeFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        signalCode: string | null;
        kill: (signal: string) => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal: string) => {
        // Simulate the OS actually terminating the process shortly after the signal.
        setImmediate(() => {
            child.exitCode = null;
            child.signalCode = signal;
            child.emit('exit', null, signal);
        });
        return true;
    });
    return child;
}

function makeClientWithFakeTransport(child: ReturnType<typeof makeFakeChild>, closeDelayMs: number): McpClient {
    const client = new McpClient(60);
    Object.assign(client, {
        client: { close: async () => new Promise((resolve) => setTimeout(resolve, closeDelayMs)) },
        transport: { close: async () => {}, _process: child },
    });
    return client;
}

describe('McpClient.cleanup()', () => {
    it('SIGKILLs a child still alive once the graceful-close race times out', async () => {
        const child = makeFakeChild();
        // client.close() never settles within cleanup()'s own timeout, forcing the fallback path.
        const client = makeClientWithFakeTransport(child, 10_000);

        await client.cleanup(50);

        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('does not kill a child that already exited before cleanup ran', async () => {
        const child = makeFakeChild();
        child.exitCode = 0;
        const client = makeClientWithFakeTransport(child, 0);

        await client.cleanup(50);

        expect(child.kill).not.toHaveBeenCalled();
    });

    it('resolves promptly once the killed child reports exit, without waiting out the full fallback budget', async () => {
        const child = makeFakeChild();
        const client = makeClientWithFakeTransport(child, 10_000);

        const start = Date.now();
        await client.cleanup(50);
        const elapsedMs = Date.now() - start;

        // Fallback budget is a 1s safety cap; the fake child "exits" on the next tick after
        // kill(), so cleanup() should return well before that cap is reached.
        expect(elapsedMs).toBeLessThan(900);
    });
});
