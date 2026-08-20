/**
 * Experiment task, evaluators, and run gate for the Langfuse workflow-evals port.
 *
 * The task runs a fresh Claude Code agent conversation per dataset item (the Agent SDK
 * spawns its own MCP server, so state is isolated per item) and the evaluators score it:
 * the judge's overall verdict (the pass/fail gate), one score per rubric dimension, and
 * total tokens.
 */

import type { Evaluation } from '@langfuse/client';

import { runAgentConversation } from './claude_agent.js';
import { parseWorkflowItem } from './langfuse_dataset.js';
import { buildAgentObservations, emitObservations } from './langfuse_observations.js';
import type { LlmClient } from './llm_client.js';
import type { TranscriptEntry } from './sdk_conversation_adapter.js';
import type { Dimension, JudgeResult, RubricResult } from './workflow_judge.js';
import { DIMENSIONS, evaluateConversation } from './workflow_judge.js';

/**
 * Output produced by the experiment task for a single dataset item.
 *
 * The SDK writes whatever the task returns to the item's root span, so this stays a
 * summary: the transcript carries narration and tool names, never the tool payloads,
 * which would otherwise be re-uploaded on top of the tool spans that already hold them.
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

/**
 * Score name per rubric dimension.
 *
 * `rubric_task_completion` repeats `workflow_judge` by design: the gate keeps its own
 * name and its own history, so runs from before the rubric stay comparable.
 */
export const DIMENSION_SCORE_NAMES: Record<Dimension, string> = {
    toolSelection: 'rubric_tool_selection',
    argumentCorrectness: 'rubric_argument_correctness',
    resultUtilization: 'rubric_result_utilization',
    taskCompletion: 'rubric_task_completion',
    errorRecovery: 'rubric_error_recovery',
    planEfficiency: 'rubric_plan_efficiency',
};

type WorkflowEvaluator = (params: { output: WorkflowTaskOutput }) => Promise<Evaluation | Evaluation[]>;

/** The evaluators attached to each experiment item. */
export const evaluators: WorkflowEvaluator[] = [
    async ({ output }) => ({
        name: SCORE_NAMES.WORKFLOW_JUDGE,
        value: output.judgeResult.overallVerdict === 'PASS' ? 1 : 0,
        comment: output.judgeResult.rubric.taskCompletion.reason,
    }),
    // One score per dimension, so Langfuse can chart which capability moved between runs
    // rather than only whether the item passed.
    async ({ output }) =>
        DIMENSIONS.map((dimension) => {
            const { verdict, reason } = output.judgeResult.rubric[dimension];
            return { name: DIMENSION_SCORE_NAMES[dimension], value: verdict === 'PASS' ? 1 : 0, comment: reason };
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
    /** Every completed item's rubric, in result order, for the per-test console line. */
    rubrics: { id: string; overallVerdict: 'PASS' | 'FAIL'; rubric: RubricResult }[];
    /** Passing items per dimension, over the items that completed. */
    dimensionPassCounts: Record<Dimension, number>;
    /** Items the dimension counts are out of: completed items, not requested ones. */
    scoredCount: number;
};

/** Passing items per dimension across the completed items. */
export function countDimensionPasses(itemResults: ScoredItem[]): Record<Dimension, number> {
    const counts = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0])) as Record<Dimension, number>;

    for (const result of itemResults) {
        for (const dimension of DIMENSIONS) {
            if (result.output.judgeResult.rubric[dimension].verdict === 'PASS') counts[dimension] += 1;
        }
    }

    return counts;
}

/** Short label per dimension for the compact console line. */
const DIMENSION_LABELS: Record<Dimension, string> = {
    toolSelection: 'tool',
    argumentCorrectness: 'args',
    resultUtilization: 'result',
    taskCompletion: 'complete',
    errorRecovery: 'recover',
    planEfficiency: 'eff',
};

/** All six verdicts on one line, e.g. `tool✓ args✓ result✗ complete✓ recover✓ eff✓`. */
export function formatRubricGlyphs(rubric: RubricResult): string {
    return DIMENSIONS.map(
        (dimension) => `${DIMENSION_LABELS[dimension]}${rubric[dimension].verdict === 'PASS' ? '✓' : '✗'}`,
    ).join(' ');
}

/**
 * Run-level pass rate per dimension, so a run carries its own rubric profile and Langfuse
 * can diff two runs dimension by dimension.
 *
 * Denominator is the requested count, matching `pass_rate`: an item the SDK dropped pulls
 * every dimension down rather than vanishing from the rate.
 */
export function buildDimensionRunScores(requestedCount: number, itemResults: ScoredItem[]): Evaluation[] {
    const counts = countDimensionPasses(itemResults);

    return DIMENSIONS.map((dimension) => ({
        name: `pass_rate_${DIMENSION_SCORE_NAMES[dimension].replace(/^rubric_/, '')}`,
        value: counts[dimension] / requestedCount,
    }));
}

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
                    : result.output.judgeResult.rubric.taskCompletion.reason,
        });
    }

    const completedIds = new Set(itemResults.map((result) => result.output.id));

    return {
        passedCount: countPassed(itemResults),
        failures,
        droppedIds: requestedIds.filter((id) => !completedIds.has(id)),
        rubrics: itemResults.map((result) => ({
            id: result.output.id,
            overallVerdict: result.output.judgeResult.overallVerdict,
            rubric: result.output.judgeResult.rubric,
        })),
        dimensionPassCounts: countDimensionPasses(itemResults),
        scoredCount: itemResults.length,
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
            // the conversation on the trace to debug. Guarded separately from the run
            // itself: losing the trace costs debuggability, not the item's result. Only
            // catches building the spans - the export happens later, in the span
            // processor's batch flush, and never reaches here.
            try {
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
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(
                    `⚠️ Item "${item.id}": emitting the agent trace failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }

            const { conversation, transcript } = adapted;
            const judgeResult = await evaluateConversation({
                reference: item.expectedOutput,
                expectedTools: item.metadata.expectedTools,
                conversation,
                llmClient,
                judgeModel,
            });

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
