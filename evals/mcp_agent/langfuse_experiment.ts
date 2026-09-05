/**
 * Experiment task, evaluators, and run gate for the Langfuse mcp-agent-evals port.
 *
 * The task runs a fresh Claude Code agent conversation per dataset item (the Agent SDK
 * spawns its own MCP server, so state is isolated per item) and three evaluators score it:
 * the LLM judge, total tokens, and failed server tool calls. The gate is the judge verdict
 * plus zero tool errors, unless the run passes `--allow-tool-errors`.
 */

import type { Evaluation } from '@langfuse/client';

import { runAgentConversation } from './claude_agent.js';
import { parseMcpAgentItem } from './langfuse_dataset.js';
import { buildAgentObservations, emitObservations } from './langfuse_observations.js';
import type { JudgeLlmClient } from './llm_client.js';
import type { JudgeResult } from './mcp_agent_judge.js';
import { evaluateConversation } from './mcp_agent_judge.js';
import type { TranscriptEntry } from './sdk_conversation_adapter.js';

/**
 * Output produced by the experiment task for a single dataset item.
 *
 * The SDK writes whatever the task returns to the item's root span, so this stays a
 * summary: the transcript carries narration and tool names, never the tool payloads,
 * which would otherwise be re-uploaded on top of the tool spans that already hold them.
 */
export type McpAgentTaskOutput = {
    /** Item id, carried here because `ExperimentItemResult.item` is typed as a union without one. */
    id: string;
    judgeResult: JudgeResult;
    /** Agent tokens across the conversation; undefined when the provider never reported usage. */
    totalTokens?: number;
    /** Agent narration, thinking, and tool names per turn. Debug view only, never judged. */
    transcript: TranscriptEntry[];
    /** Failed server tool calls, first error line only, excluding the ones `failTools` injected. */
    toolErrors: { tool: string; error: string }[];
};

/**
 * Score names as they appear in Langfuse.
 *
 * Emitted here and matched by name here, so a typo in either would silently drop an
 * item from the pass count rather than fail.
 */
export const SCORE_NAMES = {
    MCP_AGENT_JUDGE: 'mcp_agent_judge',
    TOTAL_TOKENS: 'total_tokens',
    TOOL_ERRORS: 'tool_errors',
} as const;

type McpAgentEvaluator = (params: { output: McpAgentTaskOutput }) => Promise<Evaluation | Evaluation[]>;

/** The evaluators attached to each experiment item. */
export const evaluators: McpAgentEvaluator[] = [
    async ({ output }) => ({
        name: SCORE_NAMES.MCP_AGENT_JUDGE,
        value: output.judgeResult.verdict === 'PASS' ? 1 : 0,
        comment: output.judgeResult.reason,
    }),
    // No score when the provider never reported usage. A 0 would read as a real
    // measurement and skew cross-run model comparisons in Langfuse.
    async ({ output }) =>
        output.totalTokens === undefined ? [] : [{ name: SCORE_NAMES.TOTAL_TOKENS, value: output.totalTokens }],
    // Always emitted, so a clean item shows an explicit 0 rather than nothing.
    async ({ output }) => ({
        name: SCORE_NAMES.TOOL_ERRORS,
        value: output.toolErrors.length,
        comment: formatToolErrors(output.toolErrors) || undefined,
    }),
];

/** One line per failed call, shared by the score comment and the run summary. */
function formatToolErrors(toolErrors: McpAgentTaskOutput['toolErrors'], separator = '\n'): string {
    return toolErrors.map(({ tool, error }) => `${tool}: ${error}`).join(separator);
}

/** Minimal view of an ExperimentItemResult: what the run gate reads. */
type ScoredItem = { output: McpAgentTaskOutput; evaluations: { name: string; value?: unknown }[] };

/** `undefined` when the judge evaluator itself threw, so no score was emitted. */
function judgeScore(result: ScoredItem): unknown {
    return result.evaluations.find((evaluation) => evaluation.name === SCORE_NAMES.MCP_AGENT_JUDGE)?.value;
}

/** Whether one item passes the gate: judge PASS, plus no tool errors unless the run allows them. */
function itemPassed(result: ScoredItem, allowToolErrors: boolean): boolean {
    return judgeScore(result) === 1 && (allowToolErrors || result.output.toolErrors.length === 0);
}

export function countPassed(itemResults: ScoredItem[], allowToolErrors: boolean): number {
    return itemResults.filter((result) => itemPassed(result, allowToolErrors)).length;
}

