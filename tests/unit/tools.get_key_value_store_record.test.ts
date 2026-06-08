import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { getApifyAPIBaseUrl } from '../../src/apify_client.js';
import { HelperTools } from '../../src/const.js';
import { getKeyValueStoreRecord } from '../../src/tools/common/get_key_value_store_record.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSoftFailInvalidInput,
    parseFencedJson,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

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

    it('returns a JSON array record as JSON in a fenced code block', async () => {
        const record = { key: 'results.json', value: [{ id: 1 }, { id: 2 }], contentType: 'application/json' };
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1', recordKey: 'results.json' }, stubApifyClient({ record })),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        expect(content[0].type).toBe('text');
        expect(parseFencedJson(content[0].text)).toEqual(record);
    });

    it('returns an image content block for a binary image record', async () => {
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'screenshot.png' },
                stubApifyClient({ record: { key: 'screenshot.png', value: bytes, contentType: 'image/png' } }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'image',
            data: bytes.toString('base64'),
            mimeType: 'image/png',
        });
    });

    it('returns an audio content block for a binary audio record', async () => {
        const bytes = Buffer.from([0x49, 0x44, 0x33]); // ID3 (MP3) magic bytes
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'clip.mp3' },
                stubApifyClient({ record: { key: 'clip.mp3', value: bytes, contentType: 'audio/mpeg' } }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'audio',
            data: bytes.toString('base64'),
            mimeType: 'audio/mpeg',
        });
    });

    it('returns an embedded resource block for other binary records', async () => {
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF magic bytes
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'report.pdf' },
                stubApifyClient({ record: { key: 'report.pdf', value: bytes, contentType: 'application/pdf' } }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'resource',
            resource: {
                uri: `${getApifyAPIBaseUrl()}/v2/key-value-stores/kv-1/records/report.pdf`,
                blob: bytes.toString('base64'),
                mimeType: 'application/pdf',
            },
        });
    });

    it('returns a plain text content block for a text record', async () => {
        const text = 'hello world\nsecond line';
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'note.txt' },
                stubApifyClient({ record: { key: 'note.txt', value: text, contentType: 'text/plain; charset=utf-8' } }),
            ),
        );
        const { content, isError } = result as TextToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({ type: 'text', text });
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
});
