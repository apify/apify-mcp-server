import type { REQUEST_ORIGIN } from '../apify_client.js';
import { ApifyClient } from '../apify_client.js';
import { maskLoggedValues } from '../resources/api_resources.js';
import type { ApifyToken, PlatformUrls, ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';

export type PrepareToolCallContextResult = {
    /** A copy of the tool args, safe for AJV validation (which mutates it) and Actor input. */
    toolArgs: Record<string, unknown>;
    /** Tool args with sensitive fields redacted (e.g. `[REDACTED]`) — safe for logging. */
    toolArgsRedacted: unknown;
    apifyClient: ApifyClient;
};

/** Runs before validation: AJV's in-place `removeAdditional` must not change the copy that is logged. */
export function prepareToolCallContext(input: {
    tool: ToolEntry;
    args: Record<string, unknown>;
    apifyToken: ApifyToken;
    /** Request origin to attribute started runs to (from getRequestOriginForClient). Defaults to MCP. */
    requestOrigin?: REQUEST_ORIGIN;
    /** The server's resolved origins, for the client. */
    platformUrls?: PlatformUrls;
}): PrepareToolCallContextResult {
    const { tool, args, apifyToken, requestOrigin, platformUrls } = input;
    // A direct Actor tool's arguments are the Actor input, and a proxied MCP tool's are the remote tool's: either can
    // hold credentials, so only their key names are logged.
    const toolArgsRedacted =
        tool.type === TOOL_TYPE.ACTOR || tool.type === TOOL_TYPE.ACTOR_MCP
            ? maskLoggedValues(args, Object.keys(args))
            : (tool.redactArgs?.(args) ?? args);

    return {
        toolArgs: { ...args },
        toolArgsRedacted,
        apifyClient: new ApifyClient({ token: apifyToken, requestOrigin, platformUrls }),
    };
}
