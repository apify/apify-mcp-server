import log from '@apify/log';

/** Replaces the secret. The token's own prefix stays in the text, e.g. `apify_api_***`. */
const ACCESS_KEY_TOKEN_MASK = '***';

/** The number of characters that a token has after its prefix. */
const TOKEN_SECRET_LENGTH = 36;

/**
 * A cut-off token is still masked from this length up, while a word that only starts like a token, such as
 * `apify_proxy_groups`, stays readable.
 */
const MIN_MASKED_TOKEN_SECRET_LENGTH = 20;

// A token is `apify_`, one to four lower-case words that name its type, and the secret, e.g. `apify_api_<secret>`.
// The types are not listed, so a new type with that shape is masked too; a token without the `apify_` prefix is not.
// The match ends at the full token length and never runs into the next token, so that a token pasted right behind
// another one, or behind a cut-off one, is masked too.
const ACCESS_KEY_TOKEN_REGEX = new RegExp(
    `(apify(?:_[a-z]{1,16}){1,4}_)(?:(?!apify_)[a-zA-Z0-9]){${MIN_MASKED_TOKEN_SECRET_LENGTH},${TOKEN_SECRET_LENGTH}}`,
    'g',
);

/**
 * Masks the secret of every access token found in the text. Finds only tokens with a type prefix: version 1 tokens
 * have none and cannot be told from other text.
 */
export function maskAccessKeyTokens(text: string): string {
    return text.replace(ACCESS_KEY_TOKEN_REGEX, `$1${ACCESS_KEY_TOKEN_MASK}`);
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
