import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { ApifyClient } from '../../src/apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { getKeyValueStoreRecord } from '../../src/tools/storage/get_key_value_store_record.js';
import { keyValueStoreRecordOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

// Only Console UI token sessions reach the users/me lookup.
vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const MOCK_RECORD = { key: 'INPUT', value: { query: 'hello' }, contentType: 'application/json' };
const MOCK_STORE = { id: 'KvsWkzbQMuFYuam3Y', name: 'my-store' };

type RequestConfig = { url: string; method: string; params?: unknown; maxContentLength?: number };

/** A record over the size limit: the Content-Type the API sent before axios stopped the download. */
type OverLimitRecord = { contentType?: string };

/** The abort axios raises once a body crosses `maxContentLength`; its request keeps the response headers. */
function overLimitAbort({ contentType }: OverLimitRecord): AxiosError {
    return new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE', undefined, {
        res: { headers: contentType ? { 'content-type': contentType } : {} },
    });
}

/**
 * Stubs the record request as apify-client's axios instance answers it: `record.value` is the body its
 * interceptors already parsed by Content-Type, a missing record is a resolved 404, `overLimit` the abort.
 */
function stubApifyClient(opts: {
    record?: { key: string; value: unknown; contentType?: string };
    overLimit?: OverLimitRecord;
    store?: unknown;
    onGetRecordPublicUrl?: () => void;
    onRequest?: (config: RequestConfig) => void;
    /** Egress base URL of the SDK client (ends with `/v2`); `url` is built on it, as apify-client does. */
    baseUrl?: string;
}): InternalToolArgs['apifyClient'] {
    const { record, overLimit, store, onGetRecordPublicUrl, onRequest, baseUrl = 'https://api.apify.com/v2' } = opts;
    return mockApifyClient({
        keyValueStore: (id: string) => ({
            url: `${baseUrl}/key-value-stores/${id}`,
            get: async () => store,
            getRecordPublicUrl: async (key: string) => {
                onGetRecordPublicUrl?.();
                return `https://api.apify.com/v2/key-value-stores/${id}/records/${key}?signature=signed`;
            },
        }),
        httpClient: {
            axios: {
                request: async (config: RequestConfig) => {
                    onRequest?.(config);
                    if (overLimit) throw overLimitAbort(overLimit);
                    if (!record) return { data: { error: { type: 'record-not-found' } }, headers: {}, status: 404 };
                    return {
                        data: record.value,
                        headers: record.contentType ? { 'content-type': record.contentType } : {},
                        status: 200,
                    };
                },
            },
        },
    });
}

