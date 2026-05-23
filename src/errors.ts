export class TimeoutError extends Error {
    override readonly name = 'TimeoutError';
}

export const ACTOR_LOAD_ERROR_KIND = {
    NOT_FOUND: 'not-found',
    LOAD_FAILED: 'load-failed',
    STANDBY_PAYMENT_NOT_SUPPORTED: 'standby-payment-not-supported',
} as const;
export type ActorLoadErrorKind = (typeof ACTOR_LOAD_ERROR_KIND)[keyof typeof ACTOR_LOAD_ERROR_KIND];

/**
 * Returned or thrown by single-Actor loading paths when the load fails for a
 * *sanitized*, user-safe reason.
 *
 * `message` is always safe to forward to the LLM agent / client verbatim.
 * Raw backend errors (network, 5xx, auth) are caught at the throw site and
 * re-thrown as `ActorLoadError` of kind `LOAD_FAILED` with a generic masked
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

    static standbyPaymentNotSupported(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED,
            actorName,
            `Actor "${actorName}" is a standby Actor, which is not supported in agentic payment mode.`,
        );
    }
}
