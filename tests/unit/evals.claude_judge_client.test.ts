import { describe, expect, it } from 'vitest';

import { extractJsonObject } from '../../evals/workflows/claude_judge_client.js';

describe('extractJsonObject()', () => {
    it('returns a bare JSON object unchanged', () => {
        expect(extractJsonObject('{"verdict":"PASS","reason":"ok"}')).toBe('{"verdict":"PASS","reason":"ok"}');
    });

    it('strips code fences around the object', () => {
        expect(extractJsonObject('```json\n{"verdict":"FAIL","reason":"no"}\n```')).toBe(
            '{"verdict":"FAIL","reason":"no"}',
        );
    });

    it('strips prose around the object', () => {
        expect(extractJsonObject('Here is my verdict:\n{"verdict":"PASS","reason":"ok"}\nDone.')).toBe(
            '{"verdict":"PASS","reason":"ok"}',
        );
    });

    it('keeps nested braces intact', () => {
        expect(extractJsonObject('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}');
    });

    it('returns text without an object unchanged so the parse error carries it', () => {
        expect(extractJsonObject('no json here')).toBe('no json here');
    });
});
