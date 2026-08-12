/**
 * Experiment task, evaluators, and run gate for the Langfuse workflow-evals port.
 *
 * The task runs a fresh Claude Code agent conversation per dataset item (the Agent SDK
 * spawns its own MCP server, so state is isolated per item) and two evaluators score it:
 * the LLM judge (the pass/fail gate) and total tokens.
 */

import type { Evaluation } from '@langfuse/client';

import { runAgentConversation } from './claude_agent.js';
import { parseWorkflowItem } from './langfuse_dataset.js';
import { buildAgentObservations, emitObservations } from './langfuse_observations.js';
import type { LlmClient } from './llm_client.js';
import type { TranscriptEntry } from './sdk_conversation_adapter.js';
import type { JudgeResult } from './workflow_judge.js';
import { evaluateConversation } from './workflow_judge.js';

/**
 * Output produced by the experiment task for a single dataset item.
 *
 * A summary, not the transcript: the SDK writes whatever the task returns to the item's
 * root span, so returning conversations would re-upload every tool payload.
 */
export type WorkflowTaskOutput = {
    /** Item id, carried here because `ExperimentItemResult.item` is typed as a union without one. */
    id: string;
    judgeResult: JudgeResult;
    /** Agent tokens across the conversation; undefined when the provider never reported usage. */
    totalTokens?: number;
    /** Agent narration, thinking, and tool names per turn. Debug view only, never judged. */
    transcript: TranscriptEntry[];
};

/**
 * Score names as they appear in Langfuse.
 *
 * Emitted here and matched by name here, so a typo in either would silently drop an
 * item from the pass count rather than fail.
 */
export const SCORE_NAMES = {
    WORKFLOW_JUDGE: 'workflow_judge',
    TOTAL_TOKENS: 'total_tokens',
} as const;

type WorkflowEvaluator = (params: { output: WorkflowTaskOutput }) => Promise<Evaluation | Evaluation[]>;

/** The evaluators attached to each experiment item. */
export const evaluators: WorkflowEvaluator[] = [
    async ({ output }) => ({
        name: SCORE_NAMES.WORKFLOW_JUDGE,
        value: output.judgeResult.verdict === 'PASS' ? 1 : 0,
        comment: output.judgeResult.reason,
    }),
    // No score when the provider never reported usage. A 0 would read as a real
    // measurement and skew cross-run model comparisons in Langfuse.
    async ({ output }) =>
        output.totalTokens === undefined ? [] : [{ name: SCORE_NAMES.TOTAL_TOKENS, value: output.totalTokens }],
];

/** Minimal view of an ExperimentItemResult: what the run gate reads. */
type ScoredItem = { output: WorkflowTaskOutput; evaluations: { name: string; value?: unknown }[] };

/** Items that scored `workflow_judge === 1`. */
export function countPassed(itemResults: ScoredItem[]): number {
    return itemResults.filter(
        (result) =>
            result.evaluations.find((evaluation) => evaluation.name === SCORE_NAMES.WORKFLOW_JUDGE)?.value === 1,
    ).length;
}

export type RunSummary = {
    /** Items that scored workflow_judge === 1. */
    passedCount: number;
    /** Items that completed but did not pass, with the judge's reason. */
    failures: { id: string; reason: string }[];
    /** Requested ids with no result at all: the task threw and the SDK skipped the item. */
    droppedIds: string[];
};

/**
 * Score a finished experiment against the ids that were requested.
 *
 * The requested ids are the denominator on purpose: the SDK omits an item whose task
 * threw, so gating on `itemResults.length` would report "7/7 passed" on a run where
 * three tests never executed.
 */
export function buildRunSummary(requestedIds: string[], itemResults: ScoredItem[]): RunSummary {
    const failures: { id: string; reason: string }[] = [];

    for (const result of itemResults) {
        const judgeScore = result.evaluations.find(
            (evaluation) => evaluation.name === SCORE_NAMES.WORKFLOW_JUDGE,
        )?.value;
        if (judgeScore === 1) continue;
        // No score means the evaluator itself threw, so judgeResult.reason is stale - it can
        // hold the judge's PASS rationale, printed under a failure marker. Say what happened.
        failures.push({
            id: result.output.id,
            reason:
                judgeScore === undefined
                    ? `no ${SCORE_NAMES.WORKFLOW_JUDGE} score (the evaluator threw)`
                    : result.output.judgeResult.reason,
        });
    }

    const completedIds = new Set(itemResults.map((result) => result.output.id));

    return {
        passedCount: countPassed(itemResults),
        failures,
        droppedIds: requestedIds.filter((id) => !completedIds.has(id)),
    };
}

export type WorkflowTaskOptions = {
    llmClient: LlmClient;
    apifyToken: string;
    agentModel: string;
    judgeModel: string;
    toolTimeout: number;
    /** Restrict the agent to MCP tools only, dropping Claude Code's built-in toolset. */
    mcpToolsOnly: boolean;
};

/**
 * Build the experiment task: per dataset item, a Claude Code agent run against its own
 * freshly spawned MCP server, then the judge.
 *
 * Harness errors (MCP spawn, Anthropic API, OpenRouter, judge) are left to throw, so
 * `buildRunSummary` fails the run on the shortfall instead of a broken harness looking
 * like a failing eval. They are prefixed with the item id because the SDK's own log line
 * carries none.
 */
export function makeTask(options: WorkflowTaskOptions) {
    const { llmClient, apifyToken, agentModel, judgeModel, toolTimeout, mcpToolsOnly } = options;

    return async (rawItem: unknown): Promise<WorkflowTaskOutput> => {
        const item = parseWorkflowItem(rawItem);

        try {
            const startedAt = Date.now();
            const adapted = await runAgentConversation({
                prompt: item.input.query,
                model: agentModel,
                apifyToken,
                tools: item.metadata.tools,
                failTools: item.metadata.failTools,
                maxTurns: item.metadata.maxTurns,
                toolTimeoutSeconds: toolTimeout,
                mcpToolsOnly,
            });

            // The agent ran in a subprocess, so its conversation reaches Langfuse only if
            // we send it. Emitted before the judge call, so a failing judge still leaves
            // the conversation on the trace to debug.
            emitObservations(
                buildAgentObservations({
                    prompt: item.input.query,
                    model: agentModel,
                    mcpToolsOnly,
                    adapted,
                    startedAt,
                    endedAt: Date.now(),
                }),
            );

            const { conversation, transcript } = adapted;
            const judgeResult = await evaluateConversation(item.expectedOutput, conversation, llmClient, judgeModel);

            return {
                id: item.id,
                judgeResult,
                totalTokens: conversation.totalTokens,
                transcript,
            };
        } catch (error) {
            throw new Error(`Item "${item.id}": ${error instanceof Error ? error.message : String(error)}`, {
                cause: error,
            });
        }
    };
}
