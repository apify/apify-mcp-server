import { describe, expect, it } from 'vitest';

import { computeToolResponseSizeBytes } from '../../src/utils/mcp.js';

describe('computeToolResponseSizeBytes()', () => {
    it('returns zero for null/undefined/non-object input', () => {
        expect(computeToolResponseSizeBytes(null)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
        expect(computeToolResponseSizeBytes(undefined)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
        expect(computeToolResponseSizeBytes('text')).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
        expect(computeToolResponseSizeBytes(42)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
    });

    it('returns zero for empty result object', () => {
        expect(computeToolResponseSizeBytes({})).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
    });

    it('sums UTF-8 byte length of every text item in content[]', () => {
        const result = {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
            ],
        };
        // "hello" = 5 bytes, "world" = 5 bytes -> 10
        expect(computeToolResponseSizeBytes(result)).toEqual({ contentBytes: 10, structuredContentBytes: 0 });
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
        const result = {
            content: [{ type: 'text', text: 'café' }], // c=1 a=1 f=1 é=2 → 5 bytes
        };
        expect(computeToolResponseSizeBytes(result)).toEqual({ contentBytes: 5, structuredContentBytes: 0 });
    });

    it('reports content and structuredContent bytes separately', () => {
        const result = {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { url: 'https://x' },
        };
        expect(computeToolResponseSizeBytes(result)).toEqual({
            contentBytes: Buffer.byteLength('ok', 'utf8'),
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ url: 'https://x' }), 'utf8'),
        });
    });

    it('ignores non-text items in content[]', () => {
        const result = {
            content: [
                { type: 'image', data: 'base64...' },
                { type: 'text', text: 'hi' },
            ],
        };
        expect(computeToolResponseSizeBytes(result)).toEqual({ contentBytes: 2, structuredContentBytes: 0 });
    });

    it('handles structuredContent without content[]', () => {
        const result = { structuredContent: { a: 1 } };
        expect(computeToolResponseSizeBytes(result)).toEqual({
            contentBytes: 0,
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'),
        });
    });

    it('reports zero structuredContent bytes when not JSON-serialisable', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const result = { structuredContent: circular };
        expect(computeToolResponseSizeBytes(result)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
    });
});
