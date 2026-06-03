import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decode as decodeToon } from '@toon-format/toon';
import { expect } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../../src/const.js';
import type { InternalToolArgs } from '../../../src/types.js';
import { JSON_FENCE_PREFIX, JSON_FENCE_SUFFIX } from '../../../src/utils/mcp.js';

/** Inverse of `encodeJsonText`; imports prod's fence constants so the two halves can't drift. */
export function parseFencedJson(text: string): unknown {
    return JSON.parse(text.slice(JSON_FENCE_PREFIX.length, -JSON_FENCE_SUFFIX.length));
}

/**
 * Inverse of `encodeCompactText` — decodes the fenced tool text whether the picker shipped JSON
 * or TOON. For flat payloads (what the array-endpoint mocks use) the TOON round-trip is exact.
 */
export function decodeFencedToolText(text: string): unknown {
    if (text.startsWith('```toon\n')) {
        return decodeToon(text.slice('```toon\n'.length, -JSON_FENCE_SUFFIX.length));
    }
    return parseFencedJson(text);
}

/**
 * `CallToolResult` narrowed to text-only content. All current internal tools
 * emit text content, so tests cast results to this shape to avoid the
 * `content[i]` union (text | image | audio | resource_link | resource).
 */
export type TextToolResult = Omit<CallToolResult, 'content'> & {
    content: Extract<CallToolResult['content'][number], { type: 'text' }>[];
};

export type ToolTelemetrySnapshot = {
    toolStatus?: string;
    failureCategory?: string;
};

/** Minimal `InternalToolArgs` stub for unit tests. */
export function stubToolCallContext(
    args: Record<string, unknown>,
    client: InternalToolArgs['apifyClient'],
): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: client,
        extra: {},
        mcpServer: {},
        apifyMcpServer: { options: { paymentProvider: undefined } },
    } as unknown as InternalToolArgs;
}

/** Assert not-found style soft-fail responses with INVALID_INPUT telemetry. */
export function expectSoftFailInvalidInput(result: { isError?: boolean; toolTelemetry?: ToolTelemetrySnapshot }): void {
    expect(result.isError).toBe(true);
    expect(result.toolTelemetry).toEqual(
        expect.objectContaining({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
        }),
    );
}
