import { Analytics } from '@segment/analytics-node';

import log from '@apify/log';

import { DEFAULT_TELEMETRY_ENV, TELEMETRY_ENV, type TelemetryEnv } from './const.js';
import type { ToolCallTelemetryProperties } from './types.js';

const DEV_WRITE_KEY = '9rPHlMtxX8FJhilGEwkfUoZ0uzWxnzcT';
const PROD_WRITE_KEY = 'cOkp5EIJaN69gYaN8bcp7KtaD0fGABwJ';

// Event names following apify-core naming convention (Title Case)
const SEGMENT_EVENTS = {
    TOOL_CALL: 'MCP Tool Call',
} as const;

/**
 * Gets the telemetry environment, defaulting to 'prod' if not provided or invalid
 */
export function getTelemetryEnv(env?: string | null): TelemetryEnv {
    return (env === TELEMETRY_ENV.DEV || env === TELEMETRY_ENV.PROD) ? env : DEFAULT_TELEMETRY_ENV;
}

// Single Segment Analytics client (environment determined by process.env.TELEMETRY_ENV)
let analyticsClient: Analytics | null = null;

/**
 * Gets or initializes the Segment Analytics client.
 * The environment is determined by the TELEMETRY_ENV environment variable.
 *
 * @returns Analytics client instance or null if initialization failed
 */
export function getOrInitAnalyticsClient(): Analytics | null {
    if (!analyticsClient) {
        try {
            const env = getTelemetryEnv(process.env.TELEMETRY_ENV);
            const writeKey = env === TELEMETRY_ENV.PROD ? PROD_WRITE_KEY : DEV_WRITE_KEY;

            analyticsClient = new Analytics({
                writeKey,
                flushAt: 50,
                flushInterval: 5000,
            });
        } catch (error) {
            log.error('Segment initialization failed', { error });
            return null;
        }
    }
    return analyticsClient;
}

/**
 * Tracks a tool call event to Segment.
 *
 * @param userId - Apify user ID (null if not available)
 * @param properties - Event properties for the tool call
 */
export function trackToolCall(
    userId: string | null,
    properties: ToolCallTelemetryProperties,
): void {
    const client = getOrInitAnalyticsClient();

    if (!client) {
        return;
    }

    try {
        client.track({
            userId: userId || '',
            event: SEGMENT_EVENTS.TOOL_CALL,
            properties,
        });
    } catch (error) {
        log.error('Failed to track tool call event', { error, userId, toolName: properties.tool_name });
    }
}
