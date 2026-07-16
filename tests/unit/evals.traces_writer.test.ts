import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EvaluationResult } from '../../evals/workflows/output_formatter.js';
import { writeTraces } from '../../evals/workflows/traces_writer.js';

function makeResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
    return {
        testCase: { id: 'test-1', category: 'code-mode', query: 'query', pairId: 'pair-1', arm: 'code-mode' },
        conversation: {
            userPrompt: 'query',
            turns: [
                {
                    turnNumber: 1,
                    toolCalls: [
                        { name: 'call-actor', arguments: { actor: 'apify/code-runtime', input: { code: 'x' } } },
                    ],
                    toolResults: [{ toolName: 'call-actor', success: true, result: { items: [1, 2, 3] } }],
                    finalResponse: 'done',
                },
            ],
            completed: true,
            hitMaxTurns: false,
            totalTurns: 1,
        },
        judgeResult: { verdict: 'PASS', reason: 'looks good', rawResponse: '' },
        durationMs: 1234,
        ...overrides,
    };
}

describe('writeTraces()', () => {
    const tmpFiles: string[] = [];

    afterEach(() => {
        for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true, recursive: true });
    });

    function tmpPath(): string {
        const file = path.join(os.tmpdir(), `traces-${Date.now()}-${Math.random()}.json`);
        tmpFiles.push(file);
        return file;
    }

    it('writes one entry per result with full tool call args and results', () => {
        const filePath = tmpPath();
        writeTraces(filePath, [makeResult()]);

        const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
            testId: 'test-1',
            category: 'code-mode',
            arm: 'code-mode',
            pairId: 'pair-1',
            query: 'query',
            durationMs: 1234,
            verdict: 'PASS',
            judgeReason: 'looks good',
        });
        // Full, untruncated tool call arguments and tool result are preserved.
        expect(written[0].conversation.turns[0].toolCalls[0].arguments).toEqual({
            actor: 'apify/code-runtime',
            input: { code: 'x' },
        });
        expect(written[0].conversation.turns[0].toolResults[0].result).toEqual({ items: [1, 2, 3] });
    });

    it('creates parent directories that do not exist yet', () => {
        const dir = path.join(os.tmpdir(), `traces-dir-${Date.now()}`);
        const filePath = path.join(dir, 'nested', 'traces.json');
        tmpFiles.push(dir);

        writeTraces(filePath, [makeResult()]);

        expect(fs.existsSync(filePath)).toBe(true);
    });

    it('overwrites an existing file rather than appending', () => {
        const filePath = tmpPath();
        writeTraces(filePath, [makeResult({ testCase: { id: 'first', category: 'c', query: 'q' } })]);
        writeTraces(filePath, [makeResult({ testCase: { id: 'second', category: 'c', query: 'q' } })]);

        const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(written).toHaveLength(1);
        expect(written[0].testId).toBe('second');
    });
});
