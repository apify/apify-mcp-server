import { describe, expect, it } from 'vitest';

import {
    buildRunName,
    scoreJudge,
    scoreResultBytes,
    scoreTotalTokens,
    shortModelName,
    sumResultBytes,
    type WorkflowTaskOutput,
} from '../../evals/workflows/langfuse_experiment.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';

function makeConversation(turns: ConversationHistory['turns']): ConversationHistory {
    return {
        userPrompt: 'test',
        turns,
        completed: true,
        hitMaxTurns: false,
        totalTurns: turns.length,
    };
}

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

describe('sumResultBytes()', () => {
    it('returns 0 for a conversation with no tool results', () => {
        const conversation = makeConversation([{ turnNumber: 1, toolCalls: [], toolResults: [], finalResponse: 'hi' }]);
        expect(sumResultBytes(conversation)).toBe(0);
    });

    it('sums resultBytes across all tool results in all turns', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [],
                toolResults: [
                    { toolName: 'a', success: true, resultBytes: 100 },
                    { toolName: 'b', success: true, resultBytes: 50 },
                ],
            },
            {
                turnNumber: 2,
                toolCalls: [],
                toolResults: [{ toolName: 'c', success: true, resultBytes: 25 }],
            },
        ]);
        expect(sumResultBytes(conversation)).toBe(175);
    });

    it('treats missing resultBytes as 0', () => {
        const conversation = makeConversation([
            {
                turnNumber: 1,
                toolCalls: [],
                toolResults: [
                    { toolName: 'a', success: true },
                    { toolName: 'b', success: true, resultBytes: 30 },
                ],
            },
        ]);
        expect(sumResultBytes(conversation)).toBe(30);
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
