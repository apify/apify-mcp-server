import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { getKeyValueStoreRecord } from '../../src/tools/storage/get_key_value_store_record.js';
import { keyValueStoreRecordOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const MOCK_RECORD = { key: 'INPUT', value: { query: 'hello' }, contentType: 'application/json' };
const MOCK_STORE = { id: 'kv-1', name: 'my-store' };

function stubApifyClient(opts: {
    record: unknown;
    store?: unknown;
    onGetRecordPublicUrl?: () => void;
}): InternalToolArgs['apifyClient'] {
    const { record, store, onGetRecordPublicUrl } = opts;
    return {
        keyValueStore: (id: string) => ({
            url: `https://api.apify.com/v2/key-value-stores/${id}`,
            getRecord: async (_key: string) => record,
            get: async () => store,
            getRecordPublicUrl: async (key: string) => {
                onGetRecordPublicUrl?.();
                return `https://api.apify.com/v2/key-value-stores/${id}/records/${key}?signature=signed`;
            },
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

describe('get-key-value-store-record', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreRecord.name).toBe(HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET);
    });

    it('returns a JSON record plus a terminal summary (no nextStep) in structuredContent', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
        );
        const { content, isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', ...MOCK_RECORD });
        // {"query":"hello"} serializes to 17 bytes.
        expect(structuredContent.summary).toBe("Read 'INPUT' (contentType=application/json, 17 bytes).");
        // Reading a record is terminal — no nextStep, and content[1] is the summary alone.
        expect(structuredContent).not.toHaveProperty('nextStep');
        expect(content).toHaveLength(2);
        expect(content[1].text).toBe(structuredContent.summary);
        // content[0] is the data-only JSON dump (no narrative summary).
        const { summary, ...data } = structuredContent;
        expect(JSON.parse(content[0].text)).toEqual(data);
    });

    it('returns a text record value in structuredContent', async () => {
        const record = { key: 'note.txt', value: 'hello world\nsecond line', contentType: 'text/plain; charset=utf-8' };
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'kv-1', recordKey: 'note.txt' }, stubApifyClient({ record })),
        );
        const { isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', ...record });
        // 'hello world\nsecond line' is 23 ASCII bytes.
        expect(structuredContent.summary).toBe("Read 'note.txt' (contentType=text/plain; charset=utf-8, 23 bytes).");
    });

    it('returns an empty value in schema-conforming structuredContent for an empty record', async () => {
        // apify-client maps an empty record body to `undefined` (e.g. an Actor that writes an empty OUTPUT);
        // the value must still be present so the output schema's required `value` is satisfied.
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'OUTPUT' },
                stubApifyClient({ record: { key: 'OUTPUT', value: undefined, contentType: 'application/json' } }),
            ),
        );
        expectSchemaConformingStructuredContent(result, keyValueStoreRecordOutputSchema);
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };
        expect(structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', key: 'OUTPUT', value: '' });
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

    it('matches the image branch for a mixed-case Content-Type and lowercases the mimeType', async () => {
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'screenshot.png' },
                stubApifyClient({ record: { key: 'screenshot.png', value: bytes, contentType: 'Image/PNG' } }),
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

    it('returns an embedded resource block with a synthetic URI for other binary records', async () => {
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF magic bytes
        // The blob is inlined, so the uri is decorative — building it must not trigger the
        // store-metadata fetch that getRecordPublicUrl performs to sign the URL.
        const onGetRecordPublicUrl = vi.fn();
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'report.pdf' },
                stubApifyClient({
                    record: { key: 'report.pdf', value: bytes, contentType: 'application/pdf' },
                    onGetRecordPublicUrl,
                }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(onGetRecordPublicUrl).not.toHaveBeenCalled();
        expect(content[0]).toEqual({
            type: 'resource',
            resource: {
                uri: 'https://api.apify.com/v2/key-value-stores/kv-1/records/report.pdf',
                blob: bytes.toString('base64'),
                mimeType: 'application/pdf',
            },
        });
    });

    it('returns a resource_link instead of inlining a binary record over the size limit', async () => {
        const bytes = Buffer.alloc(MAX_INLINE_BYTES + 1);
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'big.png' },
                stubApifyClient({ record: { key: 'big.png', value: bytes, contentType: 'image/png' } }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'resource_link',
            uri: 'https://api.apify.com/v2/key-value-stores/kv-1/records/big.png?signature=signed',
            name: 'big.png',
            size: MAX_INLINE_BYTES + 1,
            mimeType: 'image/png',
        });
    });

    it('returns a resource_link without mimeType when the record has no Content-Type', async () => {
        const bytes = Buffer.alloc(MAX_INLINE_BYTES + 1);
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'blob' },
                stubApifyClient({ record: { key: 'blob', value: bytes, contentType: undefined } }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'resource_link',
            uri: 'https://api.apify.com/v2/key-value-stores/kv-1/records/blob?signature=signed',
            name: 'blob',
            size: MAX_INLINE_BYTES + 1,
        });
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

    // Binary records return content blocks; the tool still declares an outputSchema, so each branch
    // must emit a schema-conforming structuredContent or official SDK clients reject the fetch.
    describe('binary records emit schema-conforming structuredContent', () => {
        const cases = [
            { recordKey: 'screenshot.png', value: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' },
            { recordKey: 'clip.mp3', value: Buffer.from([0x49, 0x44, 0x33]), contentType: 'audio/mpeg' },
            { recordKey: 'report.pdf', value: Buffer.from([0x25, 0x50, 0x44, 0x46]), contentType: 'application/pdf' },
            {
                recordKey: 'big.png',
                value: Buffer.alloc(MAX_INLINE_BYTES + 1),
                contentType: 'image/png',
            },
        ];

        for (const { recordKey, value, contentType } of cases) {
            it(`${contentType} (${value.length} bytes)`, async () => {
                const result = await (getKeyValueStoreRecord as HelperTool).call(
                    stubToolCallContext(
                        { keyValueStoreId: 'kv-1', recordKey },
                        stubApifyClient({ record: { key: recordKey, value, contentType } }),
                    ),
                );
                expectSchemaConformingStructuredContent(result, keyValueStoreRecordOutputSchema);
                const { structuredContent } = result as { structuredContent: Record<string, unknown> };
                expect(structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', key: recordKey, contentType });
            });
        }
    });

    // OFFICIAL SDK client — the "pedantic client".
    // On listTools() it compiles a validator from the tool's outputSchema; on callTool() it throws
    // McpError if the result carries no structuredContent (or it fails the schema).

    describe('official SDK client round-trip (pedantic output-schema validation)', () => {
        const tool = getKeyValueStoreRecord as HelperTool;

        async function connectClientForRecord(record: unknown): Promise<Client> {
            const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: { tools: {} } });
            server.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: [{ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }],
            }));
            server.setRequestHandler(CallToolRequestSchema, async (req) => {
                const result = (await tool.call(
                    stubToolCallContext(req.params.arguments ?? {}, stubApifyClient({ record })),
                )) as CallToolResult;
                // Mirror the real server, which strips internal telemetry before sending the result.
                return {
                    content: result.content,
                    structuredContent: result.structuredContent,
                    isError: result.isError,
                };
            });

            const client = new Client({ name: 'pedantic-client', version: '0.0.0' });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
            // listTools() caches the output-schema validator; callTool() only enforces it once cached.
            await client.listTools();
            return client;
        }

        it('accepts a binary image fetch that pre-fix threw "did not return structured content"', async () => {
            const client = await connectClientForRecord({
                key: 'screenshot.png',
                value: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
                contentType: 'image/png',
            });
            const result = await client.callTool({
                name: tool.name,
                arguments: { keyValueStoreId: 'kv-1', recordKey: 'screenshot.png' },
            });

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', key: 'screenshot.png' });
            expect((result.content as { type: string }[])[0].type).toBe('image');
            await client.close();
        });

        it('accepts an over-limit binary fetch returned as a resource_link', async () => {
            const client = await connectClientForRecord({
                key: 'big.png',
                value: Buffer.alloc(MAX_INLINE_BYTES + 1),
                contentType: 'image/png',
            });
            const result = await client.callTool({
                name: tool.name,
                arguments: { keyValueStoreId: 'kv-1', recordKey: 'big.png' },
            });

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ keyValueStoreId: 'kv-1', key: 'big.png' });
            expect((result.content as { type: string }[])[0].type).toBe('resource_link');
            await client.close();
        });
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
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getKeyValueStoreRecord as HelperTool).call({
            ...stubToolCallContext(
                { keyValueStoreId: 'kv-1', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        // content: [0] data, [1] summary (record reads are terminal — no nextStep), [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/key-value-stores/kv-1\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});
