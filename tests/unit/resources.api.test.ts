import { Readable } from 'node:stream';

import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { MAX_INLINE_BYTES } from '../../src/const.js';
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

/** Body stream the stubbed request returns; chunked to prove multi-chunk reassembly. */
function streamOf(...chunks: (string | Buffer)[]): Readable {
    return Readable.from(chunks.map((c) => Buffer.from(c)));
}

/**
 * Models the axios stream `maxContentLength` enforcement (axios ≥1.16 wraps streamed responses in a
 * byte-counting generator): yields a prefix, then throws the same abort axios raises over the limit.
 */
function abortingStream(prefix: string | Buffer = 'partial'): Readable {
    return Readable.from(
        (async function* generate() {
            yield Buffer.from(prefix);
            throw new AxiosError(`maxContentLength size of ${MAX_INLINE_BYTES} exceeded`, 'ERR_BAD_RESPONSE');
        })(),
    );
}

type RequestConfig = { url: string; responseType?: string; maxContentLength?: number };
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
                    opts.request ?? (async () => ({ data: streamOf(), headers: {}, status: 200, statusText: 'OK' })),
            },
        },
    } as unknown as ApifyClient;
}

/** Build a request stub returning a fixed 200 response body, capturing the requested config. */
function requestReturning(data: Readable, contentType?: string) {
    const captured: RequestConfig = { url: '' };
    const request = async (config: RequestConfig): Promise<RequestResult> => {
        Object.assign(captured, config);
        return { data, headers: contentType ? { 'content-type': contentType } : {}, status: 200, statusText: 'OK' };
    };
    return { request, captured };
}

