import { describe, expect, it } from 'vitest';

import { type AgentObservationParams, buildAgentObservations } from '../../evals/workflows/langfuse_observations.js';
import type { AdaptedConversation } from '../../evals/workflows/sdk_conversation_adapter.js';

const START = Date.parse('2026-08-12T10:00:00.000Z');
const END = START + 5_000;

function makeAdapted(overrides: Partial<AdaptedConversation> = {}): AdaptedConversation {
    return {
        conversation: {
            userPrompt: 'find a maps scraper',
            turns: [
                { turnNumber: 1, toolCalls: [{ name: 'search-actors', arguments: {} }], toolResults: [] },
                { turnNumber: 2, toolCalls: [], toolResults: [], finalResponse: 'Found 3 Actors.' },
            ],
            completed: true,
            hitMaxTurns: false,
            totalTurns: 2,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
        },
        hitMaxTurns: false,
        finalTurnStartedAt: START + 3_000,
        toolInvocations: [
            {
                name: 'search-actors',
                arguments: { search: 'maps' },
                result: { toolName: 'search-actors', success: true, result: [{ text: 'ok' }], resultBytes: 16 },
                startedAt: START + 1_000,
                endedAt: START + 2_000,
            },
        ],
        metrics: { resultBytes: 16, turns: 2, promptTokens: 100, completionTokens: 20, totalCostUsd: 0.01 },
        claudeCodeVersion: '2.0.0',
        transcript: [],
        ...overrides,
    };
}

function makeParams(overrides: Partial<AgentObservationParams> = {}): AgentObservationParams {
    return {
        prompt: 'find a maps scraper',
        model: 'claude-haiku-4-5',
        mcpToolsOnly: false,
        adapted: makeAdapted(),
        startedAt: START,
        endedAt: END,
        ...overrides,
    };
}

describe('buildAgentObservations()', () => {
    it('spans the agent run with the prompt in and the final answer out', () => {
        const agent = buildAgentObservations(makeParams());

        expect(agent).toMatchObject({
            name: 'agent',
            asType: 'agent',
            startTime: new Date(START),
            endTime: new Date(END),
        });
        expect(agent.attributes).toMatchObject({
            input: 'find a maps scraper',
            output: 'Found 3 Actors.',
            metadata: { model: 'claude-haiku-4-5', turns: 2, toolCalls: 1, claudeCodeVersion: '2.0.0' },
        });
    });

    it('carries the run tokens and cost on a generation, which is what Langfuse rolls up', () => {
        const [usage] = buildAgentObservations(makeParams()).children;

        expect(usage).toMatchObject({ name: 'claude-haiku-4-5', asType: 'generation' });
        expect(usage.attributes).toMatchObject({
            model: 'claude-haiku-4-5',
            usageDetails: { input: 100, output: 20, total: 120 },
            costDetails: { total: 0.01 },
        });
    });

    it('windows the generation to the final model turn, so the tool spans sort before it', () => {
        const [usage] = buildAgentObservations(makeParams()).children;

        expect(usage).toMatchObject({ startTime: new Date(START + 3_000), endTime: new Date(END) });
    });

    it('falls back to the run start when the final turn was never stamped', () => {
        const adapted = makeAdapted({ finalTurnStartedAt: undefined });
        const [usage] = buildAgentObservations(makeParams({ adapted })).children;

        expect(usage.startTime).toEqual(new Date(START));
    });

    it('omits usage when the provider reported none, so an unmeasured run cannot read as free', () => {
        const adapted = makeAdapted({ metrics: { resultBytes: 0, turns: 1 } });
        const [usage] = buildAgentObservations(makeParams({ adapted })).children;

        expect(usage.attributes.usageDetails).toBeUndefined();
        expect(usage.attributes.costDetails).toBeUndefined();
    });

    it('gives each tool call its own span, timed from the stream', () => {
        const toolNode = buildAgentObservations(makeParams()).children[1];

        expect(toolNode).toMatchObject({
            name: 'search-actors',
            asType: 'tool',
            startTime: new Date(START + 1_000),
            endTime: new Date(START + 2_000),
        });
        expect(toolNode.attributes).toMatchObject({
            input: { search: 'maps' },
            output: [{ text: 'ok' }],
            metadata: { resultBytes: 16 },
        });
        expect(toolNode.attributes.level).toBeUndefined();
    });

    it('raises a failed tool call to ERROR with the payload as the status', () => {
        const adapted = makeAdapted({
            toolInvocations: [
                {
                    name: 'call-actor',
                    arguments: {},
                    result: { toolName: 'call-actor', success: false, error: 'internal error' },
                },
            ],
        });
        const toolNode = buildAgentObservations(makeParams({ adapted })).children[1];

        expect(toolNode.attributes).toMatchObject({
            level: 'ERROR',
            statusMessage: 'internal error',
            output: 'internal error',
        });
    });

    it('leaves the span times open when the stream was not timed', () => {
        const adapted = makeAdapted({
            toolInvocations: [
                {
                    name: 'search-actors',
                    arguments: {},
                    result: { toolName: 'search-actors', success: true },
                },
            ],
        });
        const toolNode = buildAgentObservations(makeParams({ adapted })).children[1];

        expect(toolNode.startTime).toBeUndefined();
        expect(toolNode.endTime).toBeUndefined();
    });

    it('flags a run that hit the turn limit as a warning', () => {
        const adapted = makeAdapted();
        adapted.hitMaxTurns = true;

        expect(buildAgentObservations(makeParams({ adapted })).attributes).toMatchObject({
            level: 'WARNING',
            statusMessage: 'hit the turn limit',
        });
    });
});
