// Per-file stubs match the repo convention; see tools.get_dataset_items.test.ts.
import { describe, expect, it, vi } from 'vitest';

import { getKeyValueStoreKeys } from '../../src/tools/common/get_key_value_store_keys.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

const MOCK_KEYS = {
    items: [{ key: 'INPUT', size: 42 }, { key: 'OUTPUT', size: 128 }],
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

function stubArgs(args: Record<string, unknown>, client: InternalToolArgs['apifyClient']): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: client,
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-key-value-store-keys', () => {
    it('returns the keys response as JSON in a fenced code block', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        const result = await (getKeyValueStoreKeys as HelperTool).call(
            stubArgs({ keyValueStoreId: 'kv-1' }, stubApifyClient(listKeysSpy)),
        );
        const { content } = result as { content: { text: string }[] };

        expect(content[0].text).toMatch(/^```json\n/);
        const json = content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '');
        expect(JSON.parse(json)).toEqual(MOCK_KEYS);
    });

    it('forwards exclusiveStartKey and limit to listKeys', async () => {
        const listKeysSpy = vi.fn().mockResolvedValue(MOCK_KEYS);

        await (getKeyValueStoreKeys as HelperTool).call(
            stubArgs(
                { keyValueStoreId: 'kv-1', exclusiveStartKey: 'data.json', limit: 5 },
                stubApifyClient(listKeysSpy),
            ),
        );

        expect(listKeysSpy).toHaveBeenCalledWith({ exclusiveStartKey: 'data.json', limit: 5 });
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getKeyValueStoreKeys as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', limit: 10 })).toBe(true);
    });
});
