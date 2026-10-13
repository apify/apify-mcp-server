import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getKeyValueStoreList } from '../../src/tools/storage/get_key_value_store_list.js';
import { storageListOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    mockApifyClient,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const MOCK_LIST = {
    total: 2,
    offset: 0,
    limit: 10,
    desc: false,
    count: 2,
    items: [
        { id: 'kv-1', name: 'a' },
        { id: 'kv-2', name: 'b' },
    ],
};

function stubApifyClient(listSpy: ReturnType<typeof vi.fn>): InternalToolArgs['apifyClient'] {
    return mockApifyClient({
        keyValueStores: () => ({ list: listSpy }),
    });
}

describe('get-key-value-store-list', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreList.name).toBe(HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET);
    });

    it('returns the list response plus a summary and nextStep in structuredContent', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        const result = await (getKeyValueStoreList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(structuredContent).toMatchObject(MOCK_LIST);
        expect(structuredContent.summary).toBe('Listed 2 of 2 key-value stores.');
        expect(structuredContent.nextStep).toContain(HELPER_TOOLS.KEY_VALUE_STORE_GET);
        // content[0] ships the JSON data; content[1] carries the prose summary + nextStep.
        const { summary, nextStep, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
        expect(content[1].text).toBe(`${summary}\n${nextStep}`);
    });

    it('emits a pagination nextStep when more stores remain', async () => {
        const listSpy = vi.fn().mockResolvedValue({ ...MOCK_LIST, total: 30 });

        const result = await (getKeyValueStoreList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent.summary).toBe('Listed 2 of 30 key-value stores.');
        expect(structuredContent.nextStep).toBe(
            `Call ${HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET} again with offset=2 to fetch the next page.`,
        );
    });

    it('forwards pagination params (limit, offset, desc, unnamed) to ApifyClient', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getKeyValueStoreList as HelperTool).call(
            stubToolCallContext(
                {
                    limit: 5,
                    offset: 10,
                    desc: true,
                    unnamed: true,
                },
                stubApifyClient(listSpy),
            ),
        );

        expect(listSpy).toHaveBeenCalledWith({ limit: 5, offset: 10, desc: true, unnamed: true });
    });

    it('applies defaults (limit=10, offset=0, desc=false, unnamed=false) when no params given', async () => {
        const listSpy = vi.fn().mockResolvedValue(MOCK_LIST);

        await (getKeyValueStoreList as HelperTool).call(stubToolCallContext({}, stubApifyClient(listSpy)));

        expect(listSpy).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, unnamed: false });
    });

    it('emits structuredContent that validates against the outputSchema for the last/empty page', async () => {
        const listSpy = vi.fn().mockResolvedValue({ ...MOCK_LIST, total: 0, count: 0, items: [] });

        const result = await (getKeyValueStoreList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(listSpy)),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('count', 0);
        expectSchemaConformingStructuredContent(result, storageListOutputSchema);
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getKeyValueStoreList as HelperTool;
        expect(tool.ajvValidate({ limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ limit: 10 })).toBe(true);
    });
});

// Regression: #1296 — the terminal nextStep named a sibling tool the session was not served.
describe('get-key-value-store-list nextStep gating', () => {
    async function callWith(list: Record<string, unknown>, loadedToolNames: string[]) {
        return (await (getKeyValueStoreList as HelperTool).call(
            stubToolCallContext({}, stubApifyClient(vi.fn().mockResolvedValue(list)), { loadedToolNames }),
        )) as TextToolResult & { structuredContent: Record<string, unknown> };
    }

    it('falls back on the last page when get-key-value-store is not loaded', async () => {
        const result = await callWith(MOCK_LIST, [HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET]);

        expect(result.structuredContent.nextStep).toBe('Inspect the returned result directly.');
        expect(JSON.stringify([result.content, result.structuredContent])).not.toContain(
            HELPER_TOOLS.KEY_VALUE_STORE_GET,
        );
        expectSchemaConformingStructuredContent(result, storageListOutputSchema);
    });

    it('keeps the inspect hint on the last page when the sibling is loaded', async () => {
        const result = await callWith(MOCK_LIST, [
            HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
            HELPER_TOOLS.KEY_VALUE_STORE_GET,
        ]);

        expect(result.structuredContent.nextStep).toBe(
            `Use ${HELPER_TOOLS.KEY_VALUE_STORE_GET} with a keyValueStoreId from the list to inspect a store.`,
        );
    });

    it('keeps the pagination hint whether or not the sibling is loaded', async () => {
        const page = { ...MOCK_LIST, total: 5 };
        const narrow = await callWith(page, [HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET]);
        const wide = await callWith(page, [HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET, HELPER_TOOLS.KEY_VALUE_STORE_GET]);

        expect(narrow.structuredContent.nextStep).toBe(
            `Call ${HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET} again with offset=2 to fetch the next page.`,
        );
        expect(wide.structuredContent.nextStep).toBe(narrow.structuredContent.nextStep);
    });
});
