/**
 * Experiment task, evaluators, and run gate for the Langfuse mcp-agent-evals port.
 *
 * Dispatches per item on `metadata.kind`. A `kind: "agent"` item runs a fresh Claude Code
 * agent conversation (the Agent SDK spawns its own MCP server, so state is isolated per
 * item), then the LLM judge and the zero-tool-error gate (exempting tools named in the
 * item's `expectedErrors`). A `kind: "selection"` item runs the same agent under a
 * deny-all hook - nothing executes, no judge runs - and is scored on `first_tool_match`
 * alone: does the first attempted tool call match `expectedTools`/`expectedArgs`.
 */

import type { Evaluation } from '@langfuse/client';

import type { AgentRunResult } from './claude_agent.js';
import { runAgentConversation } from './claude_agent.js';
import type { DatasetItem, McpAgentItem } from './langfuse_dataset.js';
import { parseMcpAgentItem } from './langfuse_dataset.js';
import { buildAgentObservations, emitObservations } from './langfuse_observations.js';
import type { JudgeLlmClient } from './llm_client.js';
import type { JudgeResult } from './mcp_agent_judge.js';
import { evaluateConversation } from './mcp_agent_judge.js';
import type { TranscriptEntry } from './sdk_conversation_adapter.js';
import { resolveFirstToolMatch } from './selection_mode.js';

/** One failed server tool call. `expected` is true when the item's `expectedErrors` names it. */
export type ToolError = { tool: string; error: string; expected: boolean };

/**
 * Output produced by the experiment task for a single dataset item, discriminated by
 * `kind` so an agent-only field (the judge result, tool errors) or a selection-only field
 * (`firstToolMatch`) can never be read against the wrong kind of result.
 *
 * The SDK writes whatever the task returns to the item's root span, so this stays a
 * summary: the transcript carries narration and tool names, never the tool payloads,
 * which would otherwise be re-uploaded on top of the tool spans that already hold them.
 */
export type McpAgentTaskOutput =
    | {
          kind: 'agent';
          /** Item id, carried here because `ExperimentItemResult.item` is typed as a union without one. */
          id: string;
          /** `--iterations` trial index (1-based); absent when the run requested only one. */
          iteration?: number;
          judgeResult: JudgeResult;
          /** Agent tokens across the conversation; undefined when the provider never reported usage. */
          totalTokens?: number;
          /** Agent narration, thinking, and tool names per turn. Debug view only, never judged. */
          transcript: TranscriptEntry[];
          /** Every failed server tool call, first error line only; `expected` marks `expectedErrors` tools. */
          toolErrors: ToolError[];
      }
    | {
          kind: 'selection';
          id: string;
          iteration?: number;
          /** Whether the first attempted (non-`ToolSearch`) call matched, and why. */
          firstToolMatch: { isMatch: boolean; comment: string };
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
    FIRST_TOOL_MATCH: 'first_tool_match',
} as const;

type McpAgentEvaluator = (params: { output: McpAgentTaskOutput }) => Promise<Evaluation | Evaluation[]>;

/** One line per failed call, shared by the score comment and the run summary. */
function formatToolErrors(toolErrors: ToolError[], separator = '\n'): string {
    return toolErrors
        .map(({ tool, error, expected }) => `${tool}: ${error}${expected ? ' (expected)' : ''}`)
        .join(separator);
}

