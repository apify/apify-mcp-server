import log from '@apify/log';

// The server passes its Apify token to the Apify API, which accepts these token types: API, Console UI, Actor run,
// webhook dispatch, ad hoc and integration tokens. An Actor with limited permissions gets an Actor run token.
const APIFY_TOKEN_PREFIX_PATTERN =
    '(?:apify_(?:api|ui|actor_run_api|webhook_dispatch|adhoc_api)|integration_api_token)_';

// A token has 36 alphanumerics after the prefix. 16 or more keeps file names such as `apify_api_request.js` in stacks.
// Not `{16,}`: V8 overflows its stack on that for a multi-megabyte run of alphanumerics, but not on `*?`.
// The match never runs into the next prefix, so tokens joined with no separator are each replaced.
const APIFY_TOKEN_REGEX = new RegExp(
    `(${APIFY_TOKEN_PREFIX_PATTERN})(?:(?!${APIFY_TOKEN_PREFIX_PATTERN})[A-Za-z0-9]){16}[A-Za-z0-9]*?(?=${APIFY_TOKEN_PREFIX_PATTERN}|[^A-Za-z0-9]|$)`,
    'g',
);

/** `text` with every Apify token replaced by its prefix and `***`, e.g. `apify_api_***`. */
export function redactApifyTokens(text: string): string {
    return text.replace(APIFY_TOKEN_REGEX, '$1***');
}

/**
 * Replaces every Apify token in every log line the process writes from now on. A caller can send a token as any
 * argument, an Actor name included, and many log statements write arguments as given. The token is replaced in the
 * finished line, which covers the message, the data and the exception alike. Call once, from the process entry point.
 */
export function redactApifyTokensInLogs(): void {
    const { logger } = log.getOptions();
    const writeLine = logger._outputWithConsole.bind(logger);
    logger._outputWithConsole = (level, line) => writeLine(level, redactApifyTokens(line));
}
