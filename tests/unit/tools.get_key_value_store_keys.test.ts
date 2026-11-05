import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getKeyValueStoreKeys } from '../../src/tools/storage/get_key_value_store_keys.js';
import { keyValueStoreKeysOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const MOCK_KEYS = {
    items: [
        { key: 'INPUT', size: 42 },
        { key: 'OUTPUT', size: 128 },
    ],
    nextExclusiveStartKey: '',
    isTruncated: false,
    count: 2,
    limit: 2,
};

function stubApifyClient(listKeysSpy: ReturnType<typeof vi.fn>): InternalToolArgs['apifyClient'] {
    return mockApifyClient({
        keyValueStore: (_id: string) => ({
            listKeys: listKeysSpy,
        }),
    });
}

function stubApifyClientThrowing(err: unknown): InternalToolArgs['apifyClient'] {
    return stubApifyClient(vi.fn().mockRejectedValue(err));
}

describe('get-key-value-store-keys', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreKeys.name).toBe(HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET);
    });

    it('returns the keys response plus a summary and read nextStep in structuredContent', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y' }, stubApifyClient(listKeysSpy)),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent).toMatchObject({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', ...MOCK_KEYS });
        expect(structuredContent.summary).toBe('Listed 2 keys.');
        // nextStep points at reading the first listed key.
        expect(structuredContent.nextStep).toBe(
            `Use ${HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=KvsWkzbQMuFYuam3Y and recordKey=INPUT to read a value.`,
        );
        // content[0] ships the JSON data; content[1] carries the prose summary + nextStep.
        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('emits structuredContent that validates against the outputSchema when not truncated', async () => {
        // The SDK returns `nextExclusiveStartKey: null` when `isTruncated` is false — the common
        // single-page case. The output schema must accept that, or the MCP SDK rejects the response.
        // Validated with a strict AJV (no coercion) to mirror the SDK's output-schema check; the
        // repo's lenient `compileSchema` coerces types and would hide the mismatch.
        const listKeysSpy = vi.fn().mockResolvedValue({ ...MOCK_KEYS, nextExclusiveStartKey: null });

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y' }, stubApifyClient(listKeysSpy)),
        );
        expectSchemaConformingStructuredContent(result, keyValueStoreKeysOutputSchema);
    });

    it('flags truncation in the summary and points to the next page when more keys are available', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue({
            ...MOCK_KEYS,
            isTruncated: true,
            nextExclusiveStartKey: 'OUTPUT',
        });

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y' }, stubApifyClient(listKeysSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 2 keys (more available).');
        expect(structuredContent.nextStep).toBe(
            `Call ${HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET} again with exclusiveStartKey=OUTPUT to fetch the next page.`,
        );
    });

    it('points at inspecting the store when it has no keys', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue({ ...MOCK_KEYS, items: [], count: 0 });

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y' }, stubApifyClient(listKeysSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 0 keys.');
        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.KEY_VALUE_STORE_GET);
    });

    it('forwards exclusiveStartKey and limit to listKeys', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', exclusiveStartKey: 'data.json', limit: 5 },
                stubApifyClient(listKeysSpy),
            ),
        );

        expect(listKeysSpy).toHaveBeenCalledWith({ exclusiveStartKey: 'data.json', limit: 5 });
    });

    it('forwards undefined limit when caller omits it', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y' }, stubApifyClient(listKeysSpy)),
        );

        expect(listKeysSpy).toHaveBeenCalledWith({ exclusiveStartKey: undefined, limit: undefined });
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getKeyValueStoreKeys as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', limit: 10 })).toBe(true);
    });

    it('returns isError with a not-found message when listKeys throws 404', async () => {
        const notFound = Object.assign(new Error('Key-value store was not found'), { statusCode: 404 });
        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'missing' }, stubApifyClientThrowing(notFound)),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Key-value store 'missing' not found");
    });

    it('rethrows non-404 errors from listKeys', async () => {
        const serverError = Object.assign(new Error('Internal server error'), { statusCode: 500 });
        await expect(
            (getKeyValueStoreKeys as HelperTool).call(
                stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y' }, stubApifyClientThrowing(serverError)),
            ),
        ).rejects.toBe(serverError);
    });

    it('passes the wrapper-stripped keyValueStoreId to client.keyValueStore()', async () => {
        const kvStoreSpy = vi.fn().mockReturnValue({ listKeys: async () => MOCK_KEYS });
        const client = mockApifyClient({ keyValueStore: kvStoreSpy });

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: '`user~my-store`' }, client),
        );

        expect(kvStoreSpy).toHaveBeenCalledWith('user~my-store');
    });

    it('appends the store Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getKeyValueStoreKeys as HelperTool).call({
            ...stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y' },
                stubApifyClient(vi.fn().mockResolvedValue(MOCK_KEYS)),
            ),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        // content: [0] plain JSON, [1] summary/nextStep, [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/key-value-stores/KvsWkzbQMuFYuam3Y\n${VERBATIM_LINKS_NUDGE}`,
        );
    });

    // Regression: #1296 — nextStep named a sibling tool the session was not served.
    describe('in a session served only get-key-value-store-keys', () => {
        const narrowContext = (response: unknown) =>
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y' },
                stubApifyClient(vi.fn().mockResolvedValue(response)),
                {
                    loadedToolNames: [HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET],
                },
            );

        it.each([
            { name: 'a nonempty listing', response: MOCK_KEYS, sibling: HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET },
            {
                name: 'an empty listing',
                response: { ...MOCK_KEYS, items: [], count: 0 },
                sibling: HELPER_TOOLS.KEY_VALUE_STORE_GET,
            },
        ])('falls back on $name without naming $sibling', async ({ response, sibling }) => {
            const result = (await (getKeyValueStoreKeys as HelperTool).call(
                narrowContext(response),
            )) as TextToolResult & {
                structuredContent: Record<string, unknown>;
            };

            expect(result.structuredContent.nextStep).toBe('No follow-up step.');
            expect(JSON.stringify([result.content, result.structuredContent])).not.toContain(sibling);
            expectSchemaConformingStructuredContent(result, keyValueStoreKeysOutputSchema);
        });

        it('keeps the next-page hint on a truncated listing', async () => {
            const result = (await (getKeyValueStoreKeys as HelperTool).call(
                narrowContext({ ...MOCK_KEYS, isTruncated: true, nextExclusiveStartKey: 'OUTPUT' }),
            )) as TextToolResult & { structuredContent: Record<string, unknown> };

            expect(result.structuredContent.nextStep).toBe(
                `Call ${HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET} again with exclusiveStartKey=OUTPUT to fetch the next page.`,
            );
        });
    });
});

describe('get-key-value-store-keys with a bare store name', () => {
    it("reads the name as one of the caller's own stores", async () => {
        const kvStoreSpy = vi.fn().mockReturnValue({ listKeys: async () => MOCK_KEYS });

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'eval-ai-store' }, mockApifyClient({ keyValueStore: kvStoreSpy })),
        );

        expect(kvStoreSpy).toHaveBeenCalledWith('~eval-ai-store');
    });

    it('links Console to the store ID, which the list response does not carry', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        const client = mockApifyClient({
            keyValueStore: (_id: string) => ({
                listKeys: async () => MOCK_KEYS,
                get: async () => ({ id: 'WkzbQMuFYuamGv3YF', name: 'eval-ai-store' }),
            }),
        });

        const result = await (getKeyValueStoreKeys as HelperTool).call({
            ...stubToolCallContext({ keyValueStoreId: 'eval-ai-store' }, client),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        expect(content[2].text).toContain('https://console.apify.com/storage/key-value-stores/WkzbQMuFYuamGv3YF');
    });
});
