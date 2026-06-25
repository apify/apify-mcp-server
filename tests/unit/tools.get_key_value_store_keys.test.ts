import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getKeyValueStoreKeys } from '../../src/tools/storage/get_key_value_store_keys.js';
import { keyValueStoreKeysOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    decodeFencedToolText,
    expectSoftFailInvalidInput,
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
    return {
        keyValueStore: (_id: string) => ({
            listKeys: listKeysSpy,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubApifyClientThrowing(err: unknown): InternalToolArgs['apifyClient'] {
    return stubApifyClient(vi.fn().mockRejectedValue(err));
}

describe('get-key-value-store-keys', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreKeys.name).toBe(HelperTools.KEY_VALUE_STORE_KEYS_GET);
    });

    it('returns the keys response plus a summary and read nextStep in structuredContent', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', ...MOCK_KEYS });
        expect(structuredContent.summary).toBe('Listed 2 keys.');
        // nextStep points at reading the first listed key.
        expect(structuredContent.nextStep).toBe(
            `Use ${HelperTools.KEY_VALUE_STORE_RECORD_GET} with keyValueStoreId=kv-1 and recordKey=INPUT to read a value.`,
        );
        // content[0] ships the TOON-fenced data; content[1] carries the prose summary + nextStep.
        const { summary, nextStep, ...data } = structuredContent;
        expect(decodeFencedToolText(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('emits structuredContent that validates against the outputSchema when not truncated', async () => {
        // The SDK returns `nextExclusiveStartKey: null` when `isTruncated` is false — the common
        // single-page case. The output schema must accept that, or the MCP SDK rejects the response.
        // Validated with a strict AJV (no coercion) to mirror the SDK's output-schema check; the
        // repo's lenient `compileSchema` coerces types and would hide the mismatch.
        const listKeysSpy = vi.fn().mockResolvedValue({ ...MOCK_KEYS, nextExclusiveStartKey: null });
        const validate = new Ajv({ strict: false }).compile(keyValueStoreKeysOutputSchema);

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(validate(structuredContent)).toBe(true);
    });

    it('flags truncation in the summary and points to the next page when more keys are available', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue({
            ...MOCK_KEYS,
            isTruncated: true,
            nextExclusiveStartKey: 'OUTPUT',
        });

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 2 keys (more available).');
        expect(structuredContent.nextStep).toBe(
            `Call ${HelperTools.KEY_VALUE_STORE_KEYS_GET} again with exclusiveStartKey=OUTPUT to fetch the next page.`,
        );
    });

    it('points at inspecting the store when it has no keys', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue({ ...MOCK_KEYS, items: [], count: 0 });

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 0 keys.');
        expect(structuredContent.nextStep).toContain(HelperTools.KEY_VALUE_STORE_GET);
    });

    it('forwards exclusiveStartKey and limit to listKeys', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', exclusiveStartKey: 'data.json', limit: 5 },
                stubApifyClient(listKeysSpy),
            ),
        );

        expect(listKeysSpy).toHaveBeenCalledWith({ exclusiveStartKey: 'data.json', limit: 5 });
    });

    it('forwards undefined limit when caller omits it', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );

        expect(listKeysSpy).toHaveBeenCalledWith({ exclusiveStartKey: undefined, limit: undefined });
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getKeyValueStoreKeys as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', limit: 10 })).toBe(true);
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
                stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClientThrowing(serverError)),
            ),
        ).rejects.toBe(serverError);
    });

    it('passes the wrapper-stripped keyValueStoreId to client.keyValueStore()', async () => {
        const kvStoreSpy = vi.fn().mockReturnValue({ listKeys: async () => MOCK_KEYS });
        const client = { keyValueStore: kvStoreSpy } as unknown as InternalToolArgs['apifyClient'];

        await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: '`user~my-store`' }, client),
        );

        expect(kvStoreSpy).toHaveBeenCalledWith('user~my-store');
    });

    it('appends the store Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getKeyValueStoreKeys as HelperTool).call({
            ...stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(vi.fn().mockResolvedValue(MOCK_KEYS))),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        // content: [0] fenced data, [1] summary/nextStep, [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/key-value-stores/kv-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});
