import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../const.js';
import type { AjvErrorDetails, ApifyRequestParams, FailureCategory, ToolTelemetryContext } from '../types.js';
import { ACTOR_RUN_LIMIT_MESSAGE, isActorRunLimitError } from './apify_errors.js';
import { wrapJsonText } from './encode_text.js';
import { getHttpStatusCode } from './logging.js';
import { classifyFailureCategory, getToolStatusFromError } from './tool_status.js';

/** MCP `_meta` key for Apify Actor run information. Namespaced per MCP spec. */
export const APIFY_ACTOR_RUN_META_KEY = 'com.apify/ActorRun';

/**
 * Injects the MCP session ID into request parameters.
 * Always ensures a params object exists, even for requests that normally have no params (e.g., listTasks/getTasks),
 * otherwise mcpSessionId injection fails, breaking session isolation in multi-node setups.
 * @param params Request parameters (may be undefined)
 * @param mcpSessionId Session ID to inject
 * @returns Params object with _meta.mcpSessionId set
 */
export function injectMcpSessionId(params: ApifyRequestParams | undefined, mcpSessionId: string): ApifyRequestParams {
    const result = (params || {}) as ApifyRequestParams;
    result._meta ??= {};
    result._meta.mcpSessionId = mcpSessionId;
    return result;
}

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
function buildMCPResponse(options: {
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
    } as unknown as ToolResponse;
}

/**
 * Module-private brand. Phantom `declare`d symbol — never assigned or emitted at runtime, so it adds
 * nothing to the wire. Its only job is to make `ToolResponse` unforgeable at compile time.
 */
declare const toolResponseBrand: unique symbol;

/**
 * Shared return type of the `respond*` constructors and of every `HelperTool.call`. The required brand
 * means a raw `{ content, isError }` literal (or a bare `{}`) fails to compile — the only way to produce a
 * `ToolResponse` is a constructor here. `content` is the full MCP `ContentBlock` union so image/audio/
 * resource returns type-check.
 *
 * `content` and `isError` are optional because the escape hatches may omit them: `respondAborted()`
 * returns `{}` (both absent) and `respondRaw()` passes a `CallToolResult` through unchanged (which may
 * omit `isError`). Consumers reading either field must guard (`?.`, an `in` check, or the `textOf` helper).
 */
export type ToolResponse = {
    content?: ContentBlock[];
    isError?: boolean;
    toolTelemetry?: ToolTelemetryContext;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
} & { readonly [toolResponseBrand]: never };

/** Normalise a `string | string[]` text argument to the array `buildMCPResponse` expects. */
function toTexts(texts: string | string[]): string[] {
    return Array.isArray(texts) ? texts : [texts];
}

/**
 * Success response carrying caller-supplied text. `content[0]` is the raw text verbatim — bare JSON
 * stays bare (the raw-JSON mirror channel), so use this (not `respondJson`) for unfenced JSON payloads.
 */
export function respondOk(
    texts: string | string[],
    opts?: { structuredContent?: unknown; meta?: Record<string, unknown> },
): ToolResponse {
    return buildMCPResponse({
        texts: toTexts(texts),
        structuredContent: opts?.structuredContent,
        _meta: opts?.meta,
    });
}

/**
 * Success response carrying a JSON value in a ```json code fence. Owns the fence by delegating to
 * `wrapJsonText` — use only where the byte output already leads with a ```json fence.
 */
export function respondJson(
    value: unknown,
    opts?: { structuredContent?: unknown; meta?: Record<string, unknown> },
): ToolResponse {
    return buildMCPResponse({
        texts: [wrapJsonText(value)],
        structuredContent: opts?.structuredContent,
        _meta: opts?.meta,
    });
}

/**
 * User-error response (`SOFT_FAIL`). `category` defaults to `INVALID_INPUT`; the type excludes
 * `INTERNAL_ERROR` (a server category — use `respondServerError` for that).
 */
