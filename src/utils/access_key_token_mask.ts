import log from '@apify/log';

/** The token's own prefix stays, e.g. `apify_api_***`. */
const ACCESS_KEY_TOKEN_MASK = '***';

const TOKEN_SECRET_LENGTH = 36;

/** A cut-off token is still masked; a look-alike word such as `apify_proxy_groups` is not. */
const MIN_MASKED_TOKEN_SECRET_LENGTH = 20;

// Any `apify_<type>_` prefix, so a new type is masked too, or `integration_api_token_`, which OAuth clients hold.
const ACCESS_KEY_TOKEN_PREFIX_PATTERN = '(?:apify(?:_[a-z]{1,16}){1,4}|integration_api_token)_';

// A match never runs into the next token, so tokens pasted back to back are each masked.
const ACCESS_KEY_TOKEN_REGEX = new RegExp(
    `(${ACCESS_KEY_TOKEN_PREFIX_PATTERN})` +
        `(?:(?!apify_|integration_api_token_)[a-zA-Z0-9]){${MIN_MASKED_TOKEN_SECRET_LENGTH},${TOKEN_SECRET_LENGTH}}`,
    'g',
);

/** Masks the secret of every prefixed access token in `text`. Tokens without a prefix cannot be recognised. */
export function maskAccessKeyTokens(text: string): string {
    return text.replace(ACCESS_KEY_TOKEN_REGEX, `$1${ACCESS_KEY_TOKEN_MASK}`);
}

/** Masks access tokens in every log line written from now on. Call once, from the process entry point. */
export function maskAccessKeyTokensInLogs(): void {
    const { logger } = log.getOptions();
    const writeLine = logger._outputWithConsole.bind(logger);
    logger._outputWithConsole = (level, line) => writeLine(level, maskAccessKeyTokens(line));
}
