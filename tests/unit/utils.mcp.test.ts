import { describe, expect, it } from 'vitest';

import { computeToolResponseSizeBytes } from '../../src/utils/mcp.js';

describe('computeToolResponseSizeBytes()', () => {
    it('returns 0 for null/undefined/non-object input', () => {
        expect(computeToolResponseSizeBytes(null)).toBe(0);
        expect(computeToolResponseSizeBytes(undefined)).toBe(0);
        expect(computeToolResponseSizeBytes('text')).toBe(0);
        expect(computeToolResponseSizeBytes(42)).toBe(0);
    });

    it('returns 0 for empty result object', () => {
        expect(computeToolResponseSizeBytes({})).toBe(0);
    });

    it('sums UTF-8 byte length of every text item in content[]', () => {
        const result = {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
            ],
        };
        // "hello" = 5 bytes, "world" = 5 bytes -> 10
        expect(computeToolResponseSizeBytes(result)).toBe(10);
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
        const result = {
            content: [{ type: 'text', text: 'café' }], // c=1 a=1 f=1 é=2 → 5 bytes
        };
        expect(computeToolResponseSizeBytes(result)).toBe(5);
    });

    it('adds JSON-stringified structuredContent bytes', () => {
        const result = {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { url: 'https://x' },
        };
        const expected =
            Buffer.byteLength('ok', 'utf8') + Buffer.byteLength(JSON.stringify({ url: 'https://x' }), 'utf8');
        expect(computeToolResponseSizeBytes(result)).toBe(expected);
    });

    it('ignores non-text items in content[]', () => {
        const result = {
            content: [
                { type: 'image', data: 'base64...' },
                { type: 'text', text: 'hi' },
            ],
        };
        expect(computeToolResponseSizeBytes(result)).toBe(2);
    });

    it('handles structuredContent without content[]', () => {
        const result = { structuredContent: { a: 1 } };
        expect(computeToolResponseSizeBytes(result)).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'));
    });

    it('returns 0 when structuredContent is not JSON-serialisable', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const result = { structuredContent: circular };
        expect(computeToolResponseSizeBytes(result)).toBe(0);
    });
});
