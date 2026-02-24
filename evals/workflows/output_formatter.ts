/**
 * Output formatter for evaluation results
 */

import type { WorkflowTestCase } from './test-cases-loader.js';
import type { ConversationHistory } from './types.js';
import type { JudgeResult } from './workflow-judge.js';

/**
 * Single evaluation result
 */
export type EvaluationResult = {
    testCase: WorkflowTestCase;
    conversation: ConversationHistory;
    judgeResult: JudgeResult;
    durationMs: number;
    error?: string;
}

/**
 * Format results as a table
 */
export function formatResultsTable(results: EvaluationResult[]): string {
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
            lines.push(`  Turns: ${result.conversation.totalTurns} | Duration: ${result.durationMs}ms`);
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

    lines.push(`📊 Summary:`);
    lines.push(`  Total tests: ${totalTests}`);
    lines.push(`  Passed: ${passedTests} ✅`);
    lines.push(`  Failed: ${failedTests} ❌`);
    lines.push(`  Errors: ${errorTests} 🔥`);
    lines.push('');

    // Final verdict - ALL tests must pass
    if (totalTests === 0) {
        lines.push('⚠️  No tests run');
    } else if (passedTests === totalTests && errorTests === 0) {
        lines.push(`✅ Overall: PASS (${passedTests}/${totalTests} tests passed)`);
    } else {
        lines.push(`❌ Overall: FAIL (${passedTests}/${totalTests} tests passed, ${failedTests} failed, ${errorTests} errors)`);
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
                lines.push(`    ${status} Result for ${tr.toolName}:`);
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
    /** Test verdict (PASS or FAIL) */
    verdict: 'PASS' | 'FAIL';
    /** Judge reasoning or error message */
    reason: string;
    /** Test duration in milliseconds */
    durationMs: number;
    /** Number of conversation turns */
    turns: number;
    /** Error message if execution failed, null otherwise */
    error: string | null;
}

/**
 * Results database structure
 * Keys are in format: "{agentModel}:{judgeModel}:{testId}"
 */
export type ResultsDatabase = {
    version: string;
    results: Record<string, TestResultRecord>;
}
