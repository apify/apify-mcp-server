/**
 * Results writer for persisting workflow evaluation attempts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EvaluationResult, ResultsDatabase, TestResultRecord } from './output_formatter.js';
import {
    getCallActorTargets,
    getFailedToolCallCount,
    getFinalResponse,
    getPolicyViolations,
    getToolCallCount,
    getToolCallTrace,
    sumResultBytes,
} from './output_formatter.js';

const CODE_RUNTIME_ACTOR_ID = 'apify/code-runtime';

/**
 * Build composite key used by legacy results files.
 */
export function buildResultKey(agentModel: string, judgeModel: string, testId: string): string {
    return `${agentModel}:${judgeModel}:${testId}`;
}

function getRecords(database: ResultsDatabase): TestResultRecord[] {
    return [...Object.values(database.results ?? {}), ...(database.attempts ?? [])];
}

/**
 * Find newest baseline record with metrics for an agent model and test.
 */
export function findBaselineRecord(
    database: ResultsDatabase,
    agentModel: string,
    testId: string,
): TestResultRecord | undefined {
    const hasMetrics = (record: TestResultRecord): boolean =>
        record.resultBytes !== undefined || record.totalTokens !== undefined;
    let best: TestResultRecord | undefined;
    for (const record of getRecords(database)) {
        if (record.agentModel !== agentModel || record.testId !== testId) continue;
        if (
            best === undefined ||
            (hasMetrics(record) && !hasMetrics(best)) ||
            (hasMetrics(record) === hasMetrics(best) && record.timestamp > best.timestamp)
        ) {
            best = record;
        }
    }
    return best;
}

/**
 * Load existing results, or create an empty append-only database.
 */
export function loadResultsDatabase(filePath: string): ResultsDatabase {
    if (!existsSync(filePath)) {
        return {
            version: '2.0',
            attempts: [],
        };
    }

    try {
        const database = JSON.parse(readFileSync(filePath, 'utf-8')) as ResultsDatabase;
        const hasResults = database.results && typeof database.results === 'object';
        const hasAttempts = Array.isArray(database.attempts);
        if (!database.version || (!hasResults && !hasAttempts)) {
            throw new Error('Invalid database structure: missing version, results, or attempts field');
        }
        return database;
    } catch (error) {
        throw new Error(
            `Failed to load results database from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export function saveResultsDatabase(filePath: string, database: ResultsDatabase): void {
    try {
        const directory = dirname(filePath);
        if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
        writeFileSync(filePath, JSON.stringify(database, null, 2), 'utf-8');
    } catch (error) {
        throw new Error(
            `Failed to save results database to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Convert one evaluation attempt to its persisted form.
 */
export function convertEvaluationResultToRecord(
    result: EvaluationResult,
    agentModel: string,
    judgeModel: string,
): TestResultRecord {
    const { conversation } = result;
    return {
        timestamp: new Date().toISOString(),
        agentModel,
        judgeModel,
        testId: result.testCase.id,
        pairId: result.testCase.pairId,
        arm: result.testCase.arm,
        verdict: result.error ? 'FAIL' : result.judgeResult.verdict,
        reason: result.error ?? result.judgeResult.reason,
        durationMs: result.durationMs,
        turns: conversation.totalTurns,
        resultBytes: sumResultBytes(conversation),
        promptTokens: conversation.promptTokens,
        completionTokens: conversation.completionTokens,
        totalTokens: conversation.totalTokens,
        cachedPromptTokens: conversation.cachedPromptTokens,
        reasoningTokens: conversation.reasoningTokens,
        judgeUsage: result.judgeResult.usage,
        toolCalls: getToolCallCount(conversation),
        failedToolCalls: getFailedToolCallCount(conversation),
        policyViolations: getPolicyViolations(conversation),
        usedCodeRuntime: getCallActorTargets(conversation).includes(CODE_RUNTIME_ACTOR_ID),
        finalResponse: getFinalResponse(conversation),
        toolCallTrace: getToolCallTrace(conversation),
        error: result.error ?? null,
    };
}

/**
 * Append evaluation attempts without replacing earlier runs.
 */
export function updateResultsWithEvaluations(
    database: ResultsDatabase,
    results: EvaluationResult[],
    agentModel: string,
    judgeModel: string,
): ResultsDatabase {
    return {
        version: '2.0',
        attempts: [
            ...getRecords(database),
            ...results.map((result) => convertEvaluationResultToRecord(result, agentModel, judgeModel)),
        ],
    };
}
