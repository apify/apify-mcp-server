import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getKeyValueStore } from '../../src/tools/storage/get_key_value_store.js';
import { keyValueStoreOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSoftFailInvalidInput,
    expectSchemaConformingStructuredContent,
    mockUserInfo,
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
        expect(getKeyValueStore.name).toBe(HELPER_TOOLS.KEY_VALUE_STORE_GET);
    });

    it('returns store metadata plus a summary and nextStep in structuredContent', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient(MOCK_STORE)),
        );
        const { content, isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent).toMatchObject(MOCK_STORE);
        expect(structuredContent.summary).toBe("Key-value store 'my-store'.");
        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET);
        expect(structuredContent.nextStep).toContain('keyValueStoreId=kv-1');
        // content[0] is the data-only JSON dump (no narrative); content[1] is the narrative.
        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('includes the byte count in the summary when stats are present', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1' },
                stubApifyClient({ ...MOCK_STORE, stats: { storageBytes: 2048 } }),
            ),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe("Key-value store 'my-store' holds 2048 bytes.");
    });

    it('emits structuredContent that validates against the outputSchema for an unnamed store', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1' }, stubApifyClient({ ...MOCK_STORE, name: null })),
        );
        expectSchemaConformingStructuredContent(result, keyValueStoreOutputSchema);
    });

    it('returns isError with a not-found message when the store does not exist', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'missing' }, stubApifyClient(undefined)),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(structuredContent).toBeUndefined();
        expect(content[0].text).toContain("Key-value store 'missing' not found");
    });

    it('rejects empty keyValueStoreId via ajv validation', () => {
        const tool = getKeyValueStore as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: '' })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1' })).toBe(true);
    });

    it('appends the store Console link (from the API-returned id) for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getKeyValueStore as HelperTool).call({
            ...stubToolCallContext({ keyValueStoreId: 'user~my-store' }, stubApifyClient(MOCK_STORE)),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        // content: [0] data, [1] summary/nextStep, [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/key-value-stores/kv-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});
