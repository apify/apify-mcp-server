import type { REQUEST_ORIGIN } from '../apify_client.js';
import { ApifyClient } from '../apify_client.js';
import { maskLoggedValues } from '../resources/api_resources.js';
import type { ApifyToken, ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';

/**
 * Result of preparing tool-call context: argument copies for validation and logging, and the client.
 */
export type PrepareToolCallContextResult = {
    /** A copy of the tool args, safe for AJV validation (which mutates it) and Actor input. */
    toolArgs: Record<string, unknown>;
    /** Tool args with sensitive fields redacted (e.g. `[REDACTED]`) — safe for logging. */
    toolArgsRedacted: unknown;
    /** ApifyClient configured with the session token. */
    apifyClient: ApifyClient;
};

/**
 * Prepares tool-call context before validation and execution:
 * 1. Copies the args, so AJV's in-place `removeAdditional` does not change the logged copy
 * 2. Redacts sensitive fields for logging: the tool's own `redactArgs` (every value for an Actor or Actor MCP tool)
 * 3. Creates an ApifyClient with the session token
 */
export function prepareToolCallContext(input: {
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: ApifyToken;
    /** Request origin to attribute started runs to (from getRequestOriginForClient). Defaults to MCP. */
    requestOrigin?: REQUEST_ORIGIN;
}): PrepareToolCallContextResult {
    const { tool, args, apifyToken, requestOrigin } = input;
    // A direct Actor tool's arguments are the Actor input, and a proxied MCP tool's are the remote tool's: either can
    // hold credentials, so only their key names are logged.
    const toolArgsRedacted =
        tool.type === TOOL_TYPE.ACTOR || tool.type === TOOL_TYPE.ACTOR_MCP
            ? maskLoggedValues(args, Object.keys(args))
            : (tool.redactArgs?.(args) ?? args);

    return {
        toolArgs: { ...args },
        toolArgsRedacted,
        apifyClient: new ApifyClient({ token: apifyToken, requestOrigin }),
    };
}
