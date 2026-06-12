import type { ToolCallTelemetryProperties, ToolTelemetryContext } from '../types.js';
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

/**
 * Computes tool response payload bytes, split by payload side:
 * `fileBytes` sums the UTF-8 byte length of file/record payload strings in `content[]` — image/audio base64 `data` and
 * embedded `resource` base64 `blob` / inline `text` — kept separate so binary/file payloads don't skew the text metric;
 * Kept separate because clients consume only one side — newer read `structuredContent`, older read
 * `content[]` — so summing them double-counts mirrored payloads. Other fields (`isError`, `_meta`, etc.)
 * are not counted.
 */
export function computeToolResponseBytes(result: unknown): {
    contentBytes: number;
    structuredContentBytes: number;
    fileBytes: number;
} {
    let contentBytes = 0;
    let structuredContentBytes = 0;
    let fileBytes = 0;
    if (result && typeof result === 'object') {
        const res = result as { content?: unknown; structuredContent?: unknown };
        if (Array.isArray(res.content)) {
            for (const item of res.content) {
                const block = item as {
                    text?: unknown;
                    data?: unknown;
                    resource?: { blob?: unknown; text?: unknown };
                };
                // Conversational text the tool wrote for the model.
                if (typeof block?.text === 'string') {
                    contentBytes += Buffer.byteLength(block.text, 'utf8');
                }
                // Returned files/records: image/audio base64 `data`, embedded `resource` blob/text.
                for (const payload of [block?.data, block?.resource?.blob, block?.resource?.text]) {
                    if (typeof payload === 'string') {
                        fileBytes += Buffer.byteLength(payload, 'utf8');
                    }
                }
            }
        }
        if (res.structuredContent != null) {
            try {
                const json = JSON.stringify(res.structuredContent);
                if (json) structuredContentBytes += Buffer.byteLength(json, 'utf8');
            } catch {
                // Non-serialisable structured content (e.g. circular) — skip.
            }
        }
    }
    return { contentBytes, structuredContentBytes, fileBytes };
}

/**
 * Maps computed response byte counts to their `tool_response_*_bytes` telemetry fields.
 * Single source of truth for the field set, so adding a byte metric touches only
 * `computeToolResponseBytes` and this mapping. Returns `{}` when bytes weren't computed
 * (e.g. telemetry-disabled path) so callers can spread it unconditionally.
 */
export function buildResponseBytesTelemetry(
    responseBytes?: ReturnType<typeof computeToolResponseBytes>,
): Pick<
    ToolCallTelemetryProperties,
    'tool_response_content_bytes' | 'tool_response_structured_content_bytes' | 'tool_response_file_bytes'
> {
    if (!responseBytes) return {};
    return {
        tool_response_content_bytes: responseBytes.contentBytes,
        tool_response_structured_content_bytes: responseBytes.structuredContentBytes,
        tool_response_file_bytes: responseBytes.fileBytes,
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
