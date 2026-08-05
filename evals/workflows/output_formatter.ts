/**
 * Output formatter for evaluation results
 */

import type { SchemaValidityCheck, ToolSelectionCheck } from './deterministic_checks.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import type { ConversationHistory } from './types.js';
import type { JudgeResult, RubricResult } from './workflow_judge.js';
import { RUBRIC_DIMENSIONS } from './workflow_judge.js';

/**
 * Single evaluation result
 */
export type EvaluationResult = {
    testCase: WorkflowTestCase;
    conversation: ConversationHistory;
    judgeResult: JudgeResult;
    durationMs: number;
    error?: string;
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
 * Render a pass count followed by its change vs a baseline pass count over the same test subset.
 * More passes is better here, so ▲ marks an improvement and ▼ a regression — the opposite reading
 * of the byte/token deltas, where lower is better.
 */
export function formatPassRateWithDelta(current: number, baseline: number, total: number): string {
    const diff = current - baseline;
    if (diff === 0) return `${current}/${total} passed (= baseline)`;

    const arrow = diff > 0 ? '▲' : '▼';
    const sign = diff > 0 ? '+' : '-';
    return `${current}/${total} passed (${arrow} ${sign}${Math.abs(diff)} vs baseline ${baseline}/${total})`;
}

/**
 * Render the rubric as one compact line of per-dimension glyphs, e.g.
 * `tool✓ args✓ result✗ complete✓ recover✓ eff✓`.
 */
export function formatRubricGlyphs(rubric: RubricResult): string {
    return RUBRIC_DIMENSIONS.map(({ key, glyph }) => `${glyph}${rubric[key].verdict === 'PASS' ? '✓' : '✗'}`).join(' ');
}

/**
 * Format results as a table.
 *
 * @param results - Evaluation results to render
 * @param baseline - Optional prior results keyed by test ID; when present, byte/token and
 *                   per-dimension pass-rate deltas are shown
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
        } else if (result.judgeResult.overallVerdict === 'PASS') {
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
            lines.push(`  Rubric: ${formatRubricGlyphs(result.judgeResult.rubric)}`);
            lines.push(`  Turns: ${result.conversation.totalTurns} | Duration: ${result.durationMs}ms`);
            lines.push(`  Tool bytes: ${formatWithDelta(bytes, prior?.resultBytes, formatBytes)}`);
            lines.push(`  Tokens: ${formatWithDelta(tokens, prior?.totalTokens, formatTokens)}`);
            lines.push(`  Reason: ${result.judgeResult.rubric.taskCompletion.reason}`);
            // Only surfaced on failure; a passing schema check is the uninteresting default.
            const { invalidCalls } = result.judgeResult.schemaValidityCheck;
            if (invalidCalls.length > 0) {
                const summary = invalidCalls.map((call) => `${call.toolName} (${call.errors.join('; ')})`).join(', ');
                lines.push(`  Schema-invalid calls: ${summary}`);
            }
        }

        lines.push('');
    }

    lines.push('-'.repeat(100));
    lines.push('');

    // Summary stats at the END
    const totalTests = results.length;
    const passedTests = results.filter((r) => !r.error && r.judgeResult.overallVerdict === 'PASS').length;
    const failedTests = results.filter((r) => !r.error && r.judgeResult.overallVerdict === 'FAIL').length;
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
    // Per-dimension pass counts, matched over the tests whose baseline record carries a rubric
    // (records written before the rubric existed have none).
    let rubricMatched = 0;
    const dimensionCurrent = new Map<string, number>();
    const dimensionBaseline = new Map<string, number>();
    if (baseline) {
        for (const result of results) {
            const prior = baseline.get(result.testCase.id);
            if (!prior) continue;
            if (prior.rubric) {
                rubricMatched++;
                for (const { key } of RUBRIC_DIMENSIONS) {
                    if (result.judgeResult.rubric[key].verdict === 'PASS') {
                        dimensionCurrent.set(key, (dimensionCurrent.get(key) ?? 0) + 1);
                    }
                    if (prior.rubric[key]?.verdict === 'PASS') {
                        dimensionBaseline.set(key, (dimensionBaseline.get(key) ?? 0) + 1);
                    }
                }
            }
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
        lines.push('');
        lines.push(`  Rubric pass rates:`);
        for (const { key, label } of RUBRIC_DIMENSIONS) {
            const passed = results.filter((r) => r.judgeResult.rubric[key].verdict === 'PASS').length;
            lines.push(`    ${label}: ${passed}/${totalTests} passed`);
        }
    }
    if (bytesMatched > 0 || tokensMatched > 0 || rubricMatched > 0) {
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
        if (rubricMatched > 0) {
            for (const { key, label } of RUBRIC_DIMENSIONS) {
                const current = dimensionCurrent.get(key) ?? 0;
                const prior = dimensionBaseline.get(key) ?? 0;
                lines.push(
                    `    ${label} (${rubricMatched}/${totalTests}): ${formatPassRateWithDelta(current, prior, rubricMatched)}`,
                );
            }
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

    lines.push(`⚖️  Overall verdict (= task completion): ${result.judgeResult.overallVerdict}`);
    for (const { key, label } of RUBRIC_DIMENSIONS) {
        const dimension = result.judgeResult.rubric[key];
        lines.push(`  ${dimension.verdict === 'PASS' ? '✓' : '✗'} ${label}: ${dimension.reason}`);
    }
    lines.push('');

    const { toolSelectionCheck, schemaValidityCheck } = result.judgeResult;
    lines.push(`🧮 Deterministic checks:`);
    if (toolSelectionCheck.checked) {
        lines.push(`  Tool selection: ${toolSelectionCheck.verdict}`);
        lines.push(`    Expected: [${toolSelectionCheck.expected.join(', ')}]`);
        lines.push(`    Actual:   [${toolSelectionCheck.actual.join(', ')}]`);
    } else {
        lines.push(`  Tool selection: not checked (no expectedTools on this test case)`);
        lines.push(`    Actual:   [${toolSelectionCheck.actual.join(', ')}]`);
    }
    lines.push(`  Schema validity: ${schemaValidityCheck.verdict}`);
    for (const invalidCall of schemaValidityCheck.invalidCalls) {
        lines.push(`    ${invalidCall.toolName}: ${invalidCall.errors.join('; ')}`);
    }
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
    /** Test verdict (PASS or FAIL) — mirrors `rubric.taskCompletion.verdict`, kept for readers of the old field */
    verdict: 'PASS' | 'FAIL';
    /** Judge reasoning or error message — mirrors `rubric.taskCompletion.reason` */
    reason: string;
    /** All 6 rubric dimensions (absent in records written before the rubric existed) */
    rubric?: RubricResult;
    /** Deterministic expectedTools exact-match (absent in records written before it existed, and on errored tests) */
    toolSelectionCheck?: ToolSelectionCheck;
    /** Deterministic per-call inputSchema validation (absent in records written before it existed, and on errored tests) */
    schemaValidityCheck?: SchemaValidityCheck;
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
    /** Error message if execution failed, null otherwise */
    error: string | null;
};

/**
 * Results database structure
 * Keys are in format: "{agentModel}:{judgeModel}:{testId}"
 */
export type ResultsDatabase = {
    version: string;
    results: Record<string, TestResultRecord>;
};
