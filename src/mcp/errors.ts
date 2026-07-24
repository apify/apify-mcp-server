/**
 * Protocol-neutral domain errors for the prompt and resource services. They carry the message and
 * optional `data` payload but no protocol error code — the `server.ts` boundary maps each 1:1 to a
 * v1 `McpError` right before serialization, and a future v2 adapter maps them to its own error type.
 * This module imports nothing from any MCP SDK.
 */

/** A request/resource-level fault (bad URI, missing token, non-Apify origin, 3xx/4xx except 429). */
export class InvalidParamsError extends Error {
    override readonly name = 'InvalidParamsError';

    constructor(
        message: string,
        public readonly data?: unknown,
    ) {
        super(message);
    }
}

/** A transient/upstream fault (429, 5xx, network or mid-stream drop). */
export class InternalError extends Error {
    override readonly name = 'InternalError';

    constructor(
        message: string,
        public readonly data?: unknown,
    ) {
        super(message);
    }
}
