/**
 * Experiment task, evaluators, and run gate for the Langfuse workflow-evals port.
 *
 * The task runs a fresh agent conversation per dataset item (MCP state is isolated
 * per item) and two evaluators score it: the LLM judge (the pass/fail gate) and
 * total tokens.
 */

import type { Evaluation } from '@langfuse/client';

import { executeConversation } from './conversation_executor.js';
import { parseWorkflowItem } from './langfuse_dataset.js';
import type { LlmClient } from './llm_client.js';
import { McpClient } from './mcp_client.js';
import type { JudgeResult } from './workflow_judge.js';
import { evaluateConversation } from './workflow_judge.js';

/**
 * Output produced by the experiment task for a single dataset item.
 *
 * A summary, not the transcript: the SDK writes whatever the task returns to the
 * item's root span, and returning every conversation would upload each tool payload
 * again and hold all transcripts in memory until the run ends.
 */
export type WorkflowTaskOutput = {
    /**
     * Dataset item id, so the run summary can name items. Carried here rather than read
     * from `ExperimentItemResult.item`: the SDK types that as a union whose non-dataset
     * branch declares no `id`, so reading it would need an unchecked cast.
     */
    id: string;
    judgeResult: JudgeResult;
    /** Agent tokens across the conversation; undefined when the provider never reported usage. */
    totalTokens?: number;
};

type WorkflowEvaluator = (params: { output: WorkflowTaskOutput }) => Promise<Evaluation | Evaluation[]>;

/** The evaluators attached to each experiment item. */
export const evaluators: WorkflowEvaluator[] = [
    async ({ output }) => ({
        name: 'workflow_judge',
        value: output.judgeResult.verdict === 'PASS' ? 1 : 0,
        comment: output.judgeResult.reason,
    }),
    // No score when the provider never reported usage. A 0 would read as a real
    // measurement and skew cross-run model comparisons in Langfuse.
    async ({ output }) =>
        output.totalTokens === undefined ? [] : [{ name: 'total_tokens', value: output.totalTokens }],
];

/** Minimal view of an ExperimentItemResult: what the run gate reads. */
type ScoredItem = { output: WorkflowTaskOutput; evaluations: { name: string; value?: unknown }[] };

/** Items that scored `workflow_judge === 1`. */
export function countPassed(itemResults: ScoredItem[]): number {
    return itemResults.filter(
        (result) => result.evaluations.find((evaluation) => evaluation.name === 'workflow_judge')?.value === 1,
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
 * The requested ids are the denominator on purpose. When a task throws, the SDK
 * logs it and omits the item from `itemResults`, so gating on `itemResults.length`
 * would report "7/7 passed" and exit 0 on a run where three tests never executed.
 */
export function buildRunSummary(requestedIds: string[], itemResults: ScoredItem[]): RunSummary {
    const failures: { id: string; reason: string }[] = [];

    for (const result of itemResults) {
        const judgeScore = result.evaluations.find((evaluation) => evaluation.name === 'workflow_judge')?.value;
        if (judgeScore === 1) continue;
        // No score means the evaluator itself threw, so judgeResult.reason is stale - it can
        // hold the judge's PASS rationale, printed under a failure marker. Say what happened.
        failures.push({
            id: result.output.id,
            reason:
                judgeScore === undefined
                    ? 'no workflow_judge score (the evaluator threw)'
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
};

/**
 * Build the experiment task. For each dataset item it spins up a fresh isolated
 * McpClient, runs the conversation, then the judge.
 *
 * Harness errors (MCP spawn, OpenRouter, judge) are left to throw. The SDK logs
 * them and drops the item, and `buildRunSummary` fails the run on the shortfall,
 * so a broken harness no longer masquerades as a failing eval. They are rethrown
 * prefixed with the item id first: the SDK's own log line carries none, and at
 * concurrency 4 the operator otherwise gets interleaved anonymous errors that
 * cannot be paired with the "Never completed" list.
 */
export function makeTask(options: WorkflowTaskOptions) {
    const { llmClient, apifyToken, agentModel, judgeModel, toolTimeout } = options;

    return async (rawItem: unknown): Promise<WorkflowTaskOutput> => {
        const item = parseWorkflowItem(rawItem);
        const mcpClient = new McpClient(toolTimeout, item.metadata.failTools);

        try {
            await mcpClient.start(apifyToken, item.metadata.tools);

            const conversation = await executeConversation({
                userPrompt: item.input.query,
                mcpClient,
                llmClient,
                maxTurns: item.metadata.maxTurns,
                model: agentModel,
                serverInstructions: mcpClient.getInstructions(),
            });

            const judgeResult = await evaluateConversation(item.expectedOutput, conversation, llmClient, judgeModel);

            return {
                id: item.id,
                judgeResult,
                totalTokens: conversation.totalTokens,
            };
        } catch (error) {
            throw new Error(`Item "${item.id}": ${error instanceof Error ? error.message : String(error)}`, {
                cause: error,
            });
        } finally {
            // cleanup() races a 2s close then SIGKILLs, but it can still reject, and a
            // rejection here would replace the item's real result. Log and move on.
            await mcpClient.cleanup().catch((error) => {
                // eslint-disable-next-line no-console
                console.warn(`⚠️  MCP cleanup failed for "${item.id}": ${error}`);
            });
        }
    };
}