/** The evaluators attached to each experiment item. */
export const evaluators: McpAgentEvaluator[] = [
    // Judge verdict: agent items only.
    async ({ output }) =>
        output.kind === 'agent'
            ? {
                  name: SCORE_NAMES.MCP_AGENT_JUDGE,
                  value: output.judgeResult.verdict === 'PASS' ? 1 : 0,
                  comment: output.judgeResult.reason,
              }
            : [],
    // No score when the provider never reported usage. A 0 would read as a real
    // measurement and skew cross-run model comparisons in Langfuse.
    async ({ output }) =>
        output.kind === 'agent' && output.totalTokens !== undefined
            ? [{ name: SCORE_NAMES.TOTAL_TOKENS, value: output.totalTokens }]
            : [],
    // Value is the count of UNEXPECTED failures (the gate number); the comment lists every
    // failed call, expected ones marked, so a passing item's spans still read as truthful.
    async ({ output }) =>
        output.kind === 'agent'
            ? {
                  name: SCORE_NAMES.TOOL_ERRORS,
                  value: output.toolErrors.filter((error) => !error.expected).length,
                  comment: formatToolErrors(output.toolErrors) || undefined,
              }
            : [],
    // Selection items only: nothing executes, so there is no judge and no tool_errors.
    async ({ output }) =>
        output.kind === 'selection'
            ? {
                  name: SCORE_NAMES.FIRST_TOOL_MATCH,
                  value: output.firstToolMatch.isMatch ? 1 : 0,
                  comment: output.firstToolMatch.comment,
              }
            : [],
];

/** Minimal view of an ExperimentItemResult: what the run gate reads. */
type ScoredItem = { output: McpAgentTaskOutput; evaluations: { name: string; value?: unknown }[] };

function scoreValue(result: ScoredItem, name: string): unknown {
    return result.evaluations.find((evaluation) => evaluation.name === name)?.value;
}

/** Whether one item passes its gate: `first_tool_match` for selection, judge + zero unexpected tool errors for agent. */
function itemPassed(result: ScoredItem): boolean {
    if (result.output.kind === 'selection') {
        return scoreValue(result, SCORE_NAMES.FIRST_TOOL_MATCH) === 1;
    }
    return (
        scoreValue(result, SCORE_NAMES.MCP_AGENT_JUDGE) === 1 &&
        result.output.toolErrors.every((error) => error.expected)
    );
}

/** Why one item's trial did not pass, for the failure line in the run summary. */
function failureReason(result: ScoredItem): string {
    const { output } = result;
    if (output.kind === 'selection') {
        const score = scoreValue(result, SCORE_NAMES.FIRST_TOOL_MATCH);
        if (score === undefined) return `no ${SCORE_NAMES.FIRST_TOOL_MATCH} score (the evaluator threw)`;
        return `${SCORE_NAMES.FIRST_TOOL_MATCH} 0 — ${output.firstToolMatch.comment}`;
    }

    const score = scoreValue(result, SCORE_NAMES.MCP_AGENT_JUDGE);
    // No score means the evaluator itself threw, so judgeResult.reason is stale - it can
    // hold the judge's PASS rationale, printed under a failure marker. Say what happened.
    if (score === undefined) return `no ${SCORE_NAMES.MCP_AGENT_JUDGE} score (the evaluator threw)`;
    if (score === 1) {
        const unexpected = output.toolErrors.filter((error) => !error.expected);
        return `judge passed, but ${unexpected.length} unexpected tool error(s): ${formatToolErrors(unexpected, '; ')}`;
    }
    return output.judgeResult.reason;
}

export type RunSummary = {
    /** One entry per requested id, its trials in iteration order (1..iterations). */
    items: { id: string; trials: { iteration: number; passed: boolean }[] }[];
    /** Trials that passed the gate. */
    passedTrials: number;
    /** `requestedIds.length * iterations` - the fixed denominator, dropped trials included. */
    requestedTrials: number;
    /** `passedTrials / requestedTrials`, 0 when nothing was requested. */
    passRate: number;
    /** Items where at least one trial passed (pass@k). */
    passAtK: number;
    /** Items where every trial passed (pass^k). */
    passHatK: number;
    /** Trials that completed but did not pass, with the reason. */
    failures: { id: string; iteration: number; reason: string }[];
    /** Requested (id, iteration) trials with no result at all: the task threw. */
    droppedTrials: { id: string; iteration: number }[];
};

/**
 * Score a finished experiment against the ids and iteration count that were requested.
 *
 * A repeated item keeps the same dataset id across trials (Langfuse has no per-trial id),
 * distinguished only by `output.iteration` - so the denominator is computed from
 * `requestedIds.length * iterations`, not `itemResults.length`: the SDK omits an item whose
 * task threw, and a naive count would silently shrink the rate instead of reporting the gap.
 */
