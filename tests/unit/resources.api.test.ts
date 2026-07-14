import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { MAX_DOWNLOAD_BYTES, MAX_INLINE_BYTES } from '../../src/const.js';
import { isApifyApiUri, readApiResource } from '../../src/resources/api_resources.js';

const API = 'https://api.apify.com';

// `contents[0]` is a text|blob union; narrow it in tests that read one shape.
function firstContent(result: ReadResourceResult): { mimeType?: string; text?: string; blob?: string } {
    return result.contents[0] as { mimeType?: string; text?: string; blob?: string };
}

/** Await a read that must reject, asserting it threw an McpError and returning it for further checks. */
async function expectReadError(promise: Promise<unknown>): Promise<McpError> {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    return error as McpError;
}

type RequestConfig = { url: string; maxContentLength?: number };
type RequestResult = { data: unknown; headers: Record<string, unknown>; status: number; statusText: string };

type StubOptions = {
    request?: (config: RequestConfig) => Promise<RequestResult>;
    /** Throw from getRecordPublicUrl to exercise the download-link fallback. */
    recordPublicUrlThrows?: boolean;
};

/** Signed public URL the stubbed getRecordPublicUrl returns for a (storeId, key) pair. */
function signedUrl(storeId: string, key: string): string {
    return `${API}/v2/key-value-stores/${storeId}/records/${key}?signature=sig`;
}

function stubApifyClient(opts: StubOptions = {}): ApifyClient {
    return {
        keyValueStore: (storeId: string) => ({
            getRecordPublicUrl: async (key: string) => {
                if (opts.recordPublicUrlThrows) throw new Error('boom');
                return signedUrl(storeId, key);
            },
        }),
        httpClient: {
            axios: {
                request:
                    opts.request ?? (async () => ({ data: undefined, headers: {}, status: 200, statusText: 'OK' })),
            },
        },
    } as unknown as ApifyClient;
}

/** Build a request stub returning a fixed 200 response, capturing the requested config. */
function requestReturning(data: unknown, contentType?: string) {
    const captured: RequestConfig = { url: '' };
    const request = async (config: RequestConfig): Promise<RequestResult> => {
        Object.assign(captured, config);
        return { data, headers: contentType ? { 'content-type': contentType } : {}, status: 200, statusText: 'OK' };
    };
    return { request, captured };
}

describe('isApifyApiUri()', () => {
    it('returns true for Apify API URLs', () => {
        expect(isApifyApiUri(`${API}/v2/datasets/ds-1/items`)).toBe(true);
        expect(isApifyApiUri(`${API}/v2/key-value-stores/kv-1/records/INPUT`)).toBe(true);
    });

    it('returns false for other hosts and schemes', () => {
        expect(isApifyApiUri('https://example.com/v2/datasets/ds-1/items')).toBe(false);
        expect(isApifyApiUri('apify://datasets/ds-1/items')).toBe(false);
        expect(isApifyApiUri('file://readme.md')).toBe(false);
        expect(isApifyApiUri('ui://widget/search.html')).toBe(false);
        expect(isApifyApiUri('not a url')).toBe(false);
    });
});

