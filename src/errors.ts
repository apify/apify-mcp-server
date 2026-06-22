export class TimeoutError extends Error {
    override readonly name = 'TimeoutError';
}

/**
 * Thrown by `fixedAjvCompile` when an untrusted Actor / proxied-MCP input schema exceeds the byte
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
    STANDBY_PAYMENT_NOT_SUPPORTED: 'standby-payment-not-supported',
} as const;
export type ActorLoadErrorKind = (typeof ACTOR_LOAD_ERROR_KIND)[keyof typeof ACTOR_LOAD_ERROR_KIND];

/**
 * Surfaced (not thrown) by `getActorsAsTools` in the `errors[]` field when an
 * Actor cannot be loaded for a *sanitized*, user-safe reason. Single-Actor
 * callers (`add-actor`, `call-actor`) read `errors[0]` and forward the
 * message to the agent; bulk callers ignore the array.
 *
 * `message` is always safe to forward to the LLM agent / client verbatim.
 * Raw backend errors (network, 5xx, auth) are caught at the call site and
 * surfaced as `ActorLoadError` of kind `LOAD_FAILED` with a generic masked
 * message — never with the original error's text.
 *
 * Use the static factories so canonical messages stay in one place — the
 * call-time standby guard and the list-time filter both reuse them.
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

    static standbyPaymentNotSupported(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED,
            actorName,
            `Actor "${actorName}" is a standby Actor, which is not supported in agentic payment mode. Please use OAuth or direct Apify token authentication in order to use standby Actors.`,
        );
    }
}
