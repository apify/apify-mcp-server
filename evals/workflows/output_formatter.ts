/**
 * Output formatter for evaluation results
 */

import { HELPER_TOOLS } from '../../src/const.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import type { ConversationHistory, TokenUsage } from './types.js';
import type { JudgeResult } from './workflow_judge.js';

/**
 * Single evaluation result
 */
export type EvaluationResult = {
    testCase: WorkflowTestCase;
    conversation: ConversationHistory;
    judgeResult: JudgeResult;
    durationMs: number;
    error?: string;
    /** True when `error` specifically means the test exceeded --test-timeout, not some other failure. */
    timedOut?: boolean;
    /** 1-indexed attempt number for this test case (see --repeat); absent/1 when repeat is not used. */
    attemptIndex?: number;
    /** Total attempts requested for this test case (see --repeat); absent/1 when repeat is not used. */
    totalAttempts?: number;
};

/**
 * Sum the byte size of all tool results returned to the agent across a conversation.
 * This is the data volume returned by the tools, independent of the model's own output.
 */
export function sumResultBytes(conversation: ConversationHistory): number {
    let total = 0;
    for (const turn of conversation.turns) {
        for (const toolResult of turn.toolResults) {
            total += toolResult.resultBytes ?? 0;
        }
    }
    return total;
}

export function getToolCallCount(conversation: ConversationHistory): number {
    return conversation.turns.reduce((total, turn) => total + turn.toolCalls.length, 0);
}

export function getFailedToolCallCount(conversation: ConversationHistory): number {
    return conversation.turns.reduce(
        (total, turn) => total + turn.toolResults.filter((toolResult) => !toolResult.success).length,
        0,
    );
}

export function getPolicyViolations(conversation: ConversationHistory): string[] {
    return conversation.turns.flatMap((turn) =>
        turn.toolResults.flatMap((toolResult) => (toolResult.policyViolation ? [toolResult.policyViolation] : [])),
    );
}

/**
 * Distinct Actor IDs the agent targeted through call-actor (MCP tool-suffix stripped).
 * Informational only — not used to gate pass/fail.
 */
export function getCallActorTargets(conversation: ConversationHistory): string[] {
    const targets = new Set<string>();
    for (const turn of conversation.turns) {
        for (const toolCall of turn.toolCalls) {
            if (toolCall.name !== HELPER_TOOLS.ACTOR_CALL) continue;
            const { actor } = toolCall.arguments;
            if (typeof actor === 'string') targets.add(actor.split(':', 1)[0]);
        }
    }
    return [...targets];
}

export function getFinalResponse(conversation: ConversationHistory): string {
    for (let index = conversation.turns.length - 1; index >= 0; index--) {
        const { finalResponse } = conversation.turns[index];
        if (finalResponse !== undefined) return finalResponse;
    }
    return '';
}

export type ToolCallTraceEntry = {
    turnNumber: number;
    name: string;
    arguments: Record<string, unknown>;
    success: boolean;
    error?: string;
    policyViolation?: string;
    resultBytes?: number;
    startedAt?: string;
    durationMs?: number;
};

export function getToolCallTrace(conversation: ConversationHistory): ToolCallTraceEntry[] {
    return conversation.turns.flatMap((turn) =>
        turn.toolCalls.map((toolCall, index) => {
            const toolResult = turn.toolResults[index];
            return {
                turnNumber: turn.turnNumber,
                name: toolCall.name,
                arguments: toolCall.arguments,
                success: toolResult?.success ?? false,
                error: toolResult?.error,
                policyViolation: toolResult?.policyViolation,
                resultBytes: toolResult?.resultBytes,
                startedAt: toolResult?.startedAt,
                durationMs: toolResult?.durationMs,
            };
        }),
    );
}

