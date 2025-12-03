import * as crypto from 'node:crypto';

import { Analytics } from '@segment/analytics-node';

import log from '@apify/log';

import {
    DEFAULT_TELEMETRY_ENV,
    SEGMENT_FLUSH_AT_EVENTS,
    SEGMENT_FLUSH_INTERVAL_MS,
    TELEMETRY_ENV,
} from './const.js';
import type { TelemetryEnv, ToolCallTelemetryProperties } from './types.js';

const DEV_WRITE_KEY = '9rPHlMtxX8FJhilGEwkfUoZ0uzWxnzcT';
const PROD_WRITE_KEY = 'cOkp5EIJaN69gYaN8bcp7KtaD0fGABwJ';

// Event names following apify-core naming convention (Title Case)
const SEGMENT_EVENTS = {
    TOOL_CALL: 'MCP Tool Call',
} as const;

/**
 * Gets the telemetry environment, defaulting to 'PROD' if not provided or invalid
 */
export function getTelemetryEnv(env?: string | null): TelemetryEnv {
    if (!env) {
        return DEFAULT_TELEMETRY_ENV;
    }
    const normalizedEnv = env.toUpperCase();
    if (normalizedEnv === TELEMETRY_ENV.DEV || normalizedEnv === TELEMETRY_ENV.PROD) {
        return normalizedEnv as TelemetryEnv;
    }
    return DEFAULT_TELEMETRY_ENV;
}

// Single Segment Analytics client (environment determined by process.env.TELEMETRY_ENV)
let analyticsClient: Analytics | null = null;

/**
 * Gets or initializes the Segment Analytics client.
 * The environment is determined by the TELEMETRY_ENV environment variable.
 *
 * @returns Analytics client instance or null if initialization failed
 */
export function getOrInitAnalyticsClient(telemetryEnv: TelemetryEnv): Analytics | null {
    if (!analyticsClient) {
        try {
            const writeKey = telemetryEnv === TELEMETRY_ENV.PROD ? PROD_WRITE_KEY : DEV_WRITE_KEY;
            analyticsClient = new Analytics({
                writeKey,
                flushAt: SEGMENT_FLUSH_AT_EVENTS,
                flushInterval: SEGMENT_FLUSH_INTERVAL_MS,
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
 * Segment requires either userId OR anonymousId, but not both
 * When userId is available, use it; otherwise use anonymousId
 *
 * @param userId - Apify user ID (null if not available)
 * @param telemetryEnv - Telemetry environment
 * @param properties - Event properties for the tool call
 */
export function trackToolCall(
    userId: string | null,
    telemetryEnv: TelemetryEnv,
    properties: ToolCallTelemetryProperties,
): void {
    const client = getOrInitAnalyticsClient(telemetryEnv);

    try {
        client?.track({
            ...(userId ? { userId } : { anonymousId: crypto.randomUUID() }),
            event: SEGMENT_EVENTS.TOOL_CALL,
            properties,
        });
    } catch (error) {
        log.error('Failed to track tool call event', { error, userId, toolName: properties.tool_name });
    }
}