describe('get-key-value-store-record', () => {
    it('has the expected tool name', () => {
        expect(getKeyValueStoreRecord.name).toBe(HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET);
    });

    it('returns a JSON record plus a terminal summary (no nextStep) in structuredContent', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
        );
        const { content, isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent).toMatchObject({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', ...MOCK_RECORD });
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
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'note.txt' },
                stubApifyClient({ record }),
            ),
        );
        const { isError, structuredContent } = result as TextToolResult & {
            structuredContent: Record<string, unknown>;
        };

        expect(isError).not.toBe(true);
        expect(structuredContent).toMatchObject({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', ...record });
        // 'hello world\nsecond line' is 23 ASCII bytes.
        expect(structuredContent.summary).toBe("Read 'note.txt' (contentType=text/plain; charset=utf-8, 23 bytes).");
    });

    it('returns an empty value in schema-conforming structuredContent for an empty record', async () => {
        // apify-client maps an empty record body to `undefined` (e.g. an Actor that writes an empty OUTPUT);
        // the value must still be present so the output schema's required `value` is satisfied.
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'OUTPUT' },
                stubApifyClient({ record: { key: 'OUTPUT', value: undefined, contentType: 'application/json' } }),
            ),
        );
        expectSchemaConformingStructuredContent(result, keyValueStoreRecordOutputSchema);
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };
        expect(structuredContent).toMatchObject({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', key: 'OUTPUT', value: '' });
    });

    it('returns an image content block for a binary image record', async () => {
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'screenshot.png' },
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
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'screenshot.png' },
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
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'clip.mp3' },
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
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'report.pdf' },
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
                uri: 'https://api.apify.com/v2/key-value-stores/KvsWkzbQMuFYuam3Y/records/report.pdf',
                blob: bytes.toString('base64'),
                mimeType: 'application/pdf',
            },
        });
    });

    it('builds the embedded-resource URI on the client-facing origin when requests go to another host', async () => {
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]);
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'report.pdf' },
                stubApifyClient({
                    record: { key: 'report.pdf', value: bytes, contentType: 'application/pdf' },
                    baseUrl: 'http://api.internal.example:3333/v2',
                }),
            ),
        );
        const { content } = result as CallToolResult;

        expect((content[0] as { resource: { uri: string } }).resource.uri).toBe(
            'https://api.apify.com/v2/key-value-stores/KvsWkzbQMuFYuam3Y/records/report.pdf',
        );
    });

    it('returns a resource_link instead of inlining a binary record over the size limit', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'big.png' },
                stubApifyClient({ overLimit: { contentType: 'image/png' } }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'resource_link',
            uri: 'https://api.apify.com/v2/key-value-stores/KvsWkzbQMuFYuam3Y/records/big.png?signature=signed',
            name: 'big.png',
            mimeType: 'image/png',
        });
    });

    it('returns a resource_link without mimeType when the record has no Content-Type', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'blob' },
                stubApifyClient({ overLimit: {} }),
            ),
        );
        const { content, isError } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toEqual({
            type: 'resource_link',
            uri: 'https://api.apify.com/v2/key-value-stores/KvsWkzbQMuFYuam3Y/records/blob?signature=signed',
            name: 'blob',
        });
    });

    it('returns a resource_link, not the value, for a text record over the size limit', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'page.md' },
                stubApifyClient({ overLimit: { contentType: 'text/markdown; charset=utf-8' } }),
            ),
        );
        const { content, isError, structuredContent } = result as CallToolResult;

        expect(isError).not.toBe(true);
        expect(content[0]).toMatchObject({ type: 'resource_link', mimeType: 'text/markdown' });
        expect(structuredContent?.value).toBe(`<text/markdown, over ${MAX_INLINE_BYTES} bytes>`);
        expect(structuredContent?.summary).toContain(`over the ${MAX_INLINE_BYTES}-byte limit`);
    });

    // The cap is what keeps a record of any size out of the server's memory.
    it('requests the record with the response body capped at the inline limit', async () => {
        const onRequest = vi.fn();
        await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD, onRequest }),
            ),
        );

        expect(onRequest).toHaveBeenCalledWith({
            url: 'https://api.apify.com/v2/key-value-stores/KvsWkzbQMuFYuam3Y/records/INPUT',
            method: 'GET',
            params: { attachment: 'true' },
            maxContentLength: MAX_INLINE_BYTES,
        });
    });

    it('throws an API failure other than a missing record', async () => {
        const client = mockApifyClient({
            keyValueStore: (id: string) => ({ url: `https://api.apify.com/v2/key-value-stores/${id}` }),
            httpClient: {
                axios: {
                    request: async () => ({
                        data: { error: { type: 'insufficient-permissions', message: 'Insufficient permissions' } },
                        headers: {},
                        status: 403,
                        config: { method: 'get', url: 'https://api.apify.com/v2/key-value-stores/x/records/INPUT' },
                    }),
                },
            },
        });

        await expect(
            (getKeyValueStoreRecord as HelperTool).call(
                stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' }, client),
            ),
        ).rejects.toMatchObject({ statusCode: 403, message: 'Insufficient permissions' });
    });

    // The request config carries the token in its Authorization header.
    it('throws a failed request without its request config', async () => {
        const client = mockApifyClient({
            keyValueStore: (id: string) => ({ url: `https://api.apify.com/v2/key-value-stores/${id}` }),
            httpClient: {
                axios: {
                    request: async () => {
                        throw new AxiosError('socket hang up', 'ECONNRESET', {
                            headers: new AxiosHeaders({ Authorization: 'Bearer test-token' }),
                        });
                    },
                },
            },
        });

        const call = (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' }, client),
        );

        await expect(call).rejects.toMatchObject({ message: 'socket hang up' });
        await expect(call).rejects.not.toHaveProperty('config');
    });

    it('returns isError "record not found" when the record is missing but the store exists', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'MISSING' },
                stubApifyClient({ record: undefined, store: MOCK_STORE }),
            ),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Record 'MISSING' not found in key-value store 'KvsWkzbQMuFYuam3Y'");
    });

    it('returns isError "store not found" when both the record and the store are missing', async () => {
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
        expect(tool.ajvValidate({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' })).toBe(true);
    });

    it('rejects empty recordKey via ajv validation', () => {
        const tool = getKeyValueStoreRecord as HelperTool;
        expect(tool.ajvValidate({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: '' })).toBe(false);
        expect(tool.ajvValidate({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' })).toBe(true);
    });

    // Binary records return content blocks; the tool still declares an outputSchema, so each branch
    // must emit a schema-conforming structuredContent or official SDK clients reject the fetch.
    describe('binary records emit schema-conforming structuredContent', () => {
        const cases = [
            { recordKey: 'screenshot.png', value: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' },
            { recordKey: 'clip.mp3', value: Buffer.from([0x49, 0x44, 0x33]), contentType: 'audio/mpeg' },
            { recordKey: 'report.pdf', value: Buffer.from([0x25, 0x50, 0x44, 0x46]), contentType: 'application/pdf' },
        ];

        for (const { recordKey, value, contentType } of cases) {
            it(`${contentType} (${value.length} bytes)`, async () => {
                const result = await (getKeyValueStoreRecord as HelperTool).call(
                    stubToolCallContext(
                        { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey },
                        stubApifyClient({ record: { key: recordKey, value, contentType } }),
                    ),
                );
                expectSchemaConformingStructuredContent(result, keyValueStoreRecordOutputSchema);
                const { structuredContent } = result as { structuredContent: Record<string, unknown> };
                expect(structuredContent).toMatchObject({
                    keyValueStoreId: 'KvsWkzbQMuFYuam3Y',
                    key: recordKey,
                    contentType,
                });
            });
        }

        it('a record over the size limit', async () => {
            const result = await (getKeyValueStoreRecord as HelperTool).call(
                stubToolCallContext(
                    { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'big.png' },
                    stubApifyClient({ overLimit: { contentType: 'image/png' } }),
                ),
            );
            expectSchemaConformingStructuredContent(result, keyValueStoreRecordOutputSchema);
            const { structuredContent } = result as { structuredContent: Record<string, unknown> };
            expect(structuredContent).toMatchObject({
                keyValueStoreId: 'KvsWkzbQMuFYuam3Y',
                key: 'big.png',
                contentType: 'image/png',
            });
        });
    });

    // OFFICIAL SDK client — the "pedantic client".
    // On listTools() it compiles a validator from the tool's outputSchema; on callTool() it throws
    // McpError if the result carries no structuredContent (or it fails the schema).

    describe('official SDK client round-trip (pedantic output-schema validation)', () => {
        const tool = getKeyValueStoreRecord as HelperTool;

        async function connectClientForRecord(stub: Parameters<typeof stubApifyClient>[0]): Promise<Client> {
            const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: { tools: {} } });
            server.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: [{ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }],
            }));
            server.setRequestHandler(CallToolRequestSchema, async (req) => {
                const result = (await tool.call(
                    stubToolCallContext(req.params.arguments ?? {}, stubApifyClient(stub)),
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
                record: {
                    key: 'screenshot.png',
                    value: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
                    contentType: 'image/png',
                },
            });
            const result = await client.callTool({
                name: tool.name,
                arguments: { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'screenshot.png' },
            });

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
                keyValueStoreId: 'KvsWkzbQMuFYuam3Y',
                key: 'screenshot.png',
            });
            expect((result.content as { type: string }[])[0].type).toBe('image');
            await client.close();
        });

        it('accepts an over-limit binary fetch returned as a resource_link', async () => {
            const client = await connectClientForRecord({ overLimit: { contentType: 'image/png' } });
            const result = await client.callTool({
                name: tool.name,
                arguments: { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'big.png' },
            });

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ keyValueStoreId: 'KvsWkzbQMuFYuam3Y', key: 'big.png' });
            expect((result.content as { type: string }[])[0].type).toBe('resource_link');
            await client.close();
        });
    });

    it('requests the wrapper-stripped keyValueStoreId and recordKey', async () => {
        const onRequest = vi.fn();

        await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: '`user~my-store`', recordKey: '`INPUT`' },
                stubApifyClient({ record: MOCK_RECORD, store: MOCK_STORE, onRequest }),
            ),
        );

        expect(onRequest).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://api.apify.com/v2/key-value-stores/user~my-store/records/INPUT' }),
        );
    });

    it('appends the store Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getKeyValueStoreRecord as HelperTool).call({
            ...stubToolCallContext(
                { keyValueStoreId: 'KvsWkzbQMuFYuam3Y', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD }),
            ),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        // content: [0] data, [1] summary (record reads are terminal — no nextStep), [2] Apify Console link.
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(
            `Apify Console: https://console.apify.com/storage/key-value-stores/KvsWkzbQMuFYuam3Y\n${VERBATIM_LINKS_NUDGE}`,
        );
    });
});