function median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Aggregated outcome across repeated attempts of the same test case (see --repeat).
 *
 * passRate/completionRate are distinct on purpose: `completionRate` counts any attempt the
 * agent finished (right or wrong answer), `passRate` only the correct ones. Averaging duration/
 * tokens/bytes over ALL attempts would bias toward errored/timed-out ones (e.g. a --test-timeout
 * cap inflates the "typical" duration for a run that never actually finished) -- those stats are
 * computed over completed attempts only.
 */
export type RepeatSummary = {
    testId: string;
    category: string;
    attempts: number;
    passed: number;
    /** Judge FAIL -- agent finished but gave a wrong/incomplete answer. */
    failed: number;
    /** Exceeded --test-timeout specifically. */
    timedOut: number;
    /** Threw for any other reason. */
    errored: number;
    passRate: number;
    completionRate: number;
    medianDurationMs?: number;
    meanDurationMs?: number;
    medianTokens?: number;
    meanTokens?: number;
    medianToolBytes?: number;
    meanToolBytes?: number;
};

export function aggregateRepeatedResults(results: EvaluationResult[]): RepeatSummary[] {
    const byTestId = new Map<string, EvaluationResult[]>();
    for (const result of results) {
        const group = byTestId.get(result.testCase.id) ?? [];
        group.push(result);
        byTestId.set(result.testCase.id, group);
    }

    const summaries: RepeatSummary[] = [];
    for (const [testId, group] of byTestId) {
        const attempts = group.length;
        const passed = group.filter((r) => !r.error && r.judgeResult.verdict === 'PASS').length;
        const failed = group.filter((r) => !r.error && r.judgeResult.verdict === 'FAIL').length;
        const timedOut = group.filter((r) => r.timedOut).length;
        const errored = group.filter((r) => r.error && !r.timedOut).length;

        const completed = group.filter((r) => !r.error);
        const durations = completed.map((r) => r.durationMs);
        const tokens = completed.map((r) => r.conversation.totalTokens ?? 0);
        const toolBytes = completed.map((r) => sumResultBytes(r.conversation));

        summaries.push({
            testId,
            category: group[0].testCase.category,
            attempts,
            passed,
            failed,
            timedOut,
            errored,
            passRate: passed / attempts,
            completionRate: (passed + failed) / attempts,
            medianDurationMs: median(durations),
            meanDurationMs: mean(durations),
            medianTokens: median(tokens),
            meanTokens: mean(tokens),
            medianToolBytes: median(toolBytes),
            meanToolBytes: mean(toolBytes),
        });
    }
    return summaries;
}

/**
 * Format a byte count as a human-readable string (B / KB / MB).
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a token count with thousands separators.
 */
export function formatTokens(tokens: number): string {
    return tokens.toLocaleString('en-US');
}

/**
 * Render a metric value followed by its change vs an optional baseline.
 * Lower-is-better metrics (bytes, tokens): ▼ marks a reduction, ▲ an increase.
 * Returns just the formatted value when no baseline exists.
 */
export function formatWithDelta(current: number, baseline: number | undefined, format: (n: number) => string): string {
    if (baseline === undefined) return `${format(current)} (no baseline)`;

    const diff = current - baseline;
    if (diff === 0) return `${format(current)} (= baseline)`;

    const arrow = diff > 0 ? '▲' : '▼';
    const sign = diff > 0 ? '+' : '-';
    const pct = baseline === 0 ? 'n/a' : `${sign}${Math.abs((diff / baseline) * 100).toFixed(1)}%`;
    return `${format(current)} (${arrow} ${sign}${format(Math.abs(diff))} / ${pct})`;
}

/**
 * Format results as a table.
 *
 * @param results - Evaluation results to render
 * @param baseline - Optional prior results keyed by test ID; when present, byte/token deltas are shown
 */
