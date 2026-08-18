/**
 * The per-item observation tree that Langfuse shows behind an experiment item.
 *
 * The agent runs inside the Claude Code subprocess, so none of its work is instrumented
 * for us: without this module an item's trace holds exactly one span (the Langfuse SDK's
 * own `experiment-item-run`) and the conversation is invisible in the UI. The tree is
 * built from the adapted SDK stream once the run has finished, from the timestamps taken
 * while that stream was consumed, so the spans carry real durations instead of collapsing
 * at emit time.
 *
 * Shape per item:
 *
 *     experiment-item-run     Langfuse SDK, holds the scores
 *     |- agent                the prompt in, the final answer out
 *     |  |- <agent model>     generation: the run's aggregate tokens and cost
 *     |  |- <tool name>       one span per tool call: arguments in, result out
 *     |- <judge model>        generation, emitted by llm_client.ts
 *
 * Building the tree is kept separate from emitting it so the payload shaping is testable
 * without an OpenTelemetry provider.
 */

import type { LangfuseObservationAttributes } from '@langfuse/tracing';
import { startObservation } from '@langfuse/tracing';
import type { SpanContext } from '@opentelemetry/api';

import type { AdaptedConversation, ToolInvocation } from './sdk_conversation_adapter.js';

/** Observation types this module emits. */
type ObservationType = 'agent' | 'generation' | 'tool';

/** A Langfuse observation to emit, with its children. */
export type ObservationNode = {
    name: string;
    asType: ObservationType;
    attributes: LangfuseObservationAttributes;
    /** Omitted when the moment is unknown, which makes the span start (or end) at emit time. */
    startTime?: Date;
    endTime?: Date;
    children: ObservationNode[];
};

export type AgentObservationParams = {
    /** The user prompt for this test case. */
    prompt: string;
    /** Anthropic model ID the agent ran on. */
    model: string;
    /** Whether the run dropped Claude Code's built-in tools. */
    mcpToolsOnly: boolean;
    /** The folded SDK stream: conversation, tool invocations, metrics. */
    adapted: AdaptedConversation;
    /** Epoch ms around the agent run, measured by the caller. */
    startedAt: number;
    endedAt: number;
};

/** The answer the agent finished on, which the adapter parks on the last turn. */
function finalResponseOf(adapted: AdaptedConversation): string | undefined {
    return adapted.conversation.turns.at(-1)?.finalResponse;
}

/**
 * One tool call: arguments in, result out, failures raised to ERROR so they stand out.
 * The error text is left to `output` alone: Langfuse renders `statusMessage` in its own box
 * above the output preview, so setting it shows the same message twice.
 */
function toolNode(invocation: ToolInvocation): ObservationNode {
    const { result } = invocation;

    return {
        name: invocation.name,
        asType: 'tool',
        attributes: {
            input: invocation.arguments,
            output: result.success ? result.result : result.error,
            metadata: { resultBytes: result.resultBytes },
            ...(result.success ? {} : { level: 'ERROR' }),
        },
        ...(invocation.startedAt === undefined ? {} : { startTime: new Date(invocation.startedAt) }),
        ...(invocation.endedAt === undefined ? {} : { endTime: new Date(invocation.endedAt) }),
        children: [],
    };
}

/**
 * The generation that carries the run's cost. Langfuse rolls tokens and cost up from
 * generations only, and the SDK reports usage once for the whole run rather than per turn,
 * so the run's aggregate sits on this one generation.
 *
 * Windowed to the final model turn, not the whole run: the UI orders siblings by start
 * time, so a generation spanning the tool calls sorts ahead of them and reads as though
 * the model answered before calling anything. `usageScope` marks that the numbers still
 * cover the whole run.
 */
function usageNode(params: AgentObservationParams): ObservationNode {
    const { metrics } = params.adapted;
    const { promptTokens, completionTokens } = metrics;
    const hasTokens = promptTokens !== undefined && completionTokens !== undefined;
    const cacheRead = metrics.cacheReadTokens ?? 0;
    const cacheCreation = metrics.cacheCreationTokens ?? 0;

    return {
        name: params.model,
        asType: 'generation',
        attributes: {
            model: params.model,
            input: params.prompt,
            output: finalResponseOf(params.adapted),
            ...(hasTokens
                ? {
                      // Broken out rather than one prompt-token number: a multi-turn run re-reads
                      // the cached system prompt and tool definitions every turn, so the total is
                      // mostly cache traffic and reads as a huge prompt when it is not shown apart.
                      usageDetails: {
                          input: promptTokens - cacheRead - cacheCreation,
                          ...(cacheRead === 0 ? {} : { cache_read_input_tokens: cacheRead }),
                          ...(cacheCreation === 0 ? {} : { cache_creation_input_tokens: cacheCreation }),
                          output: completionTokens,
                          total: promptTokens + completionTokens,
                      },
                  }
                : {}),
            ...(metrics.totalCostUsd === undefined ? {} : { costDetails: { total: metrics.totalCostUsd } }),
            metadata: { turns: metrics.turns, usageScope: 'run' },
        },
        startTime: new Date(params.adapted.finalTurnStartedAt ?? params.startedAt),
        endTime: new Date(params.endedAt),
        children: [],
    };
}

/** Build the item's agent subtree. Pure: nothing is sent until emitObservations runs. */
export function buildAgentObservations(params: AgentObservationParams): ObservationNode {
    const { adapted } = params;
    const { metrics } = adapted;

    return {
        name: 'agent',
        asType: 'agent',
        attributes: {
            input: params.prompt,
            output: finalResponseOf(adapted),
            metadata: {
                model: params.model,
                mcpToolsOnly: params.mcpToolsOnly,
                claudeCodeVersion: adapted.claudeCodeVersion,
                turns: metrics.turns,
                toolCalls: adapted.toolInvocations.length,
                resultBytes: metrics.resultBytes,
                hitMaxTurns: adapted.hitMaxTurns,
            },
            // A run that ran out of turns is not an error here: the judge still scores it.
            // Flag it so it is findable in the UI.
            ...(adapted.hitMaxTurns ? { level: 'WARNING', statusMessage: 'hit the turn limit' } : {}),
        },
        startTime: new Date(params.startedAt),
        endTime: new Date(params.endedAt),
        children: [usageNode(params), ...adapted.toolInvocations.map(toolNode)],
    };
}

/**
 * Send a built tree. Each node attaches to the active span when no parent is passed, so
 * calling this inside the experiment task nests the tree under that item's trace.
 */
export function emitObservations(node: ObservationNode, parentSpanContext?: SpanContext): void {
    const options = { startTime: node.startTime, parentSpanContext };
    // Switched rather than passed through: startObservation is overloaded per type and
    // only a literal asType picks the matching overload.
    const observation =
        node.asType === 'agent'
            ? startObservation(node.name, node.attributes, { ...options, asType: 'agent' })
            : node.asType === 'generation'
              ? startObservation(node.name, node.attributes, { ...options, asType: 'generation' })
              : startObservation(node.name, node.attributes, { ...options, asType: 'tool' });

    for (const child of node.children) {
        emitObservations(child, observation.otelSpan.spanContext());
    }

    observation.end(node.endTime);
}
