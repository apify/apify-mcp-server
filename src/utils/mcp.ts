import type { ToolTelemetryContext } from '../types.js';
import { getHttpStatusCode } from './logging.js';

/** MCP `_meta` key for Apify Actor run information. Namespaced per MCP spec. */
export const APIFY_ACTOR_RUN_META_KEY = 'com.apify/ActorRun';

/**
 * Builds usage metadata for MCP response from a source object containing Apify run costs.
 * Nests fields under the `com.apify/ActorRun` namespaced key as required by the MCP `_meta` spec
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/index#_meta).
 * @returns `{ 'com.apify/ActorRun': { usageTotalUsd, usageUsd } }`, or undefined if no usage data.
 */
export function buildUsageMeta(source: {
    usageTotalUsd?: number;
    usageUsd?: unknown;
}): Record<string, unknown> | undefined {
    const { usageTotalUsd, usageUsd } = source;
    return usageTotalUsd !== undefined
        ? {
            [APIFY_ACTOR_RUN_META_KEY]: { usageTotalUsd, usageUsd },
        }
        : undefined;
}

/**
 * Helper to build a content response for MCP from an array of text strings.
 *
 * Status model:
 * - `isError` is MCP-visible — returned to the client.
 * - `telemetry` is server-internal — attached as `toolTelemetry` on the response,
 *   then stripped by `extractToolTelemetry()` before the response reaches the client.
 *   Contains tool outcome (toolStatus, failureCategory, etc.) used for Segment telemetry.
 */
export function buildMCPResponse(options: {
    texts: string[];
    isError?: boolean;
    telemetry?: ToolTelemetryContext;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
}) {
    const { texts, isError = false, telemetry, structuredContent, _meta } = options;

    return {
        content: texts.map((text) => ({ type: 'text' as const, text })),
        isError,
        ...(telemetry && { toolTelemetry: telemetry }),
        ...(structuredContent !== undefined && { structuredContent }),
        ...(_meta !== undefined && { _meta }),
    };
}

/** User-facing error text for tool execution failures with HTTP-aware hints. */
export function getToolCallErrorUserText(toolName: string, error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    const status = getHttpStatusCode(error);
    if (status === 403) {
        return `Error calling tool "${toolName}": ${msg}. The resource may be private or your token may lack access.`;
    }
    if (status === 401) {
        return `Error calling tool "${toolName}": ${msg}. Authentication failed — check APIFY_TOKEN is set and valid.`;
    }
    return `Error calling tool "${toolName}": ${msg}. Verify the tool name and input parameters.`;
}
