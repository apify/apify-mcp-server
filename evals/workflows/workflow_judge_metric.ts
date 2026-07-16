/**
 * Opik scoring metric that wraps the existing workflow judge (workflow_judge.ts).
 * Delegates to evaluateConversation unchanged; maps the verdict to a 0/1 Opik score.
 */

import { BaseMetric, z } from 'opik';
// eslint-disable-next-line import/extensions
import type { EvaluationScoreResult } from 'opik';

import type { LlmClient } from './llm_client.js';
import type { EvaluationResult } from './output_formatter.js';
import { evaluateConversation } from './workflow_judge.js';

/** Opik score name for the workflow judge verdict. */
export const WORKFLOW_JUDGE_SCORE = 'workflow_judge';

// The task records its result in a side channel keyed by test id; the metric only needs the id
// to look it up (the merged scoring input carries the dataset item's testId field).
const WORKFLOW_JUDGE_SCHEMA = z.object({ testId: z.string() });

/**
 * Scores a conversation with the workflow judge. The task stores each conversation in
 * `resultsById`; this metric judges it and writes the verdict back for the results pipeline.
 */
export class WorkflowJudgeMetric extends BaseMetric<typeof WORKFLOW_JUDGE_SCHEMA> {
    readonly validationSchema = WORKFLOW_JUDGE_SCHEMA;

    constructor(
        private readonly resultsById: Map<string, EvaluationResult>,
        private readonly judgeLlm: LlmClient,
        private readonly judgeModel: string,
    ) {
        super(WORKFLOW_JUDGE_SCORE);
    }

    async score(input: unknown): Promise<EvaluationScoreResult> {
        const { testId } = WORKFLOW_JUDGE_SCHEMA.parse(input);
        const collected = this.resultsById.get(testId);

        if (!collected) {
            return { name: WORKFLOW_JUDGE_SCORE, value: 0, reason: `No task result recorded for "${testId}"` };
        }

        // Execution error: the agent never completed, so skip the judge (matches legacy behavior).
        if (collected.error) {
            return { name: WORKFLOW_JUDGE_SCORE, value: 0, reason: collected.judgeResult.reason };
        }

        const judgeResult = await evaluateConversation(
            collected.testCase,
            collected.conversation,
            this.judgeLlm,
            this.judgeModel,
        );
        collected.judgeResult = judgeResult;

        return {
            name: WORKFLOW_JUDGE_SCORE,
            value: judgeResult.verdict === 'PASS' ? 1 : 0,
            reason: judgeResult.reason,
        };
    }
}
