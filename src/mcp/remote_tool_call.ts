import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { connectMCPClient } from './client.js';

/** Closed outcome union for {@link withRemoteMcpClient}. */
export type RemoteMcpCallOutcome<T> =
    | { outcome: 'connect-failed' }
    | { outcome: 'aborted' }
    | { outcome: 'error'; error: unknown }
    | { outcome: 'success'; value: T };

/**
 * Connect, run the callback with the live client, always close. Not in `client.ts`:
 * `vi.spyOn(connectMCPClient)` only intercepts a cross-module import, not a same-module call.
 */
export async function withRemoteMcpClient<T>(
    serverUrl: string,
    apifyToken: string,
    mcpSessionId: string | undefined,
    signal: AbortSignal,
    run: (client: Client) => Promise<T>,
): Promise<RemoteMcpCallOutcome<T>> {
    let client: Client | null = null;
    try {
        client = await connectMCPClient(serverUrl, apifyToken, mcpSessionId);
        if (!client) return { outcome: 'connect-failed' };
        return { outcome: 'success', value: await run(client) };
    } catch (error) {
        if (signal.aborted) {
            // Yield a macrotask so the SDK's fire-and-forget notifications/cancelled flushes before close() aborts it.
            await new Promise((resolve) => setImmediate(resolve));
            return { outcome: 'aborted' };
        }
        return { outcome: 'error', error };
    } finally {
        if (client) await client.close();
    }
}