describe('readApiResource()', () => {
    it('throws InvalidParams when there is no token', async () => {
        const error = await expectReadError(readApiResource(`${API}/v2/datasets/ds-1/items`, undefined));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain('no Apify token');
    });

    it('throws InvalidParams for a non-Apify URL (no token leak to other hosts)', async () => {
        const error = await expectReadError(readApiResource('https://example.com/steal-my-token', stubApifyClient()));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain('only Apify API URLs');
    });

    it('passes the full URL through to httpClient.axios.request', async () => {
        const { request, captured } = requestReturning([{ a: 1 }], 'application/json');
        const uri = `${API}/v2/datasets/ds-1/items?limit=5`;

        await readApiResource(uri, stubApifyClient({ request }));

        expect(captured.url).toBe(uri);
    });

    it('caps the download at MAX_DOWNLOAD_BYTES via axios maxContentLength', async () => {
        // Enforced mid-flight by axios itself, not after buffering the full body — see const.ts.
        const { request, captured } = requestReturning(undefined);

        await readApiResource(`${API}/v2/datasets/ds-1/items`, stubApifyClient({ request }));

        expect(captured.maxContentLength).toBe(MAX_DOWNLOAD_BYTES);
    });

    it('serializes a parsed JSON body as text with its content-type', async () => {
        const { request } = requestReturning({ query: 'hi' }, 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/INPUT`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(JSON.parse(firstContent(result).text as string)).toEqual({ query: 'hi' });
    });

    it('serializes a dataset items array as JSON', async () => {
        const { request } = requestReturning([{ a: 1 }, { a: 2 }], 'application/json');

        const result = await readApiResource(`${API}/v2/datasets/ds-1/items`, stubApifyClient({ request }));

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(JSON.parse(firstContent(result).text as string)).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('round-trips a JSON null body instead of dropping it as empty text', async () => {
        // apify-client parses a literal JSON `null` body to JS null; it must serialize back to "null",
        // not collapse to empty text (which would look like an absent record).
        const { request } = requestReturning(null, 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/OUTPUT`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(firstContent(result).text).toBe('null');
    });

    it('re-serializes a bare JSON string body so the quotes survive', async () => {
        // A bare JSON string body parses to a JS string; emitting it verbatim would yield invalid JSON
        // (`hello`, not `"hello"`). Re-serialize when the declared Content-Type is JSON.
        const { request } = requestReturning('hello', 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/GREETING`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(firstContent(result).text).toBe('"hello"');
        expect(JSON.parse(firstContent(result).text as string)).toBe('hello');
    });

    it('returns a text body verbatim with its content-type', async () => {
        const { request } = requestReturning('hello world', 'text/plain; charset=utf-8');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/NOTE`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('text/plain; charset=utf-8');
        expect(firstContent(result).text).toBe('hello world');
    });

    it('returns binary values as a base64 blob with mimeType', async () => {
        const { request } = requestReturning(Buffer.from('binary-data'), 'image/png');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/IMG`,
            stubApifyClient({ request }),
        );

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('image/png');
        expect(contents.blob).toBe(Buffer.from('binary-data').toString('base64'));
        expect(contents).not.toHaveProperty('text');
    });

    it('links to the signed record URL instead of inlining a binary above the size limit', async () => {
        // Inlining a multi-MB blob as base64 would blow up the client's context; link out instead.
        // The link is the store's signed recordPublicUrl, so a client can fetch it without a token.
        const oversized = Buffer.alloc(MAX_INLINE_BYTES + 1);
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG`;
        const { request } = requestReturning(oversized, 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('text/plain');
        expect(contents).not.toHaveProperty('blob');
        expect(contents.text).toContain('too large to inline');
        expect(contents.text).toContain(signedUrl('kv-1', 'BIG'));
        expect(contents.text).toContain(String(MAX_INLINE_BYTES + 1));
        expect(contents.text).toContain('application/octet-stream');
    });

    it('still mints a signed link for a record key with malformed percent-encoding', async () => {
        // A stray `%` in the key path used to throw in decodeURIComponent and drop the link to the
        // token-gated API URL; safeDecodeURIComponent keeps the raw segment so the signed link survives.
        const oversized = Buffer.alloc(MAX_INLINE_BYTES + 1);
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG%`;
        const { request } = requestReturning(oversized, 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        expect(firstContent(result).text).toContain(signedUrl('kv-1', 'BIG%'));
    });

    it('falls back to the API URL when minting the signed link fails', async () => {
        const oversized = Buffer.alloc(MAX_INLINE_BYTES + 1);
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG`;
        const { request } = requestReturning(oversized, 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ request, recordPublicUrlThrows: true }));

        expect(firstContent(result).text).toContain(uri);
    });

    it('links an oversized JSON dataset body to a download URL with a paging hint', async () => {
        // A large dataset read with no limit parses to a JS array; serializing and inlining it would
        // blow up the caller's context, exactly like an oversized binary. Link out instead: a non-record
        // endpoint has no signed URL, so the link is the same (token-gated) API URL, with a paging hint.
        const huge = [{ v: 'x'.repeat(MAX_INLINE_BYTES) }];
        const uri = `${API}/v2/datasets/ds-1/items`;
        const { request } = requestReturning(huge, 'application/json');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('text/plain');
        expect(contents.text).toContain('too large to inline');
        expect(contents.text).toContain(uri);
        expect(contents.text).toContain('limit');
        expect(contents.text).toContain('offset');
        // The body itself is not inlined.
        expect(contents.text).not.toContain('xxxxxxxxxx');
    });

    it('links an oversized text KVS record to its signed download URL', async () => {
        // A KVS record has no limit/offset paging, so an oversized text/JSON record must link out like a
        // binary. Prefer the store's signed recordPublicUrl so the user can fetch it without a token.
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG_TEXT`;
        const { request } = requestReturning('x'.repeat(MAX_INLINE_BYTES + 1), 'text/plain; charset=utf-8');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('text/plain');
        expect(contents.text).toContain('too large to inline');
        expect(contents.text).toContain(signedUrl('kv-1', 'BIG_TEXT'));
        expect(contents.text).toContain(String(MAX_INLINE_BYTES + 1));
    });

    it('falls back to the API URL when an oversized text record link cannot be signed', async () => {
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG_TEXT`;
        const { request } = requestReturning('x'.repeat(MAX_INLINE_BYTES + 1), 'text/plain; charset=utf-8');

        const result = await readApiResource(uri, stubApifyClient({ request, recordPublicUrlThrows: true }));

        expect(firstContent(result).text).toContain(uri);
    });

    it('returns empty text for an empty body', async () => {
        // The client maps an empty record body to `undefined` (e.g. an Actor that writes an empty OUTPUT).
        const { request } = requestReturning(undefined, 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/OUTPUT`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).text).toBe('');
        expect(firstContent(result)).not.toHaveProperty('blob');
        // Empty body still preserves the record's declared Content-Type rather than defaulting to text/plain.
        expect(firstContent(result).mimeType).toBe('application/json');
    });

    it('throws when the request fails, mapping the error status to a code', async () => {
        const client = stubApifyClient({
            request: async () => {
                throw Object.assign(new Error('not found'), { statusCode: 404 });
            },
        });

        const error = await expectReadError(readApiResource(`${API}/v2/datasets/missing/items`, client));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain('Failed to read');
        expect(error.message).toContain('404');
    });

    it('links to the signed record URL when axios aborts a KVS record download over the limit', async () => {
        // A single attempt, no apify-client retries: apify-client would otherwise misclassify this abort
        // as a retryable network error and retry it 8 times.
        const abort = new AxiosError(`maxContentLength size of ${MAX_DOWNLOAD_BYTES} exceeded`, 'ERR_BAD_RESPONSE');
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG`;
        const client = stubApifyClient({
            request: async () => {
                throw abort;
            },
        });

        const result = await readApiResource(uri, client);

        const contents = firstContent(result);
        expect(contents.text).toContain('download limit');
        expect(contents.text).toContain(String(MAX_DOWNLOAD_BYTES));
        expect(contents.text).toContain(signedUrl('kv-1', 'BIG'));
        expect(contents.text).toContain('limit');
        expect(contents.text).toContain('offset');
    });

    it('links to the plain API URL when axios aborts a dataset-items download over the limit', async () => {
        const abort = new AxiosError(`maxContentLength size of ${MAX_DOWNLOAD_BYTES} exceeded`, 'ERR_BAD_RESPONSE');
        const uri = `${API}/v2/datasets/ds-1/items`;
        const client = stubApifyClient({
            request: async () => {
                throw abort;
            },
        });

        const result = await readApiResource(uri, client);

        const contents = firstContent(result);
        expect(contents.text).toContain('download limit');
        expect(contents.text).toContain(uri);
        expect(contents.text).toContain('limit');
        expect(contents.text).toContain('offset');
    });

    it('throws InvalidParams with the parsed error message for a resolved non-2xx 4xx response', async () => {
        const uri = `${API}/v2/datasets/missing/items`;
        const client = stubApifyClient({
            request: async () => ({
                data: { error: { message: 'Dataset was not found', type: 'record-not-found' } },
                headers: {},
                status: 404,
                statusText: 'Not Found',
            }),
        });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain(`Failed to read ${uri}: HTTP 404: Dataset was not found`);
    });

    it('throws InternalError falling back to statusText for a resolved 5xx with no parsable error body', async () => {
        const uri = `${API}/v2/datasets/missing/items`;
        const client = stubApifyClient({
            request: async () => ({ data: undefined, headers: {}, status: 500, statusText: 'Internal Server Error' }),
        });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InternalError);
        expect(error.message).toContain(`Failed to read ${uri}: HTTP 500: Internal Server Error`);
    });
});