export function formatResultsTable(results: EvaluationResult[], baseline?: Map<string, TestResultRecord>): string {
    const lines: string[] = [];

    // Header
    lines.push('='.repeat(100));
    lines.push('Workflow Evaluation Results');
    lines.push('='.repeat(100));
    lines.push('');

    // Individual results
    for (const result of results) {
        let status: string;
        if (result.error) {
            status = '🔥 ERROR';
        } else if (result.judgeResult.verdict === 'PASS') {
            status = '✅ PASS';
        } else {
            status = '❌ FAIL';
        }

        lines.push(`${status} | ${result.testCase.id} | ${result.testCase.category}`);
        lines.push(`  Query: ${result.testCase.query.slice(0, 80)}${result.testCase.query.length > 80 ? '...' : ''}`);

        if (result.error) {
            lines.push(`  Error: ${result.error}`);
        } else {
            const prior = baseline?.get(result.testCase.id);
            const bytes = sumResultBytes(result.conversation);
            const tokens = result.conversation.totalTokens ?? 0;
            lines.push(`  Turns: ${result.conversation.totalTurns} | Duration: ${result.durationMs}ms`);
            lines.push(`  Tool bytes: ${formatWithDelta(bytes, prior?.resultBytes, formatBytes)}`);
            lines.push(`  Tokens: ${formatWithDelta(tokens, prior?.totalTokens, formatTokens)}`);
            lines.push(`  Reason: ${result.judgeResult.reason}`);
        }

        lines.push('');
    }

    lines.push('-'.repeat(100));
    lines.push('');

    // Summary stats at the END
    const totalTests = results.length;
    const passedTests = results.filter((r) => !r.error && r.judgeResult.verdict === 'PASS').length;
    const failedTests = results.filter((r) => !r.error && r.judgeResult.verdict === 'FAIL').length;
    const errorTests = results.filter((r) => r.error).length;

    const totalBytes = results.reduce((sum, r) => sum + sumResultBytes(r.conversation), 0);
    const totalTokens = results.reduce((sum, r) => sum + (r.conversation.totalTokens ?? 0), 0);

    // Aggregate deltas over the subset of tests whose baseline record has the metric, so
    // the comparison is like-for-like. A legacy baseline may predate a metric (field absent),
    // so bytes and tokens are matched independently.
    let bytesMatched = 0;
    let bytesCurrent = 0;
    let bytesBaseline = 0;
    let tokensMatched = 0;
    let tokensCurrent = 0;
    let tokensBaseline = 0;
    if (baseline) {
        for (const result of results) {
            const prior = baseline.get(result.testCase.id);
            if (!prior) continue;
            // Records written before these metrics existed lack the field, so match each independently.
            const priorBytes = prior.resultBytes;
            if (priorBytes !== undefined) {
                bytesMatched++;
                bytesCurrent += sumResultBytes(result.conversation);
                bytesBaseline += priorBytes;
            }
            const priorTokens = prior.totalTokens;
            if (priorTokens !== undefined) {
                tokensMatched++;
                tokensCurrent += result.conversation.totalTokens ?? 0;
                tokensBaseline += priorTokens;
            }
        }
    }

    lines.push(`📊 Summary:`);
    lines.push(`  Total tests: ${totalTests}`);
    lines.push(`  Passed: ${passedTests} ✅`);
    lines.push(`  Failed: ${failedTests} ❌`);
    lines.push(`  Errors: ${errorTests} 🔥`);
    if (totalTests > 0) {
        lines.push(
            `  Tool bytes returned: ${formatBytes(totalBytes)} total, ${formatBytes(Math.round(totalBytes / totalTests))} avg/test`,
        );
        lines.push(
            `  Tokens used: ${formatTokens(totalTokens)} total, ${formatTokens(Math.round(totalTokens / totalTests))} avg/test`,
        );
    }
    if (bytesMatched > 0 || tokensMatched > 0) {
        lines.push('');
        lines.push(`  vs baseline:`);
        if (bytesMatched > 0) {
            lines.push(
                `    Tool bytes (${bytesMatched}/${totalTests}): ${formatWithDelta(bytesCurrent, bytesBaseline, formatBytes)}`,
            );
        }
        if (tokensMatched > 0) {
            lines.push(
                `    Tokens (${tokensMatched}/${totalTests}): ${formatWithDelta(tokensCurrent, tokensBaseline, formatTokens)}`,
            );
        }
    }
    lines.push('');

    // Final verdict - ALL tests must pass
    if (totalTests === 0) {
        lines.push('⚠️  No tests run');
    } else if (passedTests === totalTests && errorTests === 0) {
        lines.push(`✅ Overall: PASS (${passedTests}/${totalTests} tests passed)`);
    } else {
        lines.push(
            `❌ Overall: FAIL (${passedTests}/${totalTests} tests passed, ${failedTests} failed, ${errorTests} errors)`,
        );
    }

    lines.push('='.repeat(100));

    return lines.join('\n');
}