export type RunSummary = {
    /** Items that passed the gate. */
    passedCount: number;
    /** Items that completed but did not pass, with the reason. */
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
export function buildRunSummary(
    requestedIds: string[],
    itemResults: ScoredItem[],
    allowToolErrors: boolean,
): RunSummary {
    const failures: { id: string; reason: string }[] = [];

    for (const result of itemResults) {
        if (itemPassed(result, allowToolErrors)) continue;
        const score = judgeScore(result);
        // No score means the evaluator itself threw, so judgeResult.reason is stale - it can
        // hold the judge's PASS rationale, printed under a failure marker. Say what happened.
        let reason: string;
        if (score === undefined) {
            reason = `no ${SCORE_NAMES.MCP_AGENT_JUDGE} score (the evaluator threw)`;
        } else if (score === 1) {
            const { toolErrors } = result.output;
            reason = `judge passed, but ${toolErrors.length} tool error(s): ${formatToolErrors(toolErrors, '; ')}`;
        } else {
            reason = result.output.judgeResult.reason;
        }
        failures.push({ id: result.output.id, reason });
    }

    const completedIds = new Set(itemResults.map((result) => result.output.id));

    return {
        passedCount: countPassed(itemResults, allowToolErrors),
        failures,
        droppedIds: requestedIds.filter((id) => !completedIds.has(id)),
    };
}

/**
 * Messages of failures worth replaying the agent run for: the network or the provider
 * dropped the request, not the agent's own doing.
 *
 * Matched on the message because the SDK surfaces them as plain `Error`s with no code or
 * status. Deliberately narrow: retrying a deterministic failure (a bad prompt, a missing
 * binary, a tool timeout) only doubles the spend and, for a case with fixed-name fixtures,
 * turns the replay itself into a name collision that fails the zero-tool-error gate.
 */
const TRANSIENT_AGENT_ERROR_PATTERNS = [
    /connection error/i,
    /socket hang up/i,
    /fetch failed/i,
    /network/i,
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN/,
    /\b(408|429|500|502|503|504)\b/,
    /overloaded/i,
    /rate.?limit/i,
];

/** Whether an agent-run failure is transient, so replaying the prompt could recover it. */
export function isTransientAgentError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return TRANSIENT_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export type McpAgentTaskOptions = {
    llmClient: JudgeLlmClient;
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
 * The agent run survives one retry on a transient failure. Judge API errors are retried by the
 * OpenAI SDK itself (maxRetries 2, exponential backoff); this layer retries the judge only
 * on a malformed answer, see mcp_agent_judge.ts. Anything else is left to throw, so
 * `buildRunSummary` fails the run on the shortfall instead of a broken harness looking like
 * a failing eval. Errors are prefixed with the item id because the SDK's own log line
 * carries none.
 */
export function makeTask(options: McpAgentTaskOptions) {
    const { llmClient, apifyToken, agentModel, judgeModel, toolTimeout, mcpToolsOnly } = options;

    return async (rawItem: unknown): Promise<McpAgentTaskOutput> => {
        const item = parseMcpAgentItem(rawItem);

        try {
            const runOptions = {
                prompt: item.input.query,
                model: agentModel,
                apifyToken,
                tools: item.metadata.tools,
                failTools: item.metadata.failTools,
                maxTurns: item.metadata.maxTurns,
                toolTimeoutSeconds: toolTimeout,
                mcpToolsOnly,
            };
            let startedAt = Date.now();
            let adapted;
            try {
                adapted = await runAgentConversation(runOptions);
            } catch (error) {
                // Transient SDK/API failures ("Connection error.") drop the whole item from
                // the run. One retry absorbs them; a persistent failure still throws below.
                // The retry replays the whole prompt, so tool calls that already succeeded run
                // again: a case with fixed-name fixtures can hit a name collision the second
                // time round and fail the zero-tool-error gate. That cost only buys something
                // for a transient failure, so anything else is rethrown unretried.
                if (!isTransientAgentError(error)) throw error;
                // eslint-disable-next-line no-console
                console.error(
                    `⚠️ Item "${item.id}": agent run failed (${error instanceof Error ? error.message : String(error)}), retrying once`,
                );
                startedAt = Date.now();
                adapted = await runAgentConversation(runOptions);
            }

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
            // Guaranteed by parseMcpAgentItem's kind/expectedOutput cross-check for kind:
            // "agent" items; this task does not run kind: "selection" items (no conversation
            // to have here), so a missing expectedOutput at this point is a caller bug.
            if (item.expectedOutput === undefined) {
                throw new Error(
                    `kind "${item.metadata.kind}" item has no expectedOutput; this task only runs agent items`,
                );
            }
            const judgeResult = await evaluateConversation(item.expectedOutput, conversation, llmClient, judgeModel);

            // Server tools only: a failed Claude Code built-in (Bash, WebFetch) says nothing
            // about the server under test. Failures of tools the harness force-failed itself
            // are not errors of the run either. First line only: the full text already sits
            // on the tool span. Known blind spot: the adapter drops subagent activity, so a
            // server tool failing inside a Task-spawned subagent never reaches this gate.
            const injected = new Set(item.metadata.failTools ?? []);
            const toolErrors = adapted.toolInvocations
                .filter(
                    (invocation) =>
                        invocation.isMcpTool && !invocation.result.success && !injected.has(invocation.name),
                )
                .map((invocation) => ({
                    tool: invocation.name,
                    error: invocation.result.error?.split('\n')[0] || 'unknown error',
                }));

            return {
                id: item.id,
                judgeResult,
                totalTokens: conversation.totalTokens,
                transcript,
                toolErrors,
            };
        } catch (error) {
            throw new Error(`Item "${item.id}": ${error instanceof Error ? error.message : String(error)}`, {
                cause: error,
            });
        }
    };
}
