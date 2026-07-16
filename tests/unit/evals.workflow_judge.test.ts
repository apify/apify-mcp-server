import { describe, expect, it } from 'vitest';

import type { ConversationHistory } from '../../evals/workflows/types.js';
import { formatConversationForJudge } from '../../evals/workflows/workflow_judge.js';

function createConversation(result: unknown): ConversationHistory {
    return {
        userPrompt: 'Do the task',
        turns: [
            {
                turnNumber: 1,
                toolCalls: [{ name: 'call-actor', arguments: { actor: 'apify/code-runtime' } }],
                toolResults: [{ toolName: 'call-actor', success: true, result }],
            },
            {
                turnNumber: 2,
                toolCalls: [],
                toolResults: [],
                finalResponse: 'Done',
            },
        ],
        completed: true,
        hitMaxTurns: false,
        totalTurns: 2,
    };
}

describe('formatConversationForJudge()', () => {
    it('includes tool-result evidence', () => {
        const transcript = formatConversationForJudge(createConversation({ exitCode: 0, stdout: 'five posts' }));

        expect(transcript).toContain('TOOL: [call-actor succeeded]');
        expect(transcript).toContain('"exitCode":0');
    });

    it('bounds large tool results', () => {
        const transcript = formatConversationForJudge(createConversation({ output: 'x'.repeat(10_000) }));

        expect(transcript).toContain('[truncated');
        expect(transcript.length).toBeLessThan(5_000);
    });
});
