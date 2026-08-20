import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from './const.js';

/** Outcome of {@link callRemoteMcpTool} — closed union every caller must handle. `result` keeps
 * `Client.callTool`'s real union return type (content or legacy `toolResult` shape) since callers
 * only read individual fields off it, never the whole object. */
export type RemoteMcpCallOutcome =
    | { outcome: 'connect-failed' }
    | { outcome: 'aborted' }
    | { outcome: 'error'; error: unknown }
    | { outcome: 'success'; result: CallToolResult | CompatibilityCallToolResult };

/** Connect-call-close round trip for one remote tool, shared by `tool_dispatch.ts`'s `ACTOR_MCP`
 * case and `call_actor.ts`'s MCP passthrough. `onConnected` fires after connect but before
 * `callTool`, so a caller can register notification handlers first. */
export async function callRemoteMcpTool(params: {
    serverUrl: string;
    toolName: string;
    args: Record<string, unknown>;
    apifyToken: string;
    mcpSessionId: string | undefined;
    signal: AbortSignal;
    meta?: Record<string, unknown>;
    onConnected?: (client: Client) => void;
}): Promise<RemoteMcpCallOutcome> {
    const { serverUrl, toolName, args, apifyToken, mcpSessionId, signal, meta, onConnected } = params;
    let client: Client | null = null;
    try {
        client = await connectMCPClient(serverUrl, apifyToken, mcpSessionId);
        if (!client) return { outcome: 'connect-failed' };

        onConnected?.(client);

        const result = await client.callTool(
            { name: toolName, arguments: args, ...(meta ? { _meta: meta } : {}) },
            CallToolResultSchema,
            { timeout: EXTERNAL_TOOL_CALL_TIMEOUT_MSEC, signal },
        );
        return { outcome: 'success', result };
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
