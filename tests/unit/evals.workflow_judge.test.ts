import { describe, expect, it } from 'vitest';

import { parseJudgeResponse } from '../../evals/workflows/workflow_judge.js';

describe('parseJudgeResponse()', () => {
    it('parses a strict JSON verdict', () => {
        expect(parseJudgeResponse('{"verdict":"PASS","reason":"ok"}')).toEqual({ verdict: 'PASS', reason: 'ok' });
    });

    it('normalizes verdict casing in JSON', () => {
        expect(parseJudgeResponse('{"verdict":"fail","reason":"no"}')).toEqual({ verdict: 'FAIL', reason: 'no' });
    });

    it('recovers a prose verdict when the provider ignores the schema', () => {
        const parsed = parseJudgeResponse('FAIL. The agent never called the tool.');
        expect(parsed.verdict).toBe('FAIL');
        expect(parsed.reason).toBe('The agent never called the tool.');
    });

    it('recovers a prose PASS with a colon separator', () => {
        expect(parseJudgeResponse('pass: all requirements met').verdict).toBe('PASS');
    });

    it('rejects prose that only mentions a verdict mid-sentence', () => {
        expect(() => parseJudgeResponse('The agent should FAIL here.')).toThrow('Failed to parse judge JSON');
    });

    it('rejects an unrecognized verdict in JSON', () => {
        expect(() => parseJudgeResponse('{"verdict":"MAYBE","reason":"?"}')).toThrow('Failed to parse judge JSON');
    });
});