export function buildRunSummary(requestedIds: string[], itemResults: ScoredItem[], iterations: number): RunSummary {
    const byId = new Map<string, Map<number, ScoredItem>>();
    for (const result of itemResults) {
        const { id } = result.output;
        const byIteration = byId.get(id) ?? new Map<number, ScoredItem>();
        byIteration.set(result.output.iteration ?? 1, result);
        byId.set(id, byIteration);
    }

    const items: RunSummary['items'] = [];
    const failures: RunSummary['failures'] = [];
    const droppedTrials: RunSummary['droppedTrials'] = [];
    let passedTrials = 0;
    let passAtK = 0;
    let passHatK = 0;

    for (const id of requestedIds) {
        const byIteration = byId.get(id) ?? new Map<number, ScoredItem>();
        const trials: { iteration: number; passed: boolean }[] = [];
        let anyPassed = false;
        let allPassed = true;

        for (let iteration = 1; iteration <= iterations; iteration++) {
            const result = byIteration.get(iteration);
            if (!result) {
                droppedTrials.push({ id, iteration });
                allPassed = false;
                trials.push({ iteration, passed: false });
                continue;
            }

            const passed = itemPassed(result);
            trials.push({ iteration, passed });
            if (passed) {
                passedTrials++;
                anyPassed = true;
            } else {
                allPassed = false;
                failures.push({ id, iteration, reason: failureReason(result) });
            }
        }

        if (anyPassed) passAtK++;
        if (allPassed) passHatK++;
        items.push({ id, trials });
    }

    const requestedTrials = requestedIds.length * iterations;
    return {
        items,
        passedTrials,
        requestedTrials,
        passRate: requestedTrials > 0 ? passedTrials / requestedTrials : 0,
        passAtK,
        passHatK,
        failures,
        droppedTrials,
    };
}

/** The gate: `0` while the aggregate pass rate meets the threshold, `1` otherwise. */
export function resolveExitCode(summary: RunSummary, passThreshold: number): number {
    return summary.passRate >= passThreshold ? 0 : 1;
}

/** One dataset item repeated for `--iterations`, tagged with its 1-based trial index. */
function withIteration(item: DatasetItem, iteration: number): DatasetItem {
    return { ...item, metadata: { ...(item.metadata as Record<string, unknown> | undefined), iteration } };
}

/**
 * `--iterations N`: repeat each selected item N times into the flat `data` array a single
 * `experiment.run()` call takes, each repeat a shallow copy tagged `metadata.iteration`
 * (1-based). The Langfuse v4 API has no native iteration concept, so this is what turns one
 * requested item into `N` separately-scored trials without a second `experiment.run()` call.
 */
export function expandIterations(items: DatasetItem[], iterations: number): DatasetItem[] {
    return items.flatMap((item) => Array.from({ length: iterations }, (_, index) => withIteration(item, index + 1)));
}

