import { describe, expect, it } from 'vitest';

import { getKeyValueStoreRecord } from '../../src/tools/common/get_key_value_store_record.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext, type TextToolResult } from '../helpers.js';

const MOCK_RECORD = { key: 'INPUT', value: { query: 'hello' }, contentType: 'application/json' };
const MOCK_STORE = { id: 'kv-1', name: 'my-store' };

function stubApifyClient(opts: {
    record: unknown;
    store?: unknown;
}): InternalToolArgs['apifyClient'] {
    const { record, store } = opts;
    return {
        keyValueStore: (_id: string) => ({
            getRecord: async (_key: string) => record,
            get: async () => store,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-key-value-store-record', () => {
    it('returns the record as JSON in a fenced code block', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        const json = content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '');
        expect(JSON.parse(json)).toEqual(MOCK_RECORD);
    });

    it('returns isError "record not found" when getRecord is undefined but the store exists', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'MISSING' },
                stubApifyClient({ record: undefined, store: MOCK_STORE }),
            ),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Record 'MISSING' not found in key-value store 'kv-1'");
    });

    it('returns isError "store not found" when both getRecord and store get are undefined', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'missing-kv', recordKey: 'INPUT' },
                stubApifyClient({ record: undefined, store: undefined }),
            ),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Key-value store 'missing-kv' not found");
    });
});
