import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getKeyValueStoreRecord } from '../../src/tools/common/get_key_value_store_record.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSoftFailInvalidInput,
    parseFencedJson,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const MOCK_RECORD = { key: 'INPUT', value: { query: 'hello' }, contentType: 'application/json' };
const MOCK_STORE = { id: 'kv-1', name: 'my-store' };

function stubApifyClient(opts: { record: unknown; store?: unknown }): InternalToolArgs['apifyClient'] {
    const { record, store } = opts;
    return {
        keyValueStore: (_id: string) => ({
            getRecord: async (_key: string) => record,
            get: async () => store,
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-key-value-store-record', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreRecord.name).toBe(HelperTools.KEY_VALUE_STORE_RECORD_GET);
    });

    it('returns the record as JSON in a fenced code block', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        expect(parseFencedJson(content[0].text)).toEqual(MOCK_RECORD);
    });

    it('returns isError "record not found" when getRecord is undefined but the store exists', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'MISSING' },
                stubApifyClient({ record: undefined, store: MOCK_STORE }),
            ),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Record 'MISSING' not found in key-value store 'kv-1'");
    });

    it('returns isError "store not found" when both getRecord and store get are undefined', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'missing-kv', recordKey: 'INPUT' },
                stubApifyClient({ record: undefined, store: undefined }),
            ),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Key-value store 'missing-kv' not found");
    });

    it('rejects empty keyValueStoreId via ajv validation', () => {
        const tool = getKeyValueStoreRecord as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: '', recordKey: 'INPUT' })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', recordKey: 'INPUT' })).toBe(true);
    });

    it('rejects empty recordKey via ajv validation', () => {
        const tool = getKeyValueStoreRecord as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', recordKey: '' })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1', recordKey: 'INPUT' })).toBe(true);
    });

    it('passes wrapper-stripped keyValueStoreId and recordKey to the SDK', async () => {
        const getRecordSpy = vi.fn().mockResolvedValue(MOCK_RECORD);
        const kvStoreSpy = vi.fn().mockReturnValue({ getRecord: getRecordSpy, get: async () => MOCK_STORE });
        const client = { keyValueStore: kvStoreSpy } as unknown as InternalToolArgs['apifyClient'];

        await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: '`user~my-store`', recordKey: '`INPUT`' }, client),
        );

        expect(kvStoreSpy).toHaveBeenCalledWith('user~my-store');
        expect(getRecordSpy).toHaveBeenCalledWith('INPUT');
    });

    it('appends the store Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue({
            userId: 'USER_ID',
            userPlanTier: 'FREE',
            isOrganization: false,
        });

        const result = await (getKeyValueStoreRecord as HelperTool).call({
            ...stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        expect(content).toHaveLength(2);
        expect(content[1].text).toBe(
            `Apify Console: https://console.apify.com/storage/key-value-stores/kv-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});
