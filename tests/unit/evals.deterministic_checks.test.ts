import { describe, expect, it } from 'vitest';

import { checkSchemaValidity, checkToolSelection } from '../../evals/workflows/deterministic_checks.js';
import type { ConversationHistory, McpTool } from '../../evals/workflows/types.js';

function makeConversation(
    toolCallsPerTurn: { name: string; arguments: Record<string, unknown> }[][],
): ConversationHistory {
    return {
        userPrompt: 'test',
        turns: toolCallsPerTurn.map((toolCalls, index) => ({
            turnNumber: index + 1,
            toolCalls,
            toolResults: toolCalls.map((call) => ({ toolName: call.name, success: true, result: {} })),
        })),
        completed: true,
        hitMaxTurns: false,
        totalTurns: toolCallsPerTurn.length,
    };
}

describe('checkToolSelection()', () => {
    it('reports not-checked when the test case declares no expectedTools', () => {
        const check = checkToolSelection(undefined, makeConversation([[{ name: 'search-actors', arguments: {} }]]));
        expect(check).toEqual({ checked: false, verdict: null, expected: [], actual: ['search-actors'] });
    });

    it('reports not-checked for an empty expectedTools array', () => {
        expect(checkToolSelection([], makeConversation([])).checked).toBe(false);
    });

    it('passes on an exact match regardless of call order', () => {
        const conversation = makeConversation([
            [{ name: 'call-actor', arguments: {} }],
            [{ name: 'get-dataset-items', arguments: {} }],
        ]);
        const check = checkToolSelection(['get-dataset-items', 'call-actor'], conversation);
        expect(check.verdict).toBe('PASS');
        expect(check.expected).toEqual(['call-actor', 'get-dataset-items']);
        expect(check.actual).toEqual(['call-actor', 'get-dataset-items']);
    });

    it('passes when the agent calls the same expected tool several times', () => {
        const conversation = makeConversation([
            [{ name: 'get-dataset-items', arguments: {} }],
            [{ name: 'get-dataset-items', arguments: {} }],
        ]);
        expect(checkToolSelection(['get-dataset-items'], conversation).verdict).toBe('PASS');
    });

    it('fails on an extra tool call', () => {
        const conversation = makeConversation([
            [
                { name: 'call-actor', arguments: {} },
                { name: 'search-actors', arguments: {} },
            ],
        ]);
        const check = checkToolSelection(['call-actor'], conversation);
        expect(check.verdict).toBe('FAIL');
        expect(check.actual).toEqual(['call-actor', 'search-actors']);
    });

    it('fails on a missing tool call', () => {
        const conversation = makeConversation([[{ name: 'call-actor', arguments: {} }]]);
        expect(checkToolSelection(['call-actor', 'get-dataset-items'], conversation).verdict).toBe('FAIL');
    });

    it('fails when the agent called nothing at all', () => {
        const check = checkToolSelection(['search-actors'], makeConversation([]));
        expect(check.verdict).toBe('FAIL');
        expect(check.actual).toEqual([]);
    });
});

describe('checkSchemaValidity()', () => {
    const tools: McpTool[] = [
        {
            name: 'get-dataset-items',
            inputSchema: {
                $id: 'get-dataset-items',
                type: 'object',
                properties: { datasetId: { type: 'string' }, limit: { type: 'integer' } },
                required: ['datasetId'],
            },
        },
    ];

    it('passes when every call matches its tool schema', () => {
        const conversation = makeConversation([
            [{ name: 'get-dataset-items', arguments: { datasetId: 'd1', limit: 5 } }],
        ]);
        expect(checkSchemaValidity(conversation, tools)).toEqual({ verdict: 'PASS', invalidCalls: [] });
    });

    it('passes for a conversation with no tool calls', () => {
        expect(checkSchemaValidity(makeConversation([]), tools).verdict).toBe('PASS');
    });

    it('flags a call missing a required property', () => {
        const conversation = makeConversation([[{ name: 'get-dataset-items', arguments: { limit: 5 } }]]);
        const check = checkSchemaValidity(conversation, tools);
        expect(check.verdict).toBe('FAIL');
        expect(check.invalidCalls).toHaveLength(1);
        expect(check.invalidCalls[0].toolName).toBe('get-dataset-items');
        expect(check.invalidCalls[0].errors.join()).toContain('datasetId');
    });

    it('flags a call with a wrongly typed property', () => {
        const conversation = makeConversation([
            [{ name: 'get-dataset-items', arguments: { datasetId: 'd1', limit: 'five' } }],
        ]);
        const check = checkSchemaValidity(conversation, tools);
        expect(check.verdict).toBe('FAIL');
        expect(check.invalidCalls[0].errors.join()).toContain('/limit');
    });

    it('validates repeat calls to the same tool against one cached validator', () => {
        const conversation = makeConversation([
            [{ name: 'get-dataset-items', arguments: { datasetId: 'd1' } }],
            [{ name: 'get-dataset-items', arguments: {} }],
        ]);
        const check = checkSchemaValidity(conversation, tools);
        expect(check.invalidCalls).toHaveLength(1);
    });

    it('skips a call to a tool that is not in the final tool list', () => {
        const conversation = makeConversation([[{ name: 'since-deregistered-tool', arguments: { anything: 1 } }]]);
        expect(checkSchemaValidity(conversation, tools).verdict).toBe('PASS');
    });

    it('skips a tool whose schema cannot be compiled', () => {
        const brokenTools: McpTool[] = [
            { name: 'broken', inputSchema: { type: 'object', properties: { a: { type: 'not-a-type' } } } },
        ];
        const conversation = makeConversation([[{ name: 'broken', arguments: { a: 1 } }]]);
        expect(checkSchemaValidity(conversation, brokenTools).verdict).toBe('PASS');
    });

    it('does not flag a failed tool call whose arguments were schema-valid', () => {
        // failTools makes the harness synthesize an error result; the call itself is still valid.
        const conversation: ConversationHistory = {
            userPrompt: 'test',
            turns: [
                {
                    turnNumber: 1,
                    toolCalls: [{ name: 'get-dataset-items', arguments: { datasetId: 'd1' } }],
                    toolResults: [{ toolName: 'get-dataset-items', success: false, error: 'internal error' }],
                },
            ],
            completed: true,
            hitMaxTurns: false,
            totalTurns: 1,
        };
        expect(checkSchemaValidity(conversation, tools).verdict).toBe('PASS');
    });
});
