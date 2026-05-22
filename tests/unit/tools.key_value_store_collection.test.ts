// key_value_store_collection.ts constructs its own ApifyClient from apifyToken, so we mock the module.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { HelperTools } from '../../src/const.js';
import { getUserKeyValueStoresList } from '../../src/tools/common/key_value_store_collection.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import type { TextToolResult } from '../helpers.js';

const listSpy = vi.fn();

vi.mock('../../src/apify_client.js', () => ({
    ApifyClient: vi.fn().mockImplementation(() => ({
        keyValueStores: () => ({ list: listSpy }),
    })),
}));

const MOCK_LIST = {
    total: 2,
    offset: 0,
    limit: 10,
    desc: false,
    count: 2,
    items: [{ id: 'kv-1', name: 'a' }, { id: 'kv-2', name: 'b' }],
};

function stubArgs(args: Record<string, unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: {} as InternalToolArgs['apifyClient'],
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-key-value-store-list', () => {
    beforeEach(() => {
        listSpy.mockReset();
        vi.mocked(ApifyClient).mockClear();
    });

    it('has the expected tool name', () => {
        expect(getUserKeyValueStoresList.name).toBe(HelperTools.KEY_VALUE_STORE_LIST_GET);
    });

    it('returns the list response as JSON in a fenced code block', async () => {
        listSpy.mockResolvedValue(MOCK_LIST);

        const result = await (getUserKeyValueStoresList as HelperTool).call(stubArgs({}));
        const { content } = result as TextToolResult;

        const json = content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '');
        expect(JSON.parse(json)).toEqual(MOCK_LIST);
    });

    it('forwards pagination params (limit, offset, desc, unnamed) to ApifyClient', async () => {
        listSpy.mockResolvedValue(MOCK_LIST);

        await (getUserKeyValueStoresList as HelperTool).call(stubArgs({
            limit: 5,
            offset: 10,
            desc: true,
            unnamed: true,
        }));

        expect(listSpy).toHaveBeenCalledWith({ limit: 5, offset: 10, desc: true, unnamed: true });
    });

    it('applies defaults (limit=10, offset=0, desc=false, unnamed=false) when no params given', async () => {
        listSpy.mockResolvedValue(MOCK_LIST);

        await (getUserKeyValueStoresList as HelperTool).call(stubArgs({}));

        expect(listSpy).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, unnamed: false });
    });

    it('constructs ApifyClient with the user-provided token', async () => {
        listSpy.mockResolvedValue(MOCK_LIST);

        await (getUserKeyValueStoresList as HelperTool).call(stubArgs({}));

        expect(ApifyClient).toHaveBeenCalledWith({ token: 'test-token' });
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getUserKeyValueStoresList as HelperTool;
        expect(tool.ajvValidate({ limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ limit: 10 })).toBe(true);
    });
});
