import { describe, expect, it } from 'vitest';

import {
    buildRunName,
    scoreJudge,
    scoreResultBytes,
    scoreTotalTokens,
    shortModelName,
    testCaseToExperimentItem,
    type WorkflowTaskOutput,
} from '../../evals/workflows/langfuse_experiment.js';
import type { WorkflowTestCase } from '../../evals/workflows/test_cases_loader.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';

function makeOutput(overrides: Partial<WorkflowTaskOutput> = {}): WorkflowTaskOutput {
    const conversation: ConversationHistory = {
        userPrompt: 'q',
        turns: [{ turnNumber: 1, toolCalls: [], toolResults: [{ toolName: 't', success: true, resultBytes: 42 }] }],
        completed: true,
        hitMaxTurns: false,
        totalTurns: 1,
        totalTokens: 1234,
    };
    return {
        conversation,
        judgeResult: { verdict: 'PASS', reason: 'looks good', rawResponse: '' },
        ...overrides,
    };
}

describe('shortModelName()', () => {
    it('returns the last path segment of a model id', () => {
        expect(shortModelName('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4.5');
    });

    it('returns the id unchanged when there is no slash', () => {
        expect(shortModelName('gpt-4o')).toBe('gpt-4o');
    });
});

describe('buildRunName()', () => {
    it('joins branch, short model name, and timestamp', () => {
        expect(buildRunName('feat/langfuse-workflow-evals', 'anthropic/claude-haiku-4.5', 1234567890)).toBe(
            'feat/langfuse-workflow-evals-claude-haiku-4.5-1234567890',
        );
    });
});

describe('testCaseToExperimentItem()', () => {
    it('maps query to input and reference to expectedOutput and carries the test case', () => {
        const testCase: WorkflowTestCase = { id: 'a', category: 'basic', query: 'do a thing', reference: 'must do X' };
        expect(testCaseToExperimentItem(testCase)).toEqual({
            input: { query: 'do a thing' },
            expectedOutput: 'must do X',
            metadata: { testCase },
        });
    });

    it('uses null expectedOutput when there is no reference', () => {
        const testCase: WorkflowTestCase = { id: 'a', category: 'basic', query: 'q' };
        expect(testCaseToExperimentItem(testCase).expectedOutput).toBeNull();
    });
});

describe('scoreJudge()', () => {
    it('scores 1 with the judge reason as comment on PASS', () => {
        expect(scoreJudge(makeOutput())).toEqual({ name: 'workflow_judge', value: 1, comment: 'looks good' });
    });

    it('scores 0 on FAIL', () => {
        const output = makeOutput({ judgeResult: { verdict: 'FAIL', reason: 'missed X', rawResponse: '' } });
        expect(scoreJudge(output)).toEqual({ name: 'workflow_judge', value: 0, comment: 'missed X' });
    });

    it('appends the error message to the comment when the item errored', () => {
        const output = makeOutput({
            judgeResult: { verdict: 'FAIL', reason: 'Error during execution', rawResponse: '' },
            error: 'boom',
        });
        expect(scoreJudge(output)).toEqual({
            name: 'workflow_judge',
            value: 0,
            comment: 'Error during execution (boom)',
        });
    });
});

describe('scoreTotalTokens()', () => {
    it('reads totalTokens from the conversation', () => {
        expect(scoreTotalTokens(makeOutput())).toEqual({ name: 'total_tokens', value: 1234 });
    });

    it('defaults to 0 when totalTokens is undefined', () => {
        const output = makeOutput();
        output.conversation.totalTokens = undefined;
        expect(scoreTotalTokens(output)).toEqual({ name: 'total_tokens', value: 0 });
    });
});

describe('scoreResultBytes()', () => {
    it('sums tool-result bytes across the conversation', () => {
        expect(scoreResultBytes(makeOutput())).toEqual({ name: 'result_bytes', value: 42 });
    });
});
