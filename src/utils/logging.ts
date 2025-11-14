import log from '@apify/log';

/**
 * Safely extract HTTP status code from errors.
 * Checks both `statusCode` and `code` properties for compatibility.
 */
export function getHttpStatusCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    // Check for statusCode property (used by apify-client)
    if ('statusCode' in error) {
        const { statusCode } = (error as { statusCode?: unknown });
        if (typeof statusCode === 'number' && statusCode >= 100 && statusCode < 600) {
            return statusCode;
        }
    }

    // Check for code property (used by some error types)
    if ('code' in error) {
        const { code } = (error as { code?: unknown });
        if (typeof code === 'number' && code >= 100 && code < 600) {
            return code;
        }
    }

    return undefined;
}

/**
 * Logs HTTP errors based on status code, following apify-core pattern.
 * Uses `softFail` for status < 500 (API client errors) and `exception` for status >= 500 (API server errors).
 * Similar to apify-core's `logHttpError` but uses `softFail` instead of `warning` for < 500.
 *
 * @param error - The error object
 * @param message - The log message
 * @param data - Additional data to include in the log
 */
export function logHttpError<T extends object>(error: unknown, message: string, data?: T): void {
    const statusCode = getHttpStatusCode(error);

    if (statusCode !== undefined && statusCode < 500) {
        // Client errors (< 500) - log as softFail
        log.softFail(message, { error, statusCode, ...data });
    } else if (statusCode !== undefined && statusCode >= 500) {
        // Server errors (>= 500) - log as exception
        const errorObj = error instanceof Error ? error : new Error(String(error));
        log.exception(errorObj, message, { statusCode, ...data });
    } else {
        // No status code available - log as error
        log.error(message, { error, ...data });
    }
}
