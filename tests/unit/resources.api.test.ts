import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { ApifyClient } from '../../src/apify_client.js';
import { MAX_INLINE_BYTES } from '../../src/const.js';
import { isApifyApiUri, readApiResource } from '../../src/resources/api_resources.js';

const API = 'https://api.apify.com';

// `contents[0]` is a text|blob union; narrow it in tests that read one shape.
function firstContent(result: ReadResourceResult): { mimeType?: string; text?: string; blob?: string } {
    return result.contents[0] as { mimeType?: string; text?: string; blob?: string };
}

type CallResult = { data: unknown; headers: Record<string, unknown> };

type StubOptions = {
    call?: (config: { url: string }) => Promise<CallResult>;
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
            call: opts.call ?? (async () => ({ data: undefined, headers: {} })),
        },
    } as unknown as ApifyClient;
}

/** Build a call stub returning a fixed body + content-type, capturing the requested URL. */
function callReturning(data: unknown, contentType?: string) {
    const captured: { url?: string } = {};
    const call = async (config: { url: string }): Promise<CallResult> => {
        captured.url = config.url;
        return { data, headers: contentType ? { 'content-type': contentType } : {} };
    };
    return { call, captured };
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
    it('returns an explanatory text block when there is no token', async () => {
        const result = await readApiResource(`${API}/v2/datasets/ds-1/items`, undefined);

        expect(firstContent(result).mimeType).toBe('text/plain');
        expect(firstContent(result).text).toContain('no Apify token');
    });

    it('refuses to read a non-Apify URL (no token leak to other hosts)', async () => {
        const result = await readApiResource('https://example.com/steal-my-token', stubApifyClient());

        expect(firstContent(result).text).toContain('only Apify API URLs');
    });

    it('passes the full URL through to httpClient.call', async () => {
        const { call, captured } = callReturning([{ a: 1 }], 'application/json');
        const uri = `${API}/v2/datasets/ds-1/items?limit=5`;

        await readApiResource(uri, stubApifyClient({ call }));

        expect(captured.url).toBe(uri);
    });

    it('serializes a parsed JSON body as text with its content-type', async () => {
        const { call } = callReturning({ query: 'hi' }, 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/INPUT`,
            stubApifyClient({ call }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(JSON.parse(firstContent(result).text as string)).toEqual({ query: 'hi' });
    });

    it('serializes a dataset items array as JSON', async () => {
        const { call } = callReturning([{ a: 1 }, { a: 2 }], 'application/json');

        const result = await readApiResource(`${API}/v2/datasets/ds-1/items`, stubApifyClient({ call }));

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(JSON.parse(firstContent(result).text as string)).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('round-trips a JSON null body instead of dropping it as empty text', async () => {
        // apify-client parses a literal JSON `null` body to JS null; it must serialize back to "null",
        // not collapse to empty text (which would look like an absent record).
        const { call } = callReturning(null, 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/OUTPUT`,
            stubApifyClient({ call }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(firstContent(result).text).toBe('null');
    });

    it('re-serializes a bare JSON string body so the quotes survive', async () => {
        // A bare JSON string body parses to a JS string; emitting it verbatim would yield invalid JSON
        // (`hello`, not `"hello"`). Re-serialize when the declared Content-Type is JSON.
        const { call } = callReturning('hello', 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/GREETING`,
            stubApifyClient({ call }),
        );

        expect(firstContent(result).mimeType).toBe('application/json');
        expect(firstContent(result).text).toBe('"hello"');
        expect(JSON.parse(firstContent(result).text as string)).toBe('hello');
    });

    it('returns a text body verbatim with its content-type', async () => {
        const { call } = callReturning('hello world', 'text/plain; charset=utf-8');

        const result = await readApiResource(`${API}/v2/key-value-stores/kv-1/records/NOTE`, stubApifyClient({ call }));

        expect(firstContent(result).mimeType).toBe('text/plain; charset=utf-8');
        expect(firstContent(result).text).toBe('hello world');
    });

    it('returns binary values as a base64 blob with mimeType', async () => {
        const { call } = callReturning(Buffer.from('binary-data'), 'image/png');

        const result = await readApiResource(`${API}/v2/key-value-stores/kv-1/records/IMG`, stubApifyClient({ call }));

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
        const { call } = callReturning(oversized, 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ call }));

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
        const { call } = callReturning(oversized, 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ call }));

        expect(firstContent(result).text).toContain(signedUrl('kv-1', 'BIG%'));
    });

    it('falls back to the API URL when minting the signed link fails', async () => {
        const oversized = Buffer.alloc(MAX_INLINE_BYTES + 1);
        const uri = `${API}/v2/key-value-stores/kv-1/records/BIG`;
        const { call } = callReturning(oversized, 'application/octet-stream');

        const result = await readApiResource(uri, stubApifyClient({ call, recordPublicUrlThrows: true }));

        expect(firstContent(result).text).toContain(uri);
    });

    it('returns empty text for an empty body', async () => {
        // The client maps an empty record body to `undefined` (e.g. an Actor that writes an empty OUTPUT).
        const { call } = callReturning(undefined, 'application/json');

        const result = await readApiResource(
            `${API}/v2/key-value-stores/kv-1/records/OUTPUT`,
            stubApifyClient({ call }),
        );

        expect(firstContent(result).text).toBe('');
        expect(firstContent(result)).not.toHaveProperty('blob');
        // Empty body still preserves the record's declared Content-Type rather than defaulting to text/plain.
        expect(firstContent(result).mimeType).toBe('application/json');
    });

    it('returns an explanatory text block when the request fails', async () => {
        const client = stubApifyClient({
            call: async () => {
                throw Object.assign(new Error('not found'), { statusCode: 404 });
            },
        });

        const result = await readApiResource(`${API}/v2/datasets/missing/items`, client);

        expect(firstContent(result).text).toContain('Failed to read');
        expect(firstContent(result).text).toContain('404');
    });
});
