/**
 * Shared configuration for evaluation systems
 * Contains OpenRouter config, environment validation, and common utilities
 */

/**
 * OpenRouter API configuration
 * OPENROUTER_BASE_URL is optional and defaults to the standard OpenRouter API URL
 */
export const OPENROUTER_CONFIG = {
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
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
 * Removes newlines and trims whitespace. Useful for Authorization header values
 * because CI secrets sometimes include trailing newlines or quotes.
 */
export function sanitizeHeaderValue(value?: string): string | undefined {
    if (value == null) return value;
    return value.replace(/[\r\n]/g, '').trim().replace(/^"|"$/g, '');
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
