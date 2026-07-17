/**
 * Full-fidelity trace output for manual review.
 *
 * Unlike results.json (compact, append-only, tool-result bodies excluded —
 * see output_formatter.ts's getToolCallTrace), a trace keeps every turn's
 * full tool-call arguments, full tool results, and full LLM final response,
 * untruncated. Written only when --traces is passed; meant to be read by a
 * human inspecting exactly what one test case did, not diffed for metrics.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { EvaluationResult } from './output_formatter.js';
import type { ConversationHistory } from './types.js';

export type TestTrace = {
    testId: string;
    category: string;
    arm?: string;
    pairId?: string;
    query: string;
    durationMs: number;
    error?: string;
    timedOut?: boolean;
    verdict: string;
    judgeReason: string;
    /** 1-indexed attempt number for this test case (see --repeat); 1 when repeat is not used. */
    attemptIndex: number;
    /** Total attempts requested for this test case (see --repeat); 1 when repeat is not used. */
    totalAttempts: number;
    conversation: ConversationHistory;
};

function toTrace(result: EvaluationResult): TestTrace {
    const { testCase, conversation, judgeResult, durationMs, error, timedOut, attemptIndex, totalAttempts } = result;
    return {
        testId: testCase.id,
        category: testCase.category,
        arm: testCase.arm,
        pairId: testCase.pairId,
        query: testCase.query,
        durationMs,
        error,
        timedOut,
        verdict: judgeResult.verdict,
        judgeReason: judgeResult.reason,
        attemptIndex: attemptIndex ?? 1,
        totalAttempts: totalAttempts ?? 1,
        conversation,
    };
}

/** Write full per-turn traces for a batch of results, overwriting any existing file at filePath. */
export function writeTraces(filePath: string, results: EvaluationResult[]): void {
    const traces = results.map(toTrace);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(traces, null, 2));
}
