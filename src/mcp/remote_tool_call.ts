import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { McpConnectionOptions } from './client.js';
import { connectMCPClient } from './client.js';

/** Closed outcome union for {@link withRemoteMcpClient}. */
export type RemoteMcpCallOutcome<T> =
    | { outcome: 'connect-failed' }
    | { outcome: 'aborted' }
    | { outcome: 'error'; error: unknown }
    | { outcome: 'success'; value: T };

/** Connect, run the callback with the live client, always close. */
export async function withRemoteMcpClient<T>(
    serverUrl: string,
    options: McpConnectionOptions,
    mcpSessionId: string | undefined,
    signal: AbortSignal,
    run: (client: Client) => Promise<T>,
): Promise<RemoteMcpCallOutcome<T>> {
    let client: Client | null = null;
    try {
        client = await connectMCPClient(serverUrl, options, mcpSessionId);
        if (!client) return { outcome: 'connect-failed' };
        return { outcome: 'success', value: await run(client) };
    } catch (error) {
        // Yield a macrotask so the SDK's fire-and-forget notifications/cancelled, sent on an abort or a timeout,
        // flushes before close() aborts it.
        await new Promise((resolve) => setImmediate(resolve));
        if (signal.aborted) return { outcome: 'aborted' };
        return { outcome: 'error', error };
    } finally {
        if (client) await client.close();
    }
}
