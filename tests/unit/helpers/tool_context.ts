import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../../src/const.js';
import type { InternalToolArgs } from '../../../src/types.js';

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

/** Parse the ```` ```json … ``` ```` block emitted by internal storage tools. */
export function parseFencedJson(text: string): unknown {
    return JSON.parse(text.replace(/^```json\n/, '').replace(/\n```$/, ''));
}

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
