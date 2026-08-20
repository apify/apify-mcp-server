import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { connectMCPClient } from './client.js';

/** Outcome of {@link withRemoteMcpClient} — closed union every caller must handle. */
export type RemoteMcpCallOutcome<T> =
    | { outcome: 'connect-failed' }
    | { outcome: 'aborted' }
    | { outcome: 'error'; error: unknown }
    | { outcome: 'success'; value: T };

/**
 * Connect-call-close round trip, shared by `tool_dispatch.ts`'s `ACTOR_MCP` case and
 * `call_actor.ts`'s MCP passthrough — the only two sites that call a remote tool (not just list
 * them). `run` receives the connected client and does the actual `callTool`; kept out of
 * `client.ts`: a `vi.spyOn` on `connectMCPClient` only intercepts a cross-module import, not a
 * same-module call from inside `client.ts` itself.
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
            // Yield a macrotask first: the SDK sends notifications/cancelled fire-and-forget on
            // the transport's AbortController, which the finally's close() would abort before it flushes.
            await new Promise((resolve) => setImmediate(resolve));
            return { outcome: 'aborted' };
        }
        return { outcome: 'error', error };
    } finally {
        if (client) await client.close();
    }
}
