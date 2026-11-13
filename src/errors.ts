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
 * Thrown by `compileUntrustedSchema` when an untrusted Actor / proxied-MCP input schema exceeds a cap
 * (bytes, validator code, nested levels, enum values) that bounds AJV's synchronous codegen, or nests too deep for
 * its validator to run (no `limit` then). It's a property of the schema, not a server fault, so `logHttpError` logs it as a
 * soft fail and the caller drops just that one tool.
 */
export class SchemaTooLargeError extends Error {
    override readonly name = 'SchemaTooLargeError';

    constructor(
        public readonly limit?: number,
        unit?:
            | 'bytes'
            | 'bytes of validator code'
            | 'nested levels'
            | 'enum values'
            | 'nested blocks of validator code'
            | 'referenced schemas for one value',
    ) {
        super(
            limit === undefined
                ? 'Input schema is nested too deep for its validator to run'
                : `Input schema exceeds the safety limit of ${limit} ${unit}`,
        );
    }
}

/** The longest Actor or tool name shown in a message: a tool name of a proxied MCP server has no limit of its own. */
const DISPLAYED_NAME_MAX_LENGTH = 64;

/**
 * A name that comes from outside, as plain text for one line of a message: without control and formatting
 * characters, line breaks included, and cut to a fixed length.
 */
function toDisplayedName(name: string): string {
    const characters = [
        ...name.slice(0, 2 * DISPLAYED_NAME_MAX_LENGTH).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ''),
    ];
    const isCut = characters.length > DISPLAYED_NAME_MAX_LENGTH || name.length > 2 * DISPLAYED_NAME_MAX_LENGTH;
    return `${characters.slice(0, DISPLAYED_NAME_MAX_LENGTH).join('')}${isCut ? '…' : ''}`;
}

export const ACTOR_LOAD_ERROR_KIND = {
    NOT_FOUND: 'not-found',
    LOAD_FAILED: 'load-failed',
    STANDBY_PAYMENT_NOT_SUPPORTED: 'standby-payment-not-supported',
    SERVER_ACTOR_WITHOUT_MCP_NOT_SUPPORTED: 'server-actor-without-mcp-not-supported',
    INPUT_SCHEMA_NOT_LOADED: 'input-schema-not-loaded',
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

    static serverActorWithoutMcpNotSupported(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.SERVER_ACTOR_WITHOUT_MCP_NOT_SUPPORTED,
            actorName,
            `Actor "${actorName}" has no MCP tools or input interface.`,
        );
    }

    /**
     * `toolName` is the tool of an MCP server Actor; without it the Actor's own tool was left out. The MCP server
     * chooses its tool names, so the message shows both names shortened and without control characters.
     */
    static inputSchemaNotLoaded(actorName: string, compileError: unknown, toolName?: string): ActorLoadError {
        const actor = `Actor "${toDisplayedName(actorName)}"`;
        const subject = toolName === undefined ? actor : `Tool "${toDisplayedName(toolName)}" of ${actor}`;
        const reason = compileError instanceof SchemaTooLargeError ? 'too large' : 'not valid';
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.INPUT_SCHEMA_NOT_LOADED,
            actorName,
            `${subject} was not loaded because its input schema is ${reason}.`,
        );
    }

    static standbyPaymentNotSupported(actorName: string): ActorLoadError {
        return new ActorLoadError(
            ACTOR_LOAD_ERROR_KIND.STANDBY_PAYMENT_NOT_SUPPORTED,
            actorName,
            `Actor "${actorName}" is a standby Actor, which is not supported in agentic payment mode.` +
                ' Please use OAuth or direct Apify token authentication in order to use standby Actors.',
        );
    }
}
