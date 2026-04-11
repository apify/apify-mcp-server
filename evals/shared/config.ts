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
