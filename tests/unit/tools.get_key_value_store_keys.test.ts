import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getKeyValueStoreKeys } from '../../src/tools/common/get_key_value_store_keys.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { parseFencedJson, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

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

describe('get-key-value-store-keys', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreKeys.name).toBe(HelperTools.KEY_VALUE_STORE_KEYS_GET);
    });

    it('returns the keys response as JSON in a fenced code block', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );
        const { content } = result as TextToolResult;

        expect(parseFencedJson(content[0].text)).toEqual(MOCK_KEYS);
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
});
