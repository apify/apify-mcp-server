/**
 * Experiment task and evaluators for the Langfuse workflow-evals port.
 *
 * The experiment runs a fresh agent conversation per test case (MCP state is
 * isolated per test) and scores it with three evaluators: the LLM judge
 * (strict pass/fail gate), total tokens, and tool-result bytes.
 */

import { executeConversation } from './conversation_executor.js';
import type { LlmClient } from './llm_client.js';
import { McpClient } from './mcp_client.js';
import { sumResultBytes } from './output_formatter.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import type { ConversationHistory } from './types.js';
import type { JudgeResult } from './workflow_judge.js';
import { evaluateConversation } from './workflow_judge.js';

/** Output produced by the experiment task for a single test case. */
export type WorkflowTaskOutput = {
    conversation: ConversationHistory;
    judgeResult: JudgeResult;
    /** Set when the conversation could not run (MCP/LLM error). */
    error?: string;
};

/** Evaluation shape returned to Langfuse (a subset of ScoreBody). */
export type WorkflowEvaluation = { name: string; value: number; comment?: string };

/** An experiment data item built from a test case (local array, not a Langfuse dataset). */
export type WorkflowExperimentItem = {
    input: { query: string };
    expectedOutput: string | null;
    metadata: { testCase: WorkflowTestCase };
};

/** Last path segment of a model id, e.g. `claude-haiku-4.5` from `anthropic/claude-haiku-4.5`. */
export function shortModelName(model: string): string {
    const segments = model.split('/');
    return segments[segments.length - 1] || model;
}

/** Experiment run name: `<gitBranch>-<agentModelShort>-<timestamp>`. */
export function buildRunName(gitBranch: string, agentModel: string, now: number): string {
    return `${gitBranch}-${shortModelName(agentModel)}-${now}`;
}

/** Map a test case to a local experiment data item. Pure. */
export function testCaseToExperimentItem(testCase: WorkflowTestCase): WorkflowExperimentItem {
    return {
        input: { query: testCase.query },
        expectedOutput: testCase.reference ?? null,
        metadata: { testCase },
    };
}

/** workflow_judge score: 1 when the judge verdict is PASS, else 0. Strict gate. */
export function scoreJudge(output: WorkflowTaskOutput): WorkflowEvaluation {
    return {
        name: 'workflow_judge',
        value: output.judgeResult.verdict === 'PASS' ? 1 : 0,
        comment: output.error ? `${output.judgeResult.reason} (${output.error})` : output.judgeResult.reason,
    };
}

/** total_tokens score: agent LLM tokens billed across the conversation. */
export function scoreTotalTokens(output: WorkflowTaskOutput): WorkflowEvaluation {
    return { name: 'total_tokens', value: output.conversation.totalTokens ?? 0 };
}

/** result_bytes score: UTF-8 bytes of tool results returned to the agent. */
export function scoreResultBytes(output: WorkflowTaskOutput): WorkflowEvaluation {
    return { name: 'result_bytes', value: sumResultBytes(output.conversation) };
}

/** The evaluators attached to each experiment item. */
export const evaluators = [
    async ({ output }: { output: WorkflowTaskOutput }) => scoreJudge(output),
    async ({ output }: { output: WorkflowTaskOutput }) => scoreTotalTokens(output),
    async ({ output }: { output: WorkflowTaskOutput }) => scoreResultBytes(output),
];

export type WorkflowTaskOptions = {
    llmClient: LlmClient;
    apifyToken: string;
    agentModel: string;
    judgeModel: string;
    toolTimeout: number;
};

/**
 * Build the experiment task. For each item it spins up a fresh isolated
 * McpClient, runs the conversation, then the judge. Errors are captured into
 * the output (verdict FAIL) so the item completes and evaluators still run.
 */
export function makeTask(options: WorkflowTaskOptions) {
    const { llmClient, apifyToken, agentModel, judgeModel, toolTimeout } = options;

    return async (params: { metadata?: unknown }): Promise<WorkflowTaskOutput> => {
        const { testCase } = params.metadata as { testCase: WorkflowTestCase };
        const mcpClient = new McpClient(toolTimeout, testCase.failTools);

        try {
            await mcpClient.start(apifyToken, testCase.tools);
            const serverInstructions = mcpClient.getInstructions();

            const conversation = await executeConversation({
                userPrompt: testCase.query,
                mcpClient,
                llmClient,
                maxTurns: testCase.maxTurns,
                model: agentModel,
                serverInstructions,
            });

            const judgeResult = await evaluateConversation(testCase, conversation, llmClient, judgeModel);
            return { conversation, judgeResult };
        } catch (error) {
            return {
                conversation: {
                    userPrompt: testCase.query,
                    turns: [],
                    completed: false,
                    hitMaxTurns: false,
                    totalTurns: 0,
                },
                judgeResult: { verdict: 'FAIL', reason: 'Error during execution', rawResponse: '' },
                error: error instanceof Error ? error.message : String(error),
            };
        } finally {
            try {
                await mcpClient.cleanup();
            } catch {
                // Best-effort cleanup; a failure here must not fail the item.
            }
        }
    };
}