/** `--iterations` must be a positive integer: anything else can't index a 1-based trial run. */
export function validateIterations(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--iterations must be a positive integer, got "${value}"`);
    }
}

/** `--pass-threshold` gates a rate (`passedTrials / requestedTrials`), so it must fall in [0, 1]. */
export function validatePassThreshold(value: number): void {
    if (value < 0 || value > 1) {
        throw new Error(`--pass-threshold must be between 0 and 1, got "${value}"`);
    }
}

/** One line of run-summary output, tagged with the console stream it belongs on. */
export type RunSummaryLine = { stream: 'log' | 'error'; text: string };

/**
 * Console lines for a finished run, in print order: per-item trial outcomes (`🔁`, only when
 * `iterations > 1`), one `❌` line per failed trial, a `🔥` line for trials the SDK dropped
 * (stderr, since the failure detail already went to stderr above it), the `📊` pass-rate
 * line, and `📈` pass@k/pass^k (only when `iterations > 1`). Pure so the CLI's print block is
 * just "loop over this and route each line to its stream".
 */
export function formatRunSummary(summary: RunSummary, passThreshold: number, iterations: number): RunSummaryLine[] {
    const lines: RunSummaryLine[] = [];

    if (iterations > 1) {
        for (const item of summary.items) {
            const outcomes = item.trials.map((trial) => (trial.passed ? '✅' : '❌')).join(' ');
            const anyPassed = item.trials.some((trial) => trial.passed);
            const allPassed = item.trials.every((trial) => trial.passed);
            lines.push({
                stream: 'log',
                text:
                    `🔁 ${item.id}   ${outcomes}   pass@${iterations} ${anyPassed ? '✅' : '❌'}  ` +
                    `pass^${iterations} ${allPassed ? '✅' : '❌'}`,
            });
        }
    }

    for (const failure of summary.failures) {
        const iterationSuffix = iterations > 1 ? ` (iteration ${failure.iteration})` : '';
        lines.push({ stream: 'log', text: `❌ ${failure.id}${iterationSuffix}: ${failure.reason}` });
    }

    if (summary.droppedTrials.length > 0) {
        const dropped = summary.droppedTrials.map(
            ({ id, iteration }) => `${id}${iterations > 1 ? ` (iteration ${iteration})` : ''}`,
        );
        lines.push({
            stream: 'error',
            text: `🔥 Never completed (task threw, see errors above): ${dropped.join(', ')}`,
        });
    }

    lines.push({
        stream: 'log',
        text:
            `📊 ${summary.passedTrials}/${summary.requestedTrials} trials passed ` +
            `(pass_rate ${summary.passRate.toFixed(2)}, threshold ${passThreshold.toFixed(2)})`,
    });
    if (iterations > 1) {
        lines.push({
            stream: 'log',
            text:
                `📈 pass@${iterations} ${summary.passAtK}/${summary.items.length} items · ` +
                `pass^${iterations} ${summary.passHatK}/${summary.items.length} items`,
        });
    }

    return lines;
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
 * Run the agent once, retrying on a transient failure. The retry replays the whole prompt,
 * so tool calls that already succeeded run again: a case with fixed-name fixtures can hit a
 * name collision the second time round and fail the zero-tool-error gate. That cost only
 * buys something for a transient failure, so anything else is rethrown unretried.
 */
async function runAgentWithRetry(
    itemId: string,
    runOptions: Parameters<typeof runAgentConversation>[0],
): Promise<{ adapted: AgentRunResult; startedAt: number }> {
    let startedAt = Date.now();
    try {
        return { adapted: await runAgentConversation(runOptions), startedAt };
    } catch (error) {
        if (!isTransientAgentError(error)) throw error;
        // eslint-disable-next-line no-console
        console.error(
            `⚠️ Item "${itemId}": agent run failed (${error instanceof Error ? error.message : String(error)}), retrying once`,
        );
        startedAt = Date.now();
        return { adapted: await runAgentConversation(runOptions), startedAt };
    }
}

/**
 * The agent ran in a subprocess, so its conversation reaches Langfuse only if we send it.
 * Guarded separately from the run itself: losing the trace costs debuggability, not the
 * item's result. A selection item's denied calls still show as ERROR tool spans here - see
 * the README - because nothing about a `PreToolUse` denial changes how the adapter pairs a
 * `tool_use`/`tool_result`.
 */
function emitTrace(
    itemId: string,
    query: string,
    agentModel: string,
    mcpToolsOnly: boolean,
    adapted: AgentRunResult,
    startedAt: number,
): void {
    try {
        emitObservations(
            buildAgentObservations({
                prompt: query,
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
            `⚠️ Item "${itemId}": emitting the agent trace failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Build the experiment task: per dataset item, a Claude Code agent run against its own
 * freshly spawned MCP server.
 *
 * Errors are prefixed with the item id because the SDK's own log line carries none.
 */
export function makeTask(options: McpAgentTaskOptions) {
    const { llmClient, apifyToken, agentModel, judgeModel, toolTimeout, mcpToolsOnly } = options;

    return async (rawItem: unknown): Promise<McpAgentTaskOutput> => {
        const item = parseMcpAgentItem(rawItem);
        const { iteration } = item.metadata;
        const itemMcpToolsOnly = mcpToolsOnly || (item.metadata.mcpToolsOnly ?? false);

        try {
            if (item.metadata.kind === 'selection') {
                return await runSelectionItem(item, {
                    agentModel,
                    apifyToken,
                    toolTimeout,
                    mcpToolsOnly: itemMcpToolsOnly,
                });
            }

            // Guaranteed by parseMcpAgentItem's kind/expectedOutput cross-check for kind:
            // "agent" items; this task only runs those in this branch, so a missing
            // expectedOutput here is a caller bug.
            if (item.expectedOutput === undefined) {
                throw new Error('kind "agent" item has no expectedOutput; this task only runs agent items');
            }

            const runOptions = {
                prompt: item.input.query,
                model: agentModel,
                apifyToken,
                tools: item.metadata.tools,
                failTools: item.metadata.failTools,
                maxTurns: item.metadata.maxTurns,
                toolTimeoutSeconds: toolTimeout,
                mcpToolsOnly: itemMcpToolsOnly,
            };
            const { adapted, startedAt } = await runAgentWithRetry(item.id, runOptions);
            emitTrace(item.id, item.input.query, agentModel, itemMcpToolsOnly, adapted, startedAt);

            const { conversation, transcript } = adapted;
            const judgeResult = await evaluateConversation(item.expectedOutput, conversation, llmClient, judgeModel);

            // Server tools only: a failed Claude Code built-in (Bash, WebFetch) says nothing
            // about the server under test. Failures of tools the harness force-failed itself
            // are not errors of the run either. First line only: the full text already sits
            // on the tool span. Known blind spot: the adapter drops subagent activity, so a
            // server tool failing inside a Task-spawned subagent never reaches this gate.
            const expectedErrorTools = new Set(item.metadata.expectedErrors ?? []);
            const injected = new Set(item.metadata.failTools ?? []);
            const toolErrors: ToolError[] = adapted.toolInvocations
                .filter(
                    (invocation) =>
                        invocation.isMcpTool && !invocation.result.success && !injected.has(invocation.name),
                )
                .map((invocation) => ({
                    tool: invocation.name,
                    error: invocation.result.error?.split('\n')[0] || 'unknown error',
                    expected: expectedErrorTools.has(invocation.name),
                }));

            return {
                kind: 'agent',
                id: item.id,
                ...(iteration !== undefined && { iteration }),
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

/**
 * The selection-mode branch: same agent, run under a deny-all hook via `isSelectionMode`.
 * Nothing executes, no judge runs; the score is `first_tool_match` over the attempted calls
 * the hook recorded.
 */
async function runSelectionItem(
    item: McpAgentItem,
    options: { agentModel: string; apifyToken: string; toolTimeout: number; mcpToolsOnly: boolean },
): Promise<McpAgentTaskOutput> {
    const { agentModel, apifyToken, toolTimeout, mcpToolsOnly } = options;
    const runOptions = {
        prompt: item.input.query,
        model: agentModel,
        apifyToken,
        tools: item.metadata.tools,
        toolTimeoutSeconds: toolTimeout,
        mcpToolsOnly,
        isSelectionMode: true,
    };
    const { adapted, startedAt } = await runAgentWithRetry(item.id, runOptions);
    emitTrace(item.id, item.input.query, agentModel, mcpToolsOnly, adapted, startedAt);

    const firstToolMatch = resolveFirstToolMatch(
        adapted.attemptedCalls,
        item.metadata.expectedTools ?? [],
        item.metadata.expectedArgs,
    );

    return {
        kind: 'selection',
        id: item.id,
        ...(item.metadata.iteration !== undefined && { iteration: item.metadata.iteration }),
        firstToolMatch,
    };
}
