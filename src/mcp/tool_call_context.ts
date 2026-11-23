import type { REQUEST_ORIGIN } from '../apify_client.js';
import { ApifyClient } from '../apify_client.js';
import { maskLoggedValues, REDACTION_PLACEHOLDER } from '../resources/api_resources.js';
import type { ApifyToken, ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { isValidResourceId } from '../utils/apify_resource_id.js';

export type PrepareToolCallContextResult = {
    /** A copy of the tool args, safe for AJV validation (which mutates it) and Actor input. */
    toolArgs: Record<string, unknown>;
    /** Tool args with sensitive fields redacted (e.g. `[REDACTED]`) — safe for logging. */
    toolArgsRedacted: unknown;
    apifyClient: ApifyClient;
};

/**
 * `loggedArgs` with its `actor` replaced by `REDACTION_PLACEHOLDER` unless it is shaped like an Actor ID or name.
 * Any other value is whatever the caller sent, a pasted `Authorization` header included. The shape check cannot tell
 * a name from a bare secret made of the same characters; Apify tokens of that kind are masked in the finished log line.
 */
function redactLoggedActorName(loggedArgs: Record<string, unknown>): Record<string, unknown> {
    const { actor } = loggedArgs;
    if (typeof actor !== 'string' || isValidResourceId(actor.trim())) return loggedArgs;
    return { ...loggedArgs, actor: REDACTION_PLACEHOLDER };
}

/** Runs before validation: AJV's in-place `removeAdditional` must not change the copy that is logged. */
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
            : redactLoggedActorName(tool.redactArgs?.(args) ?? args);

    return {
        toolArgs: { ...args },
        toolArgsRedacted,
        apifyClient: new ApifyClient({ token: apifyToken, requestOrigin }),
    };
}
