import * as crypto from 'node:crypto';

import { Analytics } from '@segment/analytics-node';
import type { z } from 'zod';

import log from '@apify/log';

import { DEFAULT_TELEMETRY_ENV, TELEMETRY_ENV } from './const.js';
import type { reportProblemArgsSchema } from './tools/dev/report_problem.js';
import type { ReportedProblemTelemetryProperties, TelemetryEnv, ToolCallTelemetryProperties } from './types.js';

type ReportProblemArgs = z.infer<typeof reportProblemArgsSchema>;

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
    REPORTED_PROBLEM: 'MCP Reported Problem',
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
 * Segment requires either userId OR anonymousId, but not both. When the Apify user is known, use
 * userId; otherwise fall back to mcp_session_id so every unauthenticated call in the same session
 * shares one identity (loops/retries/funnels stay reconstructable) instead of a fresh random id per
 * event. A random UUID is the last resort only if a session id is somehow absent.
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
            ...(userId ? { userId } : { anonymousId: properties.mcp_session_id || crypto.randomUUID() }),
            event: SEGMENT_EVENTS.TOOL_CALL,
            properties,
        });
    } catch (error) {
        log.error('Failed to track tool call event', { error, userId, toolName: properties.tool_name });
    }
}

/**
 * Shapes an 'MCP Reported Problem' event payload from a `report-problem` submission. Reuses the
 * session/client context already assembled for the tool-call event and maps the validated tool args
 * to snake_case, dropping any absent optional fields. Tool-call-specific fields on `context`
 * (tool_name, tool_status, …) are intentionally not carried over.
 */
export function buildReportedProblemProperties(
    context: ToolCallTelemetryProperties,
    args: Record<string, unknown>,
): ReportedProblemTelemetryProperties {
    const { message, actorId, actorRunId, relatedTools } = args as ReportProblemArgs;

    return {
        app: context.app,
        app_version: context.app_version,
        mcp_client_name: context.mcp_client_name,
        mcp_client_version: context.mcp_client_version,
        mcp_protocol_version: context.mcp_protocol_version,
        mcp_session_id: context.mcp_session_id,
        transport_type: context.transport_type,
        message,
        ...(actorId !== undefined && { actor_id: actorId }),
        ...(actorRunId !== undefined && { actor_run_id: actorRunId }),
        ...(relatedTools !== undefined && { related_tools: relatedTools }),
    };
}

/**
 * Tracks a reported-problem submission (`report-problem`) to Segment. Identity handling mirrors
 * {@link trackToolCall}: a known Apify user is sent as `userId`, otherwise the session id is the
 * `anonymousId` so a session's submissions share one identity.
 */
export function trackReportedProblem(
    userId: string | null,
    telemetryEnv: TelemetryEnv,
    properties: ReportedProblemTelemetryProperties,
): void {
    const client = getOrInitAnalyticsClient(telemetryEnv);

    try {
        client?.track({
            ...(userId ? { userId } : { anonymousId: properties.mcp_session_id || crypto.randomUUID() }),
            event: SEGMENT_EVENTS.REPORTED_PROBLEM,
            properties,
        });
    } catch (error) {
        log.error('Failed to track reported problem event', { error, userId });
    }
}