/** Request stub resolving a non-2xx response (`validateStatus: null` semantics) with a body stream. */
function requestFailing(status: number, statusText: string, body?: object) {
    return async (): Promise<RequestResult> => ({
        data: body ? streamOf(JSON.stringify(body)) : streamOf(),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        status,
        statusText,
    });
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

    it('rejects userinfo-bearing URLs even on the API host', () => {
        // axios drops the default Authorization header for credentials-bearing URLs, so such a
        // read would silently run unauthenticated; refuse it at the gate instead.
        expect(isApifyApiUri('https://evil.com@api.apify.com/v2/datasets/ds-1/items')).toBe(false);
        expect(isApifyApiUri('https://user:pass@api.apify.com/v2/datasets/ds-1/items')).toBe(false);
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
        // Spec error shape: the failing URI rides in error.data, not only in the message text.
        expect(error.data).toEqual({ uri: 'https://example.com/steal-my-token' });
    });

    it('requests the full URL as a stream capped at MAX_INLINE_BYTES', async () => {
        // The size cap is enforced by axios itself mid-consumption (streamed responses are wrapped in a
        // byte-counting generator since axios 1.16), so the contract under test is the request config.
        const { request, captured } = requestReturning(streamOf('[]'), 'application/json');
        const uri = `${API}/v2/datasets/ds-1/items?limit=5`;

        await readApiResource(uri, stubApifyClient({ request }));

        expect(captured.url).toBe(uri);
        expect(captured.responseType).toBe('stream');
        expect(captured.maxContentLength).toBe(MAX_INLINE_BYTES);
    });

    it('returns a JSON body verbatim, reassembling chunks, with its full content-type', async () => {
        const { request } = requestReturning(streamOf('{"query"', ':"hi"}'), 'application/json; charset=utf-8');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/INPUT`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('application/json; charset=utf-8');
        expect(firstContent(result).text).toBe('{"query":"hi"}');
    });

    it('returns a JSON null body as the literal "null", not empty text', async () => {
        // The body is never parsed, so a literal JSON `null` passes through byte-exact instead of
        // collapsing to empty text (which would look like an absent record).
        const { request } = requestReturning(streamOf('null'), 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/OUTPUT`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(firstContent(result).text).toBe('null');
    });

    it('returns a bare JSON string body with its quotes intact', async () => {
        const { request } = requestReturning(streamOf('"hello"'), 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/GREETING`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).text).toBe('"hello"');
        expect(JSON.parse(firstContent(result).text as string)).toBe('hello');
    });

    it('returns a text body verbatim with its content-type', async () => {
        const { request } = requestReturning(streamOf('hello world'), 'text/plain; charset=utf-8');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/NOTE`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('text/plain; charset=utf-8');
        expect(firstContent(result).text).toBe('hello world');
    });

    it('decodes a text body with its declared non-UTF-8 charset', async () => {
        // latin1 bytes are not valid UTF-8; a hardcoded UTF-8 decode would mangle them to U+FFFD.
        const body = Buffer.from('Café à côté', 'latin1');
        const { request } = requestReturning(streamOf(body), 'text/plain; charset=latin1');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/NOTE`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).text).toBe('Café à côté');
        expect(firstContent(result).mimeType).toBe('text/plain; charset=latin1');
    });

    it('returns a lossless blob instead of text for a charset Node cannot decode', async () => {
        // `iso-8859-1` is not a Buffer encoding label. Decoding with the wrong charset would corrupt
        // the bytes irreversibly, so the body ships as base64 — same rule as apify-client's body_parser.
        const body = Buffer.from('Café à côté', 'latin1');
        const { request } = requestReturning(streamOf(body), 'text/plain; charset=iso-8859-1');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/NOTE`,
            stubApifyClient({ request }),
        );

        const contents = firstContent(result);
        expect(contents.blob).toBe(body.toString('base64'));
        expect(contents).not.toHaveProperty('text');
        expect(contents.mimeType).toBe('text/plain');
    });

    it('returns an XML body as text', async () => {
        const { request } = requestReturning(streamOf('<a>1</a>'), 'application/xml');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/FEED`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).mimeType).toBe('application/xml');
        expect(firstContent(result).text).toBe('<a>1</a>');
    });

    it('returns binary values as a base64 blob with the base mimeType', async () => {
        // Content-Type parameters are stripped for blobs — only the base type is meaningful.
        const { request } = requestReturning(streamOf(Buffer.from('binary-data')), 'Image/PNG; name=a.png');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/IMG`,
            stubApifyClient({ request }),
        );

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('image/png');
        expect(contents.blob).toBe(Buffer.from('binary-data').toString('base64'));
        expect(contents).not.toHaveProperty('text');
    });

    it('returns a body with no content-type as a blob without a mimeType', async () => {
        // No declared Content-Type → base64 blob, the lossless choice (the real API always declares one).
        const { request } = requestReturning(streamOf('mystery'));

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/RAW`,
            stubApifyClient({ request }),
        );

        const contents = firstContent(result);
        expect(contents.blob).toBe(Buffer.from('mystery').toString('base64'));
        expect(contents).not.toHaveProperty('mimeType');
    });

    it('returns empty text preserving the content-type for an empty body', async () => {
        // e.g. an Actor that writes an empty OUTPUT record.
        const { request } = requestReturning(streamOf(), 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/OUTPUT`,
            stubApifyClient({ request }),
        );

        expect(firstContent(result).text).toBe('');
        expect(firstContent(result)).not.toHaveProperty('blob');
        expect(firstContent(result).mimeType).toBe('application/json');
    });

    it('links to the signed record URL when a KVS record body crosses the inline limit', async () => {
        // Inlining a multi-MB body would blow up the client's context; link out instead. The link is
        // the store's signed recordPublicUrl, so a client can fetch it without a token.
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG`;
        const { request } = requestReturning(abortingStream(), 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('text/plain');
        expect(contents).not.toHaveProperty('blob');
        expect(contents.text).toContain('exceeds');
        expect(contents.text).toContain(String(MAX_INLINE_BYTES));
        expect(contents.text).toContain(signedUrl('kv-1', 'BIG'));
        // The partial body is never returned.
        expect(contents.text).not.toContain('partial');
        // A record is not pageable, so the dataset/list paging clause must not appear.
        expect(contents.text).not.toContain('offset');
        expect(contents.text).not.toContain('dataset/list');
    });

    it('still mints a signed link for a record key with malformed percent-encoding', async () => {
        // A stray `%` in the key path used to throw in decodeURIComponent and drop the link to the
        // token-gated API URL; safeDecodeURIComponent keeps the raw segment so the signed link survives.
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG%`;
        const { request } = requestReturning(abortingStream(), 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        expect(firstContent(result).text).toContain(signedUrl('kv-1', 'BIG%'));
    });

    it('falls back to the API URL when minting the signed link fails', async () => {
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG`;
        const { request } = requestReturning(abortingStream(), 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ request, recordPublicUrlThrows: true }));

        expect(firstContent(result).text).toContain(uri);
    });

    it('links an oversized dataset body to its API URL with a paging hint', async () => {
        // A non-record endpoint has no signed URL, so the link is the same (token-gated) API URL;
        // a dataset/list can shrink below the cap via limit/offset, so the hint names both.
        const uri = `${API}/v2/datasets/ds-1/items`;
        const { request } = requestReturning(abortingStream(), 'application/json');

        const result = await readApiResource(uri, stubApifyClient({ request }));

        const contents = firstContent(result);
        expect(contents.mimeType).toBe('text/plain');
        expect(contents.text).toContain('exceeds');
        expect(contents.text).toContain(uri);
        expect(contents.text).toContain('limit');
        expect(contents.text).toContain('offset');
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

    it('throws InternalError when the body is interrupted mid-stream (never partial content)', async () => {
        const dropped = Readable.from(
            (async function* generate() {
                yield Buffer.from('{"items":[');
                throw new Error('socket hang up');
            })(),
        );
        const { request } = requestReturning(dropped, 'application/json');

        const error = await expectReadError(
            readApiResource(`${API}/v2/datasets/ds-1/items`, stubApifyClient({ request })),
        );

        expect(error.code).toBe(ErrorCode.InternalError);
        expect(error.message).toContain('response interrupted');
        expect(error.message).toContain('socket hang up');
    });

    it('throws InvalidParams with the parsed error message for a resolved non-2xx 4xx response', async () => {
        const uri = `${API}/v2/datasets/missing/items`;
        const client = stubApifyClient({
            request: requestFailing(404, 'Not Found', {
                error: { message: 'Dataset was not found', type: 'record-not-found' },
            }),
        });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain(`Failed to read ${uri}: HTTP 404: Dataset was not found`);
        expect(error.data).toEqual({ uri });
    });

    it('throws InternalError falling back to statusText for a resolved 5xx with no parsable error body', async () => {
        const uri = `${API}/v2/datasets/missing/items`;
        const client = stubApifyClient({ request: requestFailing(500, 'Internal Server Error') });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InternalError);
        expect(error.message).toContain(`Failed to read ${uri}: HTTP 500: Internal Server Error`);
    });

    it('falls back to statusText when a non-2xx error body itself crosses the limit', async () => {
        const uri = `${API}/v2/datasets/missing/items`;
        const client = stubApifyClient({
            request: async () => ({
                data: abortingStream(),
                headers: {},
                status: 502,
                statusText: 'Bad Gateway',
            }),
        });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InternalError);
        expect(error.message).toContain('HTTP 502: Bad Gateway');
    });

    it('appends the auth hint for a 401 response', async () => {
        const uri = `${API}/v2/datasets/ds-1/items`;
        const client = stubApifyClient({
            request: requestFailing(401, 'Unauthorized', { error: { message: 'Token invalid' } }),
        });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain('HTTP 401: Token invalid');
        expect(error.message).toContain('check APIFY_TOKEN');
    });

    it('appends the private-resource hint for a 403 response', async () => {
        const uri = `${API}/v2/datasets/ds-1/items`;
        const client = stubApifyClient({
            request: requestFailing(403, 'Forbidden', { error: { message: 'Forbidden' } }),
        });

        const error = await expectReadError(readApiResource(uri, client));

        expect(error.code).toBe(ErrorCode.InvalidParams);
        expect(error.message).toContain('HTTP 403: Forbidden');
        expect(error.message).toContain('may be private');
    });

    it('inlines a body of exactly MAX_INLINE_BYTES (boundary — link-out is strictly over the limit)', async () => {
        // axios aborts only when bytes exceed maxContentLength, so a body of exactly the limit is not
        // aborted and inlines; only MAX_INLINE_BYTES + 1 links out (covered by the abortingStream tests).
        const exact = Buffer.alloc(MAX_INLINE_BYTES, 0x61); // 'a' repeated to exactly the limit
        const { request } = requestReturning(streamOf(exact), 'text/plain; charset=utf-8');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/EXACT`,
            stubApifyClient({ request }),
        );

        const contents = firstContent(result);
        expect(contents.text).toHaveLength(MAX_INLINE_BYTES);
        expect(contents.text).not.toContain('exceeds');
        expect(contents.mimeType).toBe('text/plain; charset=utf-8');
    });
});
