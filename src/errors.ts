export class TimeoutError extends Error {
    override readonly name = 'TimeoutError';
}

/**
 * A problem the caller can fix or has to be told about, thrown from helpers several calls deep; the tool
 * turns it into a soft-fail response with the message as its text, so the message must be safe to show.
 */
export class UserInputError extends Error {
    override readonly name = 'UserInputError';
}

/**
 * Thrown by `ApifyClient` (`apify_client.ts`) instead of sending a request with an invalid identifier, record key or
 * request path. The 400 status makes callers handle it as they handle the API's own rejection of bad input.
 */
export class InvalidRequestPathError extends UserInputError {
    readonly statusCode = 400;
}

/**
 * What telemetry and logs record for an `InvalidRequestPathError` in place of its message. The message is for the
 * caller and quotes the value they sent, which can be a pasted secret.
 */
export const INVALID_REQUEST_PATH_DETAIL = 'Invalid identifier, record key or request path';

/**
 * Thrown by `compileUntrustedSchema` when an untrusted Actor / proxied-MCP input schema exceeds the byte
 * cap that bounds AJV's synchronous codegen. It's a property of the schema, not a server fault, so
 * `logHttpError` logs it as a soft fail and the caller drops just that one tool.
 */
export class SchemaTooLargeError extends Error {
    override readonly name = 'SchemaTooLargeError';

    constructor(public readonly limitBytes: number) {
        super(`Input schema exceeds ${limitBytes}-byte safety limit`);
    }
}

export const ACTOR_LOAD_ERROR_KIND = {
    NOT_FOUND: 'not-found',
    LOAD_FAILED: 'load-failed',
    SERVER_ACTOR_WITHOUT_MCP_NOT_SUPPORTED: 'server-actor-without-mcp-not-supported',
} as const;
export type ActorLoadErrorKind = (typeof ACTOR_LOAD_ERROR_KIND)[keyof typeof ACTOR_LOAD_ERROR_KIND];

/**
 * Surfaced (not thrown) by `getActorsAsTools` in the `errors[]` field when an
 * Actor cannot be loaded for a *sanitized*, user-safe reason. The single-Actor
 * caller (`call-actor`) reads `errors[0]` and forwards the message to the agent;
 * bulk callers ignore the array.
 *
 * `message` is always safe to forward to the LLM agent / client verbatim.
 * Raw backend errors (network, 5xx, auth) are caught at the call site and
 * surfaced as `ActorLoadError` of kind `LOAD_FAILED` with a generic masked
 * message — never with the original error's text.
 *
 * Use the static factories so canonical messages stay in one place.
 */
export class ActorLoadError extends Error {
    override readonly name = 'ActorLoadError';

    constructor(
        public readonly kind: ActorLoadErrorKind,
        public readonly actorName: string,
        message: string,
    ) {
        super(message);
    }

    static notFound(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.NOT_FOUND,
            actorName,
            `Actor "${actorName}" was not found. Please verify the Actor ID or name.`,
        );
    }

    static loadFailed(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.LOAD_FAILED,
            actorName,
            `Failed to load Actor "${actorName}". Please try again later.`,
        );
    }

    static serverActorWithoutMcpNotSupported(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.SERVER_ACTOR_WITHOUT_MCP_NOT_SUPPORTED,
            actorName,
            `Actor "${actorName}" has no MCP tools or input interface.`,
        );
    }
}
