import { describe, expect, it, vi } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { getKeyValueStore } from '../../src/tools/common/get_key_value_store.js';
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

const MOCK_STORE = {
    id: 'kv-1',
    name: 'my-store',
    accessedAt: '2026-05-20T10:00:00.000Z',
};

function stubApifyClient(store: unknown): InternalToolArgs['apifyClient'] {
    return {
        keyValueStore: (_id: string) => ({ get: async () => store }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-key-value-store', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStore.name).toBe(HelperTools.KEY_VALUE_STORE_GET);
    });

    it('returns store metadata as JSON in a fenced code block', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(MOCK_STORE)),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        expect(parseFencedJson(content[0].text)).toEqual(MOCK_STORE);
    });

    it('returns isError with a not-found message when the store does not exist', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'missing' }, stubApifyClient(undefined)),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Key-value store 'missing' not found");
    });

    it('rejects empty keyValueStoreId via ajv validation', () => {
        const tool = getKeyValueStore as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: '' })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1' })).toBe(true);
    });

    it('appends the store Console link (from the API-returned id) for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue({
            userId: 'USER_ID',
            userPlanTier: 'FREE',
            isOrganization: false,
        });

        const result = await (getKeyValueStore as HelperTool).call({
            ...stubToolCallContext({ keyValueStoreId: 'user~my-store' }, stubApifyClient(MOCK_STORE)),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        expect(content).toHaveLength(2);
        expect(content[1].text).toBe(
            `Console: https://console.apify.com/storage/key-value-stores/kv-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});
