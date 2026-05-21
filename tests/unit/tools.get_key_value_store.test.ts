import { describe, expect, it } from 'vitest';

import { getKeyValueStore } from '../../src/tools/common/get_key_value_store.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

const MOCK_STORE = {
    id: 'kv-1',
    name: 'my-store',
    accessedAt: '2026-05-20T10:00:00.000Z',
};

function stubApifyClient(store: unknown): InternalToolArgs['apifyClient'] {
    return {
        keyValueStore: (_id: string) => ({
            get: async () => store,
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

describe('get-key-value-store', () => {
    it('returns store metadata as JSON in a fenced code block', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubArgs({ keyValueStoreId: 'kv-1' }, stubApifyClient(MOCK_STORE)),
        );
        const { content } = result as { content: { text: string }[] };

        expect(content[0].text).toMatch(/^```json\n/);
        const json = content[0].text.replace(/^```json\n/, '').replace(/\n```$/, '');
        expect(JSON.parse(json)).toEqual(MOCK_STORE);
    });

    it('returns isError with a not-found message when the store does not exist', async () => {
        const result = await (getKeyValueStore as HelperTool).call(
            stubArgs({ keyValueStoreId: 'missing' }, stubApifyClient(undefined)),
        );
        const { content, isError } = result as { content: { text: string }[]; isError?: boolean };

        expect(isError).toBe(true);
        expect(content[0].text).toContain("Key-value store 'missing' not found");
    });

    it('rejects empty keyValueStoreId via ajv validation', () => {
        const tool = getKeyValueStore as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: '' })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'kv-1' })).toBe(true);
    });
});