describe('get-key-value-store-record with a bare store name', () => {
    const STORE_BY_NAME = { id: 'WkzbQMuFYuamGv3YF', name: 'eval-ai-store' };

    it("reads the name as one of the caller's own stores", async () => {
        const onRequest = vi.fn();

        await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'eval-ai-store', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD, store: STORE_BY_NAME, onRequest }),
            ),
        );

        expect(onRequest).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://api.apify.com/v2/key-value-stores/~eval-ai-store/records/INPUT' }),
        );
    });

    it('reports a missing record, not a missing store, when the named store exists', async () => {
        const client = mockApifyClient({
            keyValueStore: (id: string) => ({
                url: `https://api.apify.com/v2/key-value-stores/${id}`,
                get: async () => (id === '~eval-ai-store' ? STORE_BY_NAME : undefined),
            }),
            httpClient: { axios: { request: async () => ({ data: undefined, headers: {}, status: 404 }) } },
        });

        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext({ keyValueStoreId: 'eval-ai-store', recordKey: 'MISSING' }, client),
        );
        const { content } = result as TextToolResult;

        expectSoftFailInvalidInput(result);
        expect(content[0].text).toContain("Record 'MISSING' not found in key-value store 'eval-ai-store'");
    });

    it('links Console to the store ID', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = await (getKeyValueStoreRecord as HelperTool).call({
            ...stubToolCallContext(
                { keyValueStoreId: 'eval-ai-store', recordKey: 'INPUT' },
                stubApifyClient({ record: MOCK_RECORD, store: STORE_BY_NAME }),
            ),
            apifyToken: 'apify_ui_test',
        });
        const { content } = result as TextToolResult;

        expect(content[2].text).toContain('https://console.apify.com/storage/key-value-stores/WkzbQMuFYuamGv3YF');
    });

    // A public link is opened without a token, so `~name` (the token holder's store) cannot resolve in it.
    it('signs the public link of an over-limit record on the store ID', async () => {
        const result = await (getKeyValueStoreRecord as HelperTool).call(
            stubToolCallContext(
                { keyValueStoreId: 'eval-ai-store', recordKey: 'big.png' },
                stubApifyClient({ overLimit: { contentType: 'image/png' }, store: STORE_BY_NAME }),
            ),
        );
        const { content } = result as CallToolResult;

        expect((content[0] as { uri: string }).uri).toBe(
            'https://api.apify.com/v2/key-value-stores/WkzbQMuFYuamGv3YF/records/big.png?signature=signed',
        );
    });
});

