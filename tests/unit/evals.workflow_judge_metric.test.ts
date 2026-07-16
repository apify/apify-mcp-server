import { describe, expect, it } from 'vitest';

import type { LlmClient, LlmResponse } from '../../evals/workflows/llm_client.js';
import type { EvaluationResult } from '../../evals/workflows/output_formatter.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';
import { WORKFLOW_JUDGE_SCORE, WorkflowJudgeMetric } from '../../evals/workflows/workflow_judge_metric.js';

/** Judge LLM client that returns a fixed structured verdict. */
function makeJudgeLlm(verdict: 'PASS' | 'FAIL', reason: string): LlmClient {
    return {
        callLlm: async (): Promise<LlmResponse> => ({ content: JSON.stringify({ verdict, reason }) }),
    } as unknown as LlmClient;
}

const conversation: ConversationHistory = {
    userPrompt: 'go',
    turns: [{ turnNumber: 1, toolCalls: [], toolResults: [], finalResponse: 'done' }],
    completed: true,
    hitMaxTurns: false,
    totalTurns: 1,
};

function makeResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
    return {
        testCase: { id: 'test-1', category: 'basic', query: 'go', reference: 'must do it' },
        conversation,
        judgeResult: { verdict: 'FAIL', reason: 'Not yet judged', rawResponse: '' },
        durationMs: 10,
        ...overrides,
    };
}

describe('WorkflowJudgeMetric', () => {
    describe('score()', () => {
        it('returns 1 and the reason when the judge passes', async () => {
            const resultsById = new Map<string, EvaluationResult>([['test-1', makeResult()]]);
            const metric = new WorkflowJudgeMetric(resultsById, makeJudgeLlm('PASS', 'looks good'), 'judge-model');

            const score = await metric.score({ testId: 'test-1' });

            expect(score).toEqual({ name: WORKFLOW_JUDGE_SCORE, value: 1, reason: 'looks good' });
            // Verdict is written back to the side channel for the results pipeline.
            expect(resultsById.get('test-1')?.judgeResult.verdict).toBe('PASS');
        });

        it('returns 0 when the judge fails', async () => {
            const resultsById = new Map<string, EvaluationResult>([['test-1', makeResult()]]);
            const metric = new WorkflowJudgeMetric(resultsById, makeJudgeLlm('FAIL', 'missed it'), 'judge-model');

            const score = await metric.score({ testId: 'test-1' });

            expect(score.value).toBe(0);
            expect(score.reason).toBe('missed it');
        });

        it('skips the judge and returns 0 for an execution error', async () => {
            const errored = makeResult({
                error: 'boom',
                judgeResult: { verdict: 'FAIL', reason: 'Error during execution', rawResponse: '' },
            });
            const resultsById = new Map<string, EvaluationResult>([['test-1', errored]]);
            // Judge would throw if called; the error path must not call it.
            const throwingJudge = {
                callLlm: async () => {
                    throw new Error('judge should not run');
                },
            } as unknown as LlmClient;
            const metric = new WorkflowJudgeMetric(resultsById, throwingJudge, 'judge-model');

            const score = await metric.score({ testId: 'test-1' });

            expect(score.value).toBe(0);
            expect(score.reason).toBe('Error during execution');
        });

        it('returns 0 when no task result was recorded', async () => {
            const metric = new WorkflowJudgeMetric(new Map(), makeJudgeLlm('PASS', 'x'), 'judge-model');
            const score = await metric.score({ testId: 'missing' });
            expect(score.value).toBe(0);
        });
    });
});
