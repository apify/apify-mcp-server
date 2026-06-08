import * as crypto from 'node:crypto';

import { Analytics } from '@segment/analytics-node';

import log from '@apify/log';

import { DEFAULT_TELEMETRY_ENV, TELEMETRY_ENV } from './const.js';
import type {
    StorageAccessTelemetryProperties,
    StorageType,
    TelemetryEnv,
    ToolCallTelemetryProperties,
} from './types.js';

const DEV_WRITE_KEY = '9rPHlMtxX8FJhilGEwkfUoZ0uzWxnzcT';
const PROD_WRITE_KEY = 'cOkp5EIJaN69gYaN8bcp7KtaD0fGABwJ';

// We are using the same values as apify-core for consistency (despite that we ship events of different types).
// https://github.com/apify/apify-core/blob/2284766c122c6ac5bc4f27ec28051f4057d6f9c0/src/packages/analytics/src/server/segment.ts#L28
// Reasoning from the apify-core:
// Flush at 50 events to avoid sending too many small requests (default is 15)
const SEGMENT_FLUSH_AT_EVENTS = 50;
// Flush interval in milliseconds (default is 10000)
const SEGMENT_FLUSH_INTERVAL_MS = 5_000;

// Event names following apify-core naming convention (Title Case)
const SEGMENT_EVENTS = {
    TOOL_CALL: 'MCP Tool Call',
    STORAGE_ACCESS: 'MCP Storage Access',
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
 * Sends an event to Segment.
 * Segment requires either userId OR anonymousId, but not both:
 * when userId is available, use it; otherwise use a random anonymousId.
 */
function trackEvent(
    userId: string | null,
    telemetryEnv: TelemetryEnv,
    event: (typeof SEGMENT_EVENTS)[keyof typeof SEGMENT_EVENTS],
    properties: ToolCallTelemetryProperties | StorageAccessTelemetryProperties,
): void {
    const client = getOrInitAnalyticsClient(telemetryEnv);

    try {
        client?.track({
            ...(userId ? { userId } : { anonymousId: crypto.randomUUID() }),
            event,
            properties,
        });
    } catch (error) {
        log.error('Failed to track telemetry event', { error, userId, event, toolName: properties.tool_name });
    }
}

/**
 * Tracks a tool call event to Segment.
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
    trackEvent(userId, telemetryEnv, SEGMENT_EVENTS.TOOL_CALL, properties);
}

/**
 * Tracks a storage access event to Segment. Fired for storage tools (dataset /
 * key-value store) in addition to the `MCP Tool Call` event, so storage usage
 * and error rates can be analysed on a dedicated event.
 */
export function trackStorageAccess(
    userId: string | null,
    telemetryEnv: TelemetryEnv,
    properties: StorageAccessTelemetryProperties,
): void {
    trackEvent(userId, telemetryEnv, SEGMENT_EVENTS.STORAGE_ACCESS, properties);
}

/**
 * Projects a finalized tool-call event onto the dedicated storage-access event:
 * keeps the common envelope plus status / error fields and adds `storage_type`.
 * Actor / validation fields are dropped — they carry no meaning for storage tools.
 */
export function buildStorageAccessProperties(
    toolCall: ToolCallTelemetryProperties,
    storageType: StorageType,
): StorageAccessTelemetryProperties {
    return {
        app: toolCall.app,
        app_version: toolCall.app_version,
        mcp_client_name: toolCall.mcp_client_name,
        mcp_client_version: toolCall.mcp_client_version,
        mcp_protocol_version: toolCall.mcp_protocol_version,
        mcp_client_capabilities: toolCall.mcp_client_capabilities,
        mcp_session_id: toolCall.mcp_session_id,
        transport_type: toolCall.transport_type,
        tool_name: toolCall.tool_name,
        tool_status: toolCall.tool_status,
        tool_exec_time_ms: toolCall.tool_exec_time_ms,
        ...(toolCall.tool_response_content_bytes !== undefined && {
            tool_response_content_bytes: toolCall.tool_response_content_bytes,
        }),
        ...(toolCall.tool_response_structured_content_bytes !== undefined && {
            tool_response_structured_content_bytes: toolCall.tool_response_structured_content_bytes,
        }),
        ...(toolCall.failure_category !== undefined && { failure_category: toolCall.failure_category }),
        ...(toolCall.failure_http_status !== undefined && { failure_http_status: toolCall.failure_http_status }),
        ...(toolCall.failure_detail !== undefined && { failure_detail: toolCall.failure_detail }),
        storage_type: storageType,
    };
}
