/**
 * Shared configuration for evaluation systems
 * Contains OpenRouter config, environment validation, and common utilities
 */

/**
 * OpenRouter API configuration
 * OPENROUTER_BASE_URL is optional and defaults to the standard OpenRouter API URL
 */
export const OPENROUTER_CONFIG = {
    baseURL: sanitizeEnvValue(process.env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1',
    apiKey: sanitizeEnvValue(process.env.OPENROUTER_API_KEY) || '',
};

/**
 * Get required environment variables
 * Note: OPENROUTER_BASE_URL is optional (defaults to https://openrouter.ai/api/v1)
 */
export function getRequiredEnvVars(): Record<string, string | undefined> {
    return {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
}

/**
 * Strips control characters, trims whitespace, and removes surrounding double quotes.
 * CI secrets often contain trailing newlines or invisible control chars that break HTTP headers.
 */
export function sanitizeEnvValue(value?: string): string | undefined {
    if (value == null) return value;
    return (
        value
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '')
            .trim()
            .replace(/^"|"$/g, '')
    );
}

/**
 * Env vars used in HTTP headers (API keys, tokens, URLs).
 *
 * Why in-place? The phoenix-otel exporter and the Langfuse SDK both read these
 * directly from process.env and pass them to node:http, which throws
 * ERR_INVALID_CHAR on any control characters. We can't intercept those reads, so
 * we sanitize process.env itself before any library loads.
 */
const ENV_KEYS_TO_SANITIZE = [
    'APIFY_TOKEN',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'PHOENIX_API_KEY',
    'PHOENIX_BASE_URL',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
];

/**
 * Names of the given env vars that are unset or empty, so an entry point can report
 * every missing one at once instead of failing on the first.
 */
export function findMissingEnvVars(keys: readonly string[]): string[] {
    return keys.filter((key) => !process.env[key]);
}

/**
 * Redact a value for safe logging: shows first 4 and last 4 chars, masks the rest.
 * Fully masks short values (≤ 8 chars) to prevent reconstruction from the log line.
 * Returns '(empty)' for empty strings, '(unset)' for undefined/null.
 */
function redact(value?: string | null): string {
    if (value == null) return '(unset)';
    if (value.length === 0) return '(empty)';
    if (value.length <= 6) return `*** (${value.length} chars)`;
    return `${value.slice(0, 3)}***${value.slice(-3)} (${value.length} chars)`;
}

/**
 * Sanitize env vars in-place on process.env and log redacted values for CI debugging.
 * Must be called before any library reads these values.
 */
export function sanitizeProcessEnv(): void {
    for (const key of ENV_KEYS_TO_SANITIZE) {
        const raw = process.env[key];
        if (raw != null) {
            const sanitized = sanitizeEnvValue(raw)!;
            const changed = raw !== sanitized;
            process.env[key] = sanitized;
            // eslint-disable-next-line no-console
            console.log(`env ${key}: ${redact(sanitized)}${changed ? ' (sanitized)' : ''}`);
        } else {
            // eslint-disable-next-line no-console
            console.log(`env ${key}: ${redact(raw)}`);
        }
    }
}

/**
 * Validate that all required environment variables are present
 */
export function validateEnvVars(): boolean {
    const envVars = getRequiredEnvVars();
    const missing = Object.entries(envVars)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        return false;
    }

    return true;
}
