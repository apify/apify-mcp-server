import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { connectMCPClient } from './client.js';
import { EXTERNAL_TOOL_CALL_TIMEOUT_MSEC } from './const.js';

/**
 * Outcome of {@link callRemoteMcpTool} — a closed union so every caller must handle all four.
 * `result`'s type mirrors `Client.callTool`'s own declared return type exactly (content-shaped
 * or the legacy 2024-10-07 `toolResult` compatibility shape) rather than narrowing it — callers
 * already only read individual fields off it (`isError`, `content`), same as before extraction.
 */
export type RemoteMcpCallOutcome =
    | { outcome: 'connect-failed' }
    | { outcome: 'aborted' }
    | { outcome: 'error'; error: unknown }
    | { outcome: 'success'; result: CallToolResult | CompatibilityCallToolResult };

/**
 * Connects to a remote MCP server, calls exactly one tool, and always closes the connection —
 * shared by the ACTOR_MCP dispatch path (`tool_dispatch.ts`) and call-actor's MCP passthrough
 * (`call_actor.ts`). Neither holds the connection open across calls; every invocation is its own
 * connect-call-close round trip (see apify/apify-mcp-server AGENTS.md on why that's safe multi-node).
 * `onConnected` runs after a successful connect but before `callTool`, so a caller can register
 * notification handlers (only `tool_dispatch.ts` does).
 */
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
