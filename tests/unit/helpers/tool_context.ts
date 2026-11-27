import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { InvalidResponseBodyError } from 'apify-client';
import { AxiosError, type AxiosResponse } from 'axios';
import { expect } from 'vitest';

import type { ApifyClient } from '../../../src/apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES, TOOL_STATUS } from '../../../src/const.js';
import type { InternalToolArgs, ToolDescriptionContext } from '../../../src/types.js';
import type { CachedUserInfo } from '../../../src/utils/userid_cache.js';

/** Read the text off a content block; '' for non-text blocks. Keeps assertions on text responses tidy. */
export function textOf(block: ContentBlock): string {
    return 'text' in block ? block.text : '';
}

/** `ToolDescriptionContext` reporting every named tool present, everything else absent. */
export function only(...present: string[]): ToolDescriptionContext {
    const set = new Set(present);
    return { hasTool: (name) => set.has(name) };
}

/** Default `CachedUserInfo` for tests that mock `getUserInfoCached`. */
export function mockUserInfo(overrides: Partial<CachedUserInfo> = {}): CachedUserInfo {
    return { userId: 'USER_ID', userPlanTier: 'FREE', isOrganization: false, ...overrides };
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

/** The one unsafe `ApifyClient` cast: tests pass whatever client methods they stub. */
export function mockApifyClient(methods: Record<string, unknown> = {}): ApifyClient {
    return methods as unknown as ApifyClient;
}

/** A page of dataset items, an error status, a body over `MAX_INLINE_BYTES`, or a body that does not parse. */
export type DatasetItemsReply = { items: unknown[]; total: number } | { status: number } | 'overLimit' | 'unparsable';

/**
 * Stubs the dataset items request as apify-client's axios instance answers it. `reply` gets the request's
 * query params; `methods` overrides `dataset` or adds other client methods.
 */
export function mockDatasetItemsClient(
    reply: (params: Record<string, unknown>) => DatasetItemsReply,
    methods: Record<string, unknown> = {},
): ApifyClient {
    return mockApifyClient({
        dataset: (id: string) => ({ url: `https://api.apify.com/v2/datasets/${id}` }),
        httpClient: {
            axios: {
                request: async ({ url, params }: { url: string; params: Record<string, unknown> }) => {
                    const answer = reply(params);
                    if (answer === 'overLimit') {
                        throw new AxiosError(
                            `maxContentLength size of ${MAX_INLINE_BYTES} exceeded`,
                            'ERR_BAD_RESPONSE',
                        );
                    }
                    if (answer === 'unparsable') {
                        // What apify-client's response interceptor throws for a cut-off JSON body.
                        throw new InvalidResponseBodyError(
                            { headers: { 'content-type': 'application/json' } } as unknown as AxiosResponse,
                            new SyntaxError('Unterminated string in JSON at position 65536'),
                        );
                    }
                    if ('status' in answer) {
                        return {
                            status: answer.status,
                            data: { error: {} },
                            headers: {},
                            config: { method: 'get', url },
                        };
                    }
                    return {
                        status: 200,
                        data: answer.items,
                        headers: { 'x-apify-pagination-total': String(answer.total) },
                    };
                },
            },
        },
        ...methods,
    });
}

/** Minimal `InternalToolArgs` stub for unit tests. Defaults to every helper tool loaded, no Actor tools. */
export function stubToolCallContext(
    args: Record<string, unknown>,
    client: InternalToolArgs['apifyClient'],
    {
        loadedToolNames = Object.values(HELPER_TOOLS),
        loadedActorIds = [],
    }: { loadedToolNames?: readonly string[]; loadedActorIds?: readonly string[] } = {},
): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: client,
        signal: new AbortController().signal,
        actorStore: undefined,
        loadedToolNames,
        loadedActorIds: new Set(loadedActorIds),
    };
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

/**
 * Assert a tool result's `structuredContent` conforms to its declared `outputSchema` under a
 * non-coercing AJV (`new Ajv({ strict: false })` compiled directly on the schema) — the same check
 * the MCP SDK client runs on tool results: a result that declares a schema but returns absent or
 * non-conforming `structuredContent` is rejected. The repo's `compileSchema` coerces types and would
 * hide a mismatch, so compile strictly here. Surfaces AJV errors in the failure message.
 */
export function expectSchemaConformingStructuredContent(result: unknown, schema: object): void {
    const { structuredContent, isError } = result as { structuredContent?: unknown; isError?: boolean };
    expect(isError).not.toBe(true);
    expect(structuredContent).toBeDefined();
    const validate = new Ajv({ strict: false }).compile(schema);
    const valid = validate(structuredContent);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
}
