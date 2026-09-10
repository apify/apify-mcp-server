/** Tasks, evaluators, and run summaries for the Langfuse MCP agent experiment. */

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
import { resolveFirstToolMatch } from './tool_call_mode.js';

/** One failed server tool call. `expected` is true when the item's `expectedErrors` names it. */
export type ToolError = { tool: string; error: string; expected: boolean };

/**
 * Output produced by the experiment task for a single dataset item, discriminated by
 * `kind` so an agent-only field (the judge result, tool errors) or a tool-call-only field
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
          /** `--iterations` trial index (1-based). Always set by the runner; `1` on a default run. */
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
          kind: 'tool-call';
          id: string;
          /** `--iterations` trial index (1-based). Always set by the runner; `1` on a default run. */
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
    // Tool-call items only: nothing executes, so there is no judge and no tool_errors.
    async ({ output }) =>
        output.kind === 'tool-call'
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

/** Whether one item passes its gate: `first_tool_match` for tool-call, judge + zero unexpected tool errors for agent. */
function itemPassed(result: ScoredItem): boolean {
    if (result.output.kind === 'tool-call') {
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
    if (output.kind === 'tool-call') {
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
    items: { id: string; trials: { iteration: number; passed: boolean }[] }[];
    passedTrials: number;
    requestedTrials: number;
    passRate: number;
    failures: { id: string; iteration: number; reason: string }[];
    droppedTrials: { id: string; iteration: number }[];
};

/**
 * Scores all requested trials. The denominator includes dropped SDK tasks so a task failure
 * cannot inflate the pass rate.
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
    for (const id of requestedIds) {
        const byIteration = byId.get(id) ?? new Map<number, ScoredItem>();
        const trials: { iteration: number; passed: boolean }[] = [];

        for (let iteration = 1; iteration <= iterations; iteration++) {
            const result = byIteration.get(iteration);
            if (!result) {
                droppedTrials.push({ id, iteration });
                trials.push({ iteration, passed: false });
                continue;
            }

            const passed = itemPassed(result);
            trials.push({ iteration, passed });
            if (passed) {
                passedTrials++;
            } else {
                failures.push({ id, iteration, reason: failureReason(result) });
            }
        }

        items.push({ id, trials });
    }

    const requestedTrials = requestedIds.length * iterations;
    return {
        items,
        passedTrials,
        requestedTrials,
        passRate: requestedTrials > 0 ? passedTrials / requestedTrials : 0,
        failures,
        droppedTrials,
    };
}

/** The gate: `0` while the aggregate pass rate meets the threshold, `1` otherwise. */
export function resolveExitCode(summary: RunSummary, passThreshold: number): number {
    return summary.passRate >= passThreshold ? 0 : 1;
}

function withIteration(item: DatasetItem, iteration: number): DatasetItem {
    return { ...item, metadata: { ...(item.metadata as Record<string, unknown> | undefined), iteration } };
}

/**
 * Repeats items in one experiment, tagging each copy with its one-based iteration because
 * Langfuse has no native iteration field.
 */
export function expandIterations(items: DatasetItem[], iterations: number): DatasetItem[] {
    return items.flatMap((item) => Array.from({ length: iterations }, (_, index) => withIteration(item, index + 1)));
}

export function validateIterations(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--iterations must be a positive integer, got "${value}"`);
    }
}

export function validatePassThreshold(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`--pass-threshold must be between 0 and 1, got "${value}"`);
    }
}

/** Langfuse batches items with `i += concurrency`, so 0 loops forever and NaN never starts. */
export function validateConcurrency(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--concurrency must be a positive integer, got "${value}"`);
    }
}

/**
 * Branch name for a run's name. `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD` on
 * a detached checkout (the `actions/checkout` default for a `pull_request` event), so fall back
 * to `GITHUB_HEAD_REF` (the PR's source branch), then `GITHUB_REF_NAME` (e.g. `master` on push).
 */
export function resolveGitBranch(
    rawBranch: string,
    env: { GITHUB_HEAD_REF?: string; GITHUB_REF_NAME?: string },
): string {
    const branch = rawBranch.trim();
    if (branch && branch !== 'HEAD') return branch;
    return env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || 'unknown';
}

export type RunSummaryLine = { stream: 'log' | 'error'; text: string };

/** Build console lines separately so the CLI does not need side effects in its tests. */
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
        const passedAtLeastOnce = summary.items.filter((item) => item.trials.some((trial) => trial.passed)).length;
        const passedEveryTime = summary.items.filter((item) => item.trials.every((trial) => trial.passed)).length;
        lines.push({
            stream: 'log',
            text:
                `📈 pass@${iterations} ${passedAtLeastOnce}/${summary.items.length} items · ` +
                `pass^${iterations} ${passedEveryTime}/${summary.items.length} items`,
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
    /** Requested items x iterations, for the per-item progress line. */
    totalTrials: number;
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
 * Sends the subprocess conversation to Langfuse without affecting the item result if tracing fails.
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
    const { llmClient, apifyToken, agentModel, judgeModel, toolTimeout, mcpToolsOnly, totalTrials } = options;

    // Progress, one line per finished trial. The scored verdict comes later from the
    // evaluators; this reads the task output, which carries the same pass/fail signal.
    let completedTrials = 0;
    const logProgress = (id: string, marker: string) => {
        completedTrials++;
        // eslint-disable-next-line no-console
        console.log(`[${completedTrials}/${totalTrials}] ${marker} ${id}`);
    };
    const outputPassed = (output: McpAgentTaskOutput) =>
        output.kind === 'tool-call'
            ? output.firstToolMatch.isMatch
            : output.judgeResult.verdict === 'PASS' && output.toolErrors.every((error) => error.expected);

    return async (rawItem: unknown): Promise<McpAgentTaskOutput> => {
        const item = parseMcpAgentItem(rawItem);
        const itemMcpToolsOnly = mcpToolsOnly || (item.metadata.mcpToolsOnly ?? false);

        let output: McpAgentTaskOutput;
        try {
            output = await runItem(item, itemMcpToolsOnly);
        } catch (error) {
            logProgress(item.id, '🔥');
            throw new Error(`Item "${item.id}": ${error instanceof Error ? error.message : String(error)}`, {
                cause: error,
            });
        }
        logProgress(item.id, outputPassed(output) ? '✅' : '❌');
        return output;
    };

    async function runItem(item: McpAgentItem, itemMcpToolsOnly: boolean): Promise<McpAgentTaskOutput> {
        const { iteration } = item.metadata;
        if (item.metadata.kind === 'tool-call') {
            return await runToolCallItem(item, {
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
                (invocation) => invocation.isMcpTool && !invocation.result.success && !injected.has(invocation.name),
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
    }
}

/**
 * The tool-call branch: same agent, run under a deny-all hook via `isToolCallMode`.
 * Nothing executes, no judge runs; the score is `first_tool_match` over the attempted calls
 * the hook recorded.
 */
async function runToolCallItem(
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
        isToolCallMode: true,
    };
    const { adapted, startedAt } = await runAgentWithRetry(item.id, runOptions);
    emitTrace(item.id, item.input.query, agentModel, mcpToolsOnly, adapted, startedAt);

    const firstToolMatch = resolveFirstToolMatch(
        adapted.attemptedCalls,
        item.metadata.expectedTools ?? [],
        item.metadata.expectedArgs,
    );

    return {
        kind: 'tool-call',
        id: item.id,
        ...(item.metadata.iteration !== undefined && { iteration: item.metadata.iteration }),
        firstToolMatch,
    };
}