/**
 * Format the aggregated per-test-case outcome across repeated attempts (see --repeat).
 * Complements formatResultsTable(), which already lists every individual attempt.
 */
export function formatRepeatSummaryTable(summaries: RepeatSummary[]): string {
    const lines: string[] = [];

    lines.push('='.repeat(100));
    lines.push('Repeat Summary (aggregated across attempts per test case)');
    lines.push('='.repeat(100));
    lines.push('');

    for (const summary of summaries) {
        lines.push(`${summary.testId} (${summary.category})`);
        lines.push(
            `  Pass rate: ${summary.passed}/${summary.attempts} (${(summary.passRate * 100).toFixed(0)}%) | ` +
                `Completion rate: ${summary.passed + summary.failed}/${summary.attempts} (${(summary.completionRate * 100).toFixed(0)}%)`,
        );
        lines.push(
            `  Wrong answer: ${summary.failed} | Timed out: ${summary.timedOut} | Other errors: ${summary.errored}`,
        );
        if (summary.medianDurationMs !== undefined) {
            lines.push(
                `  Duration (completed attempts): median ${Math.round(summary.medianDurationMs)}ms, ` +
                    `mean ${Math.round(summary.meanDurationMs!)}ms`,
            );
            lines.push(
                `  Tokens (completed attempts): median ${formatTokens(Math.round(summary.medianTokens!))}, ` +
                    `mean ${formatTokens(Math.round(summary.meanTokens!))}`,
            );
            lines.push(
                `  Tool bytes (completed attempts): median ${formatBytes(Math.round(summary.medianToolBytes!))}, ` +
                    `mean ${formatBytes(Math.round(summary.meanToolBytes!))}`,
            );
        } else {
            lines.push(`  No completed attempts to measure duration/tokens/bytes from.`);
        }
        lines.push('');
    }

    lines.push('='.repeat(100));
    return lines.join('\n');
}

/**
 * Format a single result for verbose output
 */
export function formatDetailedResult(result: EvaluationResult): string {
    const lines: string[] = [];

    lines.push('='.repeat(100));
    lines.push(`Test Case: ${result.testCase.id} (${result.testCase.category})`);
    lines.push('='.repeat(100));
    lines.push('');

    lines.push(`📝 Query:`);
    lines.push(`  ${result.testCase.query}`);
    lines.push('');

    lines.push(`📋 Requirements:`);
    lines.push(`  ${result.testCase.reference}`);
    lines.push('');

    if (result.error) {
        lines.push(`🔥 Error: ${result.error}`);
        lines.push('');
        return lines.join('\n');
    }

    lines.push(`💬 Conversation (${result.conversation.totalTurns} turns):`);
    for (const turn of result.conversation.turns) {
        lines.push(`  Turn ${turn.turnNumber}:`);

        if (turn.toolCalls.length > 0) {
            for (const tc of turn.toolCalls) {
                lines.push(`    🔧 ${tc.name}(${JSON.stringify(tc.arguments)})`);
            }
        }

        // Print tool results in verbose mode
        if (turn.toolResults.length > 0) {
            for (const tr of turn.toolResults) {
                const status = tr.success ? '✅' : '❌';
                const bytesLabel = tr.resultBytes !== undefined ? ` (${formatBytes(tr.resultBytes)})` : '';
                lines.push(`    ${status} Result for ${tr.toolName}${bytesLabel}:`);
                if (tr.error) {
                    lines.push(`       Error: ${tr.error}`);
                } else if (tr.result) {
                    const resultStr = JSON.stringify(tr.result, null, 2);
                    const resultPreview = resultStr.slice(0, 500);
                    lines.push(`       ${resultPreview}${resultStr.length > 500 ? '...' : ''}`);
                }
            }
        }

        if (turn.finalResponse) {
            const preview = turn.finalResponse.slice(0, 150);
            lines.push(`    💬 ${preview}${turn.finalResponse.length > 150 ? '...' : ''}`);
        }
    }
    lines.push('');

    lines.push(`⚖️  Judge Verdict: ${result.judgeResult.verdict}`);
    lines.push(`  Reason: ${result.judgeResult.reason}`);
    lines.push('');

    lines.push(`⏱️  Duration: ${result.durationMs}ms`);
    lines.push(`📦 Tool bytes: ${formatBytes(sumResultBytes(result.conversation))}`);
    lines.push(`🔢 Tokens: ${formatTokens(result.conversation.totalTokens ?? 0)}`);
    lines.push('');

    return lines.join('\n');
}

