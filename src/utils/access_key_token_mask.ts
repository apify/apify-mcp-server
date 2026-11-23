import log from '@apify/log';

/**
 * Names and values follow `maskAccessKeyTokens` in apify-core (`src/packages/iam-server/src/iam_tools.ts`), so both
 * mask the same tokens in the same way.
 */
const ACCESS_KEY_TOKEN_PREFIXES = [
    'apify_api',
    'apify_proxy',
    'apify_ui',
    'apify_actor_run_api',
    'apify_actor_run_proxy',
    'integration_api_token',
    'apify_webhook_dispatch',
    'apify_adhoc_api',
];

const ACCESS_KEY_TOKEN_MASK = '[TKN]';

/** The number of characters that a token has after its prefix. */
const TOKEN_SECRET_LENGTH = 36;

/**
 * A cut-off token is still masked from this length up, while a word that only starts like a token, such as
 * `apify_proxy_groups`, stays readable.
 */
const MIN_MASKED_TOKEN_SECRET_LENGTH = 20;

const ACCESS_KEY_TOKEN_PREFIX_PATTERN = `(?:${ACCESS_KEY_TOKEN_PREFIXES.join('|')})_`;

// The match ends at the full token length and never runs into the next prefix, so that a token pasted right behind
// another one, or behind a cut-off one, is masked too.
const ACCESS_KEY_TOKEN_REGEX = new RegExp(
    `${ACCESS_KEY_TOKEN_PREFIX_PATTERN}(?:(?!${ACCESS_KEY_TOKEN_PREFIX_PATTERN})[a-zA-Z0-9]){${MIN_MASKED_TOKEN_SECRET_LENGTH},${TOKEN_SECRET_LENGTH}}`,
    'g',
);

/**
 * Replaces every access token found in the text. Finds only tokens with a type prefix: version 1 tokens
 * have none and cannot be told from other text.
 */
export function maskAccessKeyTokens(text: string): string {
    return text.replace(ACCESS_KEY_TOKEN_REGEX, ACCESS_KEY_TOKEN_MASK);
}

/**
 * Masks the access tokens in every log line the process writes from now on. A caller can send a token as any
 * argument, an Actor name included, and many log statements write arguments as given. The token is replaced in the
 * finished line, which covers the message, the data and the exception alike. Call once, from the process entry point.
 */
export function maskAccessKeyTokensInLogs(): void {
    const { logger } = log.getOptions();
    const writeLine = logger._outputWithConsole.bind(logger);
    logger._outputWithConsole = (level, line) => writeLine(level, maskAccessKeyTokens(line));
}