// The real client against a local server: the stubs above cannot show that the download stops.
describe('get-key-value-store-record with a record far over the size limit', () => {
    const RECORD_BYTES = 64 * 1024 * 1024;

    it('stops the download near the limit and returns a link', async () => {
        let sentBytes = 0;
        const server = createServer((req, res) => {
            if (!req.url?.includes('/records/')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ data: MOCK_STORE }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/zip', 'content-length': RECORD_BYTES });
            const chunk = Buffer.alloc(64 * 1024);
            const write = () => {
                while (sentBytes < RECORD_BYTES && !res.destroyed) {
                    sentBytes += chunk.length;
                    if (!res.write(chunk)) {
                        res.once('drain', write);
                        return;
                    }
                }
                if (!res.destroyed) res.end();
            };
            write();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        try {
            const result = await (getKeyValueStoreRecord as HelperTool).call(
                stubToolCallContext(
                    { keyValueStoreId: MOCK_STORE.id, recordKey: 'export.zip' },
                    new ApifyClient({ token: 'test-token', baseUrl, maxRetries: 0 }),
                ),
            );
            const { content } = result as CallToolResult;

            expect(content[0]).toMatchObject({
                type: 'resource_link',
                name: 'export.zip',
                mimeType: 'application/zip',
            });
            // Socket buffers hold some bytes past the limit; a full read would send all of them.
            expect(sentBytes).toBeLessThan(RECORD_BYTES / 4);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
