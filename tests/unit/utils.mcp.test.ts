import { describe, expect, it } from 'vitest';

import {
    buildResponseBytesTelemetry,
    computeToolResponseBytes,
    getToolCallErrorUserText,
} from '../../src/utils/mcp.js';

describe('getToolCallErrorUserText()', () => {
    it('returns the concurrent-run-limit hint when a direct Actor tool hits the limit', () => {
        const error = Object.assign(new Error('Cannot start new Actor runs.'), { type: 'cannot-start-actor-runs' });
        const text = getToolCallErrorUserText('apify/instagram-scraper', error);
        expect(text).toContain('account limit for concurrent Actor runs');
        expect(text).toContain('console.apify.com/billing/subscription');
        expect(text).not.toContain('Verify the tool name');
    });

    it('falls back to the generic hint for unrelated errors', () => {
        const text = getToolCallErrorUserText('apify/instagram-scraper', new Error('boom'));
        expect(text).toContain('Verify the tool name and input parameters');
    });
});

describe('computeToolResponseBytes()', () => {
    it('returns zero for null/undefined/non-object input', () => {
        expect(computeToolResponseBytes(null)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
        expect(computeToolResponseBytes(undefined)).toEqual({
            contentBytes: 0,
            structuredContentBytes: 0,
            fileBytes: 0,
        });
        expect(computeToolResponseBytes('text')).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
        expect(computeToolResponseBytes(42)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('returns zero for empty result object', () => {
        expect(computeToolResponseBytes({})).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('sums UTF-8 byte length of every text item in content[]', () => {
        const result = {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
            ],
        };
        // "hello" = 5 bytes, "world" = 5 bytes -> 10
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 10, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
        const result = {
            content: [{ type: 'text', text: 'café' }], // c=1 a=1 f=1 é=2 → 5 bytes
        };
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 5, structuredContentBytes: 0, fileBytes: 0 });
    });

    it('reports content and structuredContent bytes separately', () => {
        const result = {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { url: 'https://x' },
        };
        expect(computeToolResponseBytes(result)).toEqual({
            contentBytes: Buffer.byteLength('ok', 'utf8'),
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ url: 'https://x' }), 'utf8'),
            fileBytes: 0,
        });
    });

    it('counts image/audio base64 data as file bytes, not content bytes', () => {
        const result = {
            content: [
                { type: 'image', data: 'base64img' },
                { type: 'text', text: 'hi' },
            ],
        };
        // "base64img" = 9 file bytes; "hi" = 2 content bytes — kept in separate buckets.
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 2, structuredContentBytes: 0, fileBytes: 9 });
    });

    it('counts embedded resource blob and text as file bytes', () => {
        const result = {
            content: [
                { type: 'resource', resource: { uri: 'https://x', blob: 'AAAA', mimeType: 'application/pdf' } },
                { type: 'resource', resource: { uri: 'https://y', text: 'hello' } },
            ],
        };
        // "AAAA" = 4 + "hello" = 5 -> 9 file bytes (uri/mimeType are metadata, not payload)
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 9 });
    });

    it('handles structuredContent without content[]', () => {
        const result = { structuredContent: { a: 1 } };
        expect(computeToolResponseBytes(result)).toEqual({
            contentBytes: 0,
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'),
            fileBytes: 0,
        });
    });

    it('reports zero structuredContent bytes when not JSON-serialisable', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const result = { structuredContent: circular };
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 0, structuredContentBytes: 0, fileBytes: 0 });
    });
});

describe('buildResponseBytesTelemetry()', () => {
    it('returns an empty object when no bytes are provided', () => {
        expect(buildResponseBytesTelemetry()).toEqual({});
        expect(buildResponseBytesTelemetry(undefined)).toEqual({});
    });

    it('maps byte counts to their telemetry fields', () => {
        expect(buildResponseBytesTelemetry({ contentBytes: 10, structuredContentBytes: 20, fileBytes: 30 })).toEqual({
            tool_response_content_bytes: 10,
            tool_response_structured_content_bytes: 20,
            tool_response_file_bytes: 30,
        });
    });
});