export function respondUserError(
    texts: string | string[],
    opts?: {
        category?: Exclude<FailureCategory, 'INTERNAL_ERROR'>;
        httpStatus?: number;
        detail?: string;
        actorId?: string;
        ajvErrorDetails?: AjvErrorDetails;
        structuredContent?: unknown;
    },
): ToolResponse {
    return buildMCPResponse({
        texts: toTexts(texts),
        isError: true,
        telemetry: {
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: opts?.category ?? FAILURE_CATEGORY.INVALID_INPUT,
            ...(opts?.httpStatus !== undefined && { failureHttpStatus: opts.httpStatus }),
            ...(opts?.detail !== undefined && { failureDetail: opts.detail }),
            ...(opts?.actorId !== undefined && { actorId: opts.actorId }),
            ...(opts?.ajvErrorDetails !== undefined && { ajvErrorDetails: opts.ajvErrorDetails }),
        },
        structuredContent: opts?.structuredContent,
    });
}

/**
 * Server-error response. Derives `toolStatus`/`failureCategory`/`failureHttpStatus` from the caught
 * error (so a 4xx yields `SOFT_FAIL`, not `FAILED`); with no error → `FAILED` + `INTERNAL_ERROR`.
 */
export function respondServerError(
    texts: string | string[],
    opts?: {
        error?: unknown;
        detail?: string;
        actorId?: string;
        structuredContent?: unknown;
        meta?: Record<string, unknown>;
    },
): ToolResponse {
    const { error } = opts ?? {};
    const httpStatus = getHttpStatusCode(error);
    return buildMCPResponse({
        texts: toTexts(texts),
        isError: true,
        telemetry: {
            toolStatus: error === undefined ? TOOL_STATUS.FAILED : getToolStatusFromError(error, false),
            failureCategory: error === undefined ? FAILURE_CATEGORY.INTERNAL_ERROR : classifyFailureCategory(error),
            ...(httpStatus !== undefined && { failureHttpStatus: httpStatus }),
            ...(opts?.detail !== undefined && { failureDetail: opts.detail }),
            ...(opts?.actorId !== undefined && { actorId: opts.actorId }),
        },
        structuredContent: opts?.structuredContent,
        _meta: opts?.meta,
    });
}

/**
 * Error response for framework paths (native-tool handling and the outer catch in `server.ts`, the
 * x402 path) that record telemetry on local vars and bypass `extractToolTelemetry`. Carries no
 * `toolTelemetry` key, so nothing leaks onto the wire. Tool handlers must NOT use this — they return
 * a `respond*` error so telemetry is attached and then stripped by `extractToolTelemetry`.
 */
export function respondErrorNoTelemetry(
    texts: string | string[],
    opts?: { structuredContent?: unknown },
): ToolResponse {
    return { ...respondOk(texts, opts), isError: true };
}

/**
 * Brands an already-well-formed MCP result without reshaping it — runtime identity. For content this
 * module can't build: binary/resource blocks (image, audio, resource_link, embedded resource) and opaque
 * remote tool results. Returns the exact object passed in (no `isError` injection, no key reorder), so the
 * wire bytes stay identical.
 */
export function respondRaw(result: CallToolResult): ToolResponse {
    return result as unknown as ToolResponse;
}

/**
 * Empty response for MCP cancellation paths — per spec, receivers SHOULD NOT reply to a cancelled request.
 * Returns runtime `{}`, branded.
 */
export function respondAborted(): ToolResponse {
    return {} as unknown as ToolResponse;
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
 * Actionable hint for an HTTP failure status, or `undefined` when the status carries no specific
 * remedy. Shared by the tool-call and resources/read error paths so both differentiate auth failures
 * the same way (the model's only lever is the text it gets back).
 */
export function getHttpErrorHint(status: number | undefined): string | undefined {
    if (status === 403) return 'The resource may be private or your token may lack access.';
    if (status === 401) return 'Authentication failed, check APIFY_TOKEN is set and valid.';
    return undefined;
}

/** User-facing error text for tool execution failures with HTTP-aware hints. */
export function getToolCallErrorUserText(toolName: string, error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    if (isActorRunLimitError(error)) {
        return `Error calling tool "${toolName}": ${msg}. ${ACTOR_RUN_LIMIT_MESSAGE}`;
    }
    const hint = getHttpErrorHint(getHttpStatusCode(error)) ?? 'Verify the tool name and input parameters.';
    return `Error calling tool "${toolName}": ${msg}. ${hint}`;
}