/**
 * Single test result record stored in results database
 */
export type TestResultRecord = {
    /** ISO timestamp when test was run */
    timestamp: string;
    /** Agent LLM model used */
    agentModel: string;
    /** Judge LLM model used */
    judgeModel: string;
    /** Test case ID */
    testId: string;
    /** Paired experiment ID */
    pairId?: string;
    /** Experiment strategy */
    arm?: WorkflowTestCase['arm'];
    /** Test verdict (PASS or FAIL) */
    verdict: 'PASS' | 'FAIL';
    /** Judge reasoning or error message */
    reason: string;
    /** Test duration in milliseconds */
    durationMs: number;
    /** Number of conversation turns */
    turns: number;
    /** Total bytes of tool results returned to the agent across the conversation (absent in records written before this metric) */
    resultBytes?: number;
    /** Prompt tokens billed across all agent LLM calls (absent in records written before this metric, or when the provider omits usage) */
    promptTokens?: number;
    /** Completion tokens billed across all agent LLM calls (absent in records written before this metric, or when the provider omits usage) */
    completionTokens?: number;
    /** Total tokens billed across all agent LLM calls (prompt + completion; absent in records written before this metric, or when the provider omits usage) */
    totalTokens?: number;
    /** Cached prompt tokens reported across all agent LLM calls */
    cachedPromptTokens?: number;
    /** Reasoning tokens reported across all agent LLM calls */
    reasoningTokens?: number;
    /** Judge token usage, kept separate from agent usage */
    judgeUsage?: TokenUsage;
    /** Number of MCP tool calls */
    toolCalls?: number;
    /** Number of failed MCP tool calls */
    failedToolCalls?: number;
    /** Evaluation policy violations */
    policyViolations?: string[];
    /** Whether the agent called apify/code-runtime at least once (informational, not a pass/fail gate) */
    usedCodeRuntime?: boolean;
    /** Final response returned by the agent */
    finalResponse?: string;
    /** Tool calls and outcomes, including generated Code Mode scripts but excluding result bodies */
    toolCallTrace?: ToolCallTraceEntry[];
    /** Error message if execution failed, null otherwise */
    error: string | null;
    /** True when `error` specifically means the test exceeded --test-timeout */
    timedOut?: boolean;
    /** 1-indexed attempt number for this test case (see --repeat); 1 when repeat is not used */
    attemptIndex?: number;
    /** Total attempts requested for this test case (see --repeat); 1 when repeat is not used */
    totalAttempts?: number;
};

/**
 * Results database structure. Legacy keyed results remain readable; new attempts append to `attempts`.
 */
export type ResultsDatabase = {
    version: string;
    results?: Record<string, TestResultRecord>;
    attempts?: TestResultRecord[];
};
