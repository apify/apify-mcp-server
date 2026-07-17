import { describe, expect, it } from 'vitest';

import { atifToConversation, conversationToAtif } from '../../evals/workflows/atif.js';
import type { ConversationHistory } from '../../evals/workflows/types.js';

const conversation: ConversationHistory = {
    userPrompt: 'find maps',
    turns: [
        {
            turnNumber: 1,
            toolCalls: [{ name: 'search-actors', arguments: { q: 'maps' } }],
            toolResults: [{ toolName: 'search-actors', success: true, result: { items: [] } }],
        },
        { turnNumber: 2, toolCalls: [], toolResults: [], finalResponse: 'Found 3 actors' },
    ],
    completed: true,
    hitMaxTurns: false,
    totalTurns: 2,
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
};

function toAtif() {
    return conversationToAtif({
        conversation,
        agentName: 'ts-executor',
        agentVersion: '1.0.0',
        agentModel: 'anthropic/claude-haiku-4.5',
    });
}

describe('conversationToAtif()', () => {
    it('puts the user prompt in step 1 and gives each turn an agent step', () => {
        const trajectory = toAtif();
        expect(trajectory.steps).toHaveLength(3);
        expect(trajectory.steps[0]).toMatchObject({ step_id: 1, source: 'user', message: 'find maps' });
        expect(trajectory.steps[1].source).toBe('agent');
        expect(trajectory.steps[2]).toMatchObject({ step_id: 3, source: 'agent', message: 'Found 3 actors' });
    });

    it('numbers step ids sequentially from 1', () => {
        expect(toAtif().steps.map((step) => step.step_id)).toEqual([1, 2, 3]);
    });

    it('pairs tool calls with observation results by a shared call id', () => {
        const toolStep = toAtif().steps[1];
        expect(toolStep.tool_calls).toEqual([
            { tool_call_id: '2-0', function_name: 'search-actors', arguments: { q: 'maps' } },
        ]);
        expect(toolStep.observation?.results).toEqual([
            { source_call_id: '2-0', content: JSON.stringify({ items: [] }) },
        ]);
    });

    it('records token totals and step count in final_metrics', () => {
        expect(toAtif().final_metrics).toEqual({
            total_prompt_tokens: 100,
            total_completion_tokens: 20,
            total_steps: 3,
        });
    });
});

describe('atifToConversation()', () => {
    it('reconstructs the user prompt and one turn per agent step', () => {
        const result = atifToConversation(toAtif());
        expect(result.userPrompt).toBe('find maps');
        expect(result.turns).toHaveLength(2);
        expect(result.turns[0].toolCalls).toEqual([{ name: 'search-actors', arguments: { q: 'maps' } }]);
        expect(result.turns[0].finalResponse).toBeUndefined();
        expect(result.turns[1]).toMatchObject({ toolCalls: [], finalResponse: 'Found 3 actors' });
    });

    it('round-trips the judge-relevant fields (prompt, tool calls, final responses)', () => {
        const result = atifToConversation(toAtif());
        expect(result.userPrompt).toBe(conversation.userPrompt);
        expect(result.turns.map((turn) => turn.toolCalls)).toEqual(conversation.turns.map((turn) => turn.toolCalls));
        expect(result.turns.map((turn) => turn.finalResponse)).toEqual(
            conversation.turns.map((turn) => turn.finalResponse),
        );
    });

    it('reads completion flags from extra', () => {
        const result = atifToConversation({ ...toAtif(), extra: { completed: false, hitMaxTurns: true } });
        expect(result.completed).toBe(false);
        expect(result.hitMaxTurns).toBe(true);
    });

    it('defaults completion flags when extra is absent (e.g. a claude-code trajectory)', () => {
        const trajectory = toAtif();
        delete trajectory.extra;
        const result = atifToConversation(trajectory);
        expect(result.completed).toBe(true);
        expect(result.hitMaxTurns).toBe(false);
    });
});

describe('conversationToAtif() edge cases', () => {
    it('handles multiple tool calls in one turn and a failed result', () => {
        const trajectory = conversationToAtif({
            conversation: {
                userPrompt: 'go',
                turns: [
                    {
                        turnNumber: 1,
                        toolCalls: [
                            { name: 'a', arguments: {} },
                            { name: 'b', arguments: { x: 1 } },
                        ],
                        toolResults: [
                            { toolName: 'a', success: true, result: 1 },
                            { toolName: 'b', success: false, error: 'boom' },
                        ],
                    },
                ],
                completed: false,
                hitMaxTurns: true,
                totalTurns: 1,
            },
            agentName: 'ts-executor',
            agentVersion: '1.0.0',
            agentModel: 'm',
        });
        const step = trajectory.steps[1];
        expect(step.tool_calls?.map((tc) => tc.tool_call_id)).toEqual(['2-0', '2-1']);
        expect(step.observation?.results.map((result) => result.source_call_id)).toEqual(['2-0', '2-1']);
        // A failed result is serialized as an error object.
        expect(step.observation?.results[1].content).toBe(JSON.stringify({ error: 'boom' }));
        expect(trajectory.extra).toEqual({ completed: false, hitMaxTurns: true });
    });

    it('omits token totals from final_metrics when usage is missing', () => {
        const trajectory = conversationToAtif({
            conversation: {
                ...conversation,
                promptTokens: undefined,
                completionTokens: undefined,
                totalTokens: undefined,
            },
            agentName: 'ts-executor',
            agentVersion: '1.0.0',
            agentModel: 'm',
        });
        expect(trajectory.final_metrics).toEqual({ total_steps: 3 });
    });
});
