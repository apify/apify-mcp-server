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
 * Removes characters invalid in HTTP headers, trims whitespace, and strips surrounding quotes.
 * Node.js allows only [\t\x20-\x7e\x80-\xff] in header values (ERR_INVALID_CHAR otherwise).
 * CI secrets can contain control characters beyond \r\n that break HTTP requests.
 */
export function sanitizeEnvValue(value?: string): string | undefined {
    if (value == null) return value;
    return value.replace(/[^\t\x20-\x7e\x80-\xff]/g, '').trim().replace(/^"|"$/g, '');
}

/**
 * Env var keys that may end up in HTTP headers (API keys, tokens, URLs).
 * Third-party libraries (e.g. phoenix-otel) read these directly from
 * process.env, bypassing our sanitizeEnvValue() wrapper.
 * sanitizeProcessEnv() rewrites them in-place so every reader gets clean values.
 */
const ENV_KEYS_TO_SANITIZE = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'PHOENIX_API_KEY',
    'PHOENIX_BASE_URL',
    'APIFY_TOKEN',
    'APIFY_API_TOKEN',
];

/**
 * Sanitize sensitive env vars in-place on process.env.
 * Must be called before any library reads these values.
 */
export function sanitizeProcessEnv(): void {
    for (const key of ENV_KEYS_TO_SANITIZE) {
        const raw = process.env[key];
        if (raw != null) {
            process.env[key] = sanitizeEnvValue(raw);
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
