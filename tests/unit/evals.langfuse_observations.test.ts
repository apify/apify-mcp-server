import { startObservation } from '@langfuse/tracing';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type AgentObservationParams,
    buildAgentObservations,
    emitObservations,
} from '../../evals/mcp_agent/langfuse_observations.js';
import type { AdaptedConversation } from '../../evals/mcp_agent/sdk_conversation_adapter.js';

vi.mock('@langfuse/tracing', () => ({ startObservation: vi.fn() }));

const startObservationMock = startObservation as unknown as Mock;

const START = Date.parse('2026-08-12T10:00:00.000Z');
const END = START + 5_000;

function makeAdapted(overrides: Partial<AdaptedConversation> = {}): AdaptedConversation {
    return {
        conversation: {
            userPrompt: 'find a maps scraper',
            turns: [
                { toolCalls: [{ name: 'search-actors', arguments: {} }] },
                { toolCalls: [], finalResponse: 'Found 3 Actors.' },
            ],
            totalTokens: 120,
        },
        hitMaxTurns: false,
        finalTurnStartedAt: START + 3_000,
        toolInvocations: [
            {
                name: 'search-actors',
                arguments: { search: 'maps' },
                isMcpTool: true,
                result: { toolName: 'search-actors', success: true, result: [{ text: 'ok' }], resultBytes: 16 },
                startedAt: START + 1_000,
                endedAt: START + 2_000,
            },
        ],
        metrics: {
            resultBytes: 16,
            turns: 2,
            promptTokens: 100,
            completionTokens: 20,
            cacheReadTokens: 60,
            cacheCreationTokens: 30,
            totalCostUsd: 0.01,
        },
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
            usageDetails: {
                input: 10,
                cache_read_input_tokens: 60,
                cache_creation_input_tokens: 30,
                output: 20,
                total: 120,
            },
            costDetails: { total: 0.01 },
        });
    });

    it('reports the whole prompt as fresh input when the provider reported no caching', () => {
        const adapted = makeAdapted({
            metrics: { resultBytes: 16, turns: 2, promptTokens: 100, completionTokens: 20 },
        });
        const [usage] = buildAgentObservations(makeParams({ adapted })).children;

        expect(usage.attributes.usageDetails).toEqual({ input: 100, output: 20, total: 120 });
    });

    it('windows the generation to the final model turn, so the tool spans sort before it', () => {
        const [usage] = buildAgentObservations(makeParams()).children;

        expect(usage).toMatchObject({ startTime: new Date(START + 3_000), endTime: new Date(END) });
    });

    it('pushes the generation past the last tool result when the final turn called tools', () => {
        // A run that hit the turn limit ends on a tool-calling turn, so the final turn opens
        // before its own tool spans.
        const adapted = makeAdapted({ hitMaxTurns: true, finalTurnStartedAt: START + 1_000 });
        const [usage] = buildAgentObservations(makeParams({ adapted })).children;

        expect(usage.startTime).toEqual(new Date(START + 2_000));
    });

    it('falls back to the run start when the stream was never timed', () => {
        const adapted = makeAdapted({
            finalTurnStartedAt: undefined,
            toolInvocations: [
                {
                    name: 'search-actors',
                    arguments: {},
                    isMcpTool: true,
                    result: { toolName: 'search-actors', success: true },
                },
            ],
        });
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

    it('drops an oversized tool result, which Langfuse would reject whole', () => {
        const adapted = makeAdapted({
            toolInvocations: [
                {
                    name: 'get-dataset-items',
                    arguments: {},
                    isMcpTool: true,
                    result: {
                        toolName: 'get-dataset-items',
                        success: true,
                        result: [{ text: 'x'.repeat(600_000) }],
                        resultBytes: 600_000,
                    },
                },
            ],
        });
        const toolNode = buildAgentObservations(makeParams({ adapted })).children[1];

        expect(toolNode.attributes.output).toBe('[output omitted: 600000 bytes]');
        expect(toolNode.attributes.metadata).toMatchObject({ resultBytes: 600_000, outputOmitted: true });
    });

    it('raises a failed tool call to ERROR, leaving the payload to the output alone', () => {
        const adapted = makeAdapted({
            toolInvocations: [
                {
                    name: 'call-actor',
                    arguments: {},
                    isMcpTool: true,
                    result: { toolName: 'call-actor', success: false, error: 'internal error' },
                },
            ],
        });
        const toolNode = buildAgentObservations(makeParams({ adapted })).children[1];

        expect(toolNode.attributes).toMatchObject({
            level: 'ERROR',
            output: 'internal error',
        });
        // The UI already renders output; a copy in statusMessage only repeats it.
        expect(toolNode.attributes.statusMessage).toBeUndefined();
    });

    it('leaves the span times open when the stream was not timed', () => {
        const adapted = makeAdapted({
            toolInvocations: [
                {
                    name: 'search-actors',
                    arguments: {},
                    isMcpTool: true,
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

describe('emitObservations()', () => {
    /** Records which spans were ended, in order, and lets a named span fail to start. */
    function stubObservations(failingName?: string): string[] {
        const ended: string[] = [];
        startObservationMock.mockImplementation((name: string) => {
            if (name === failingName) throw new Error('attribute serialization failed');
            return {
                otelSpan: { spanContext: () => ({ traceId: 't', spanId: name, traceFlags: 1 }) },
                end: () => ended.push(name),
            };
        });
        return ended;
    }

    beforeEach(() => {
        startObservationMock.mockReset();
    });

    it('emits the agent span with its generation and tool children', () => {
        const ended = stubObservations();

        emitObservations(buildAgentObservations(makeParams()));

        expect(ended).toEqual(['claude-haiku-4-5', 'search-actors', 'agent']);
    });

    it('ends the parent span even when a child fails to start, so no span is left dangling', () => {
        const ended = stubObservations('search-actors');

        expect(() => emitObservations(buildAgentObservations(makeParams()))).toThrow('attribute serialization failed');
        expect(ended).toEqual(['claude-haiku-4-5', 'agent']);
    });
});
