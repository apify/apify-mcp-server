import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decode as decodeToon } from '@toon-format/toon';
import { expect } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../../src/const.js';
import type { InternalToolArgs } from '../../../src/types.js';
import { FENCES } from '../../../src/utils/encode_text.js';
import type { CachedUserInfo } from '../../../src/utils/userid_cache.js';

/** Default `CachedUserInfo` for tests that mock `getUserInfoCached`. */
export function mockUserInfo(overrides: Partial<CachedUserInfo> = {}): CachedUserInfo {
    return { userId: 'USER_ID', userPlanTier: 'FREE', isOrganization: false, ...overrides };
}

/** Inverse of `wrapJsonText`; imports prod's fence constants so the two halves can't drift. */
export function parseFencedJson(text: string): unknown {
    return JSON.parse(text.slice(FENCES.json.prefix.length, -FENCES.json.suffix.length));
}

/**
 * Inverse of `encodeToon` — decodes the fenced tool text whether it shipped TOON or fell back to
 * JSON. Tolerates prose after the closing fence (storage list tools append summary/nextStep).
 * For flat payloads (what the array-endpoint mocks use) the TOON round-trip is exact.
 */
export function decodeFencedToolText(text: string): unknown {
    const format = text.startsWith(FENCES.toon.prefix) ? 'toon' : 'json';
    const { prefix, suffix } = FENCES[format];
    const body = text.slice(prefix.length, text.indexOf(suffix, prefix.length));
    return format === 'toon' ? decodeToon(body) : JSON.parse(body);
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
