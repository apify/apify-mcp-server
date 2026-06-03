import { describe, expect, it } from 'vitest';

import { computeToolResponseBytes, encodeJsonText } from '../../src/utils/mcp.js';

describe('encodeJsonText()', () => {
    it('emits a ```json … ``` fenced block', () => {
        expect(encodeJsonText({ a: 1 })).toBe('```json\n{"a":1}\n```');
    });

    it('serializes arrays', () => {
        expect(encodeJsonText([1, 2])).toBe('```json\n[1,2]\n```');
    });

    it('serializes primitives', () => {
        expect(encodeJsonText('x')).toBe('```json\n"x"\n```');
    });
});

describe('computeToolResponseBytes()', () => {
    it('returns zero for null/undefined/non-object input', () => {
        expect(computeToolResponseBytes(null)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
        expect(computeToolResponseBytes(undefined)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
        expect(computeToolResponseBytes('text')).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
        expect(computeToolResponseBytes(42)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
    });

    it('returns zero for empty result object', () => {
        expect(computeToolResponseBytes({})).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
    });

    it('sums UTF-8 byte length of every text item in content[]', () => {
        const result = {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
            ],
        };
        // "hello" = 5 bytes, "world" = 5 bytes -> 10
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 10, structuredContentBytes: 0 });
    });

    it('counts multi-byte UTF-8 characters correctly', () => {
        const result = {
            content: [{ type: 'text', text: 'café' }], // c=1 a=1 f=1 é=2 → 5 bytes
        };
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 5, structuredContentBytes: 0 });
    });

    it('reports content and structuredContent bytes separately', () => {
        const result = {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { url: 'https://x' },
        };
        expect(computeToolResponseBytes(result)).toEqual({
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
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 2, structuredContentBytes: 0 });
    });

    it('handles structuredContent without content[]', () => {
        const result = { structuredContent: { a: 1 } };
        expect(computeToolResponseBytes(result)).toEqual({
            contentBytes: 0,
            structuredContentBytes: Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'),
        });
    });

    it('reports zero structuredContent bytes when not JSON-serialisable', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const result = { structuredContent: circular };
        expect(computeToolResponseBytes(result)).toEqual({ contentBytes: 0, structuredContentBytes: 0 });
    });
});
