import { Analytics } from '@segment/analytics-node';

import { DEFAULT_TELEMETRY_ENV, TELEMETRY_ENV, type TelemetryEnv } from './const.js';
import type { ToolCallTelemetryProperties } from './types.js';

const DEV_WRITE_KEY = '9rPHlMtxX8FJhilGEwkfUoZ0uzWxnzcT';
const PROD_WRITE_KEY = 'cOkp5EIJaN69gYaN8bcp7KtaD0fGABwJ';

const SEGMENT_EVENTS = {
    TOOL_CALL: 'MCP Tool Call',
};

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
 * @returns Analytics client instance
 */
export function getOrInitAnalyticsClient(): Analytics {
    if (!analyticsClient) {
        const env = getTelemetryEnv(process.env.TELEMETRY_ENV);
        const writeKey = env === TELEMETRY_ENV.PROD ? PROD_WRITE_KEY : DEV_WRITE_KEY;
        analyticsClient = new Analytics({ writeKey });
    }
    return analyticsClient;
}

/**
 * Tracks a tool call event to Segment.
 *
 * @param userId - Apify user ID (TODO: extract from token when auth available)
 * @param properties - Event properties for the tool call
 */
export function trackToolCall(
    userId: string,
    properties: ToolCallTelemetryProperties,
): void {
    const client = getOrInitAnalyticsClient();

    // TODO: Implement anonymousId tracking for device/session identification
    client.track({
        userId: userId || '',
        event: SEGMENT_EVENTS.TOOL_CALL,
        properties,
    });
}
