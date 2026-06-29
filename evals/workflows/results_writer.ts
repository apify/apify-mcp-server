/**
 * Results writer for persisting test results to JSON file
 * Stores latest result per (agentModel, judgeModel, testId) combination
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EvaluationResult, ResultsDatabase, TestResultRecord } from './output_formatter.js';
import { sumResultBytes } from './output_formatter.js';

/**
 * Build composite key for storing results
 * Format: "{agentModel}:{judgeModel}:{testId}"
 */
export function buildResultKey(agentModel: string, judgeModel: string, testId: string): string {
    return `${agentModel}:${judgeModel}:${testId}`;
}

/**
 * Find the baseline record for byte/token deltas, matched by agent model + test ID.
 * The judge model is excluded on purpose: tool bytes and agent token counts are
 * produced by the agent, not the judge, so a baseline recorded with a different
 * judge is still a valid comparison. When several judges recorded the same
 * agent/test, prefer a record that carries metrics, then the most recent.
 */
export function findBaselineRecord(
    database: ResultsDatabase,
    agentModel: string,
    testId: string,
): TestResultRecord | undefined {
    const hasMetrics = (r: TestResultRecord): boolean => r.resultBytes !== undefined || r.totalTokens !== undefined;
    let best: TestResultRecord | undefined;
    for (const record of Object.values(database.results)) {
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
 * Load existing results database from file
 * Returns empty database if file doesn't exist
 */
export function loadResultsDatabase(filePath: string): ResultsDatabase {
    if (!existsSync(filePath)) {
        return {
            version: '1.0',
            results: {},
        };
    }

    try {
        const fileContent = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(fileContent) as ResultsDatabase;

        // Validate structure
        if (!data.version || !data.results || typeof data.results !== 'object') {
            throw new Error('Invalid database structure: missing version or results field');
        }

        return data;
    } catch (error) {
        throw new Error(
            `Failed to load results database from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Save results database to file with pretty formatting
 */
export function saveResultsDatabase(filePath: string, database: ResultsDatabase): void {
    try {
        // Ensure parent directory exists
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // Write with pretty formatting (2-space indent)
        const json = JSON.stringify(database, null, 2);
        writeFileSync(filePath, json, 'utf-8');
    } catch (error) {
        throw new Error(
            `Failed to save results database to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Convert EvaluationResult to TestResultRecord
 */
export function convertEvaluationResultToRecord(
    result: EvaluationResult,
    agentModel: string,
    judgeModel: string,
): TestResultRecord {
    // Handle error cases
    if (result.error) {
        return {
            timestamp: new Date().toISOString(),
            agentModel,
            judgeModel,
            testId: result.testCase.id,
            verdict: 'FAIL',
            reason: result.error,
            durationMs: result.durationMs,
            turns: result.conversation.totalTurns,
            resultBytes: sumResultBytes(result.conversation),
            promptTokens: result.conversation.promptTokens ?? 0,
            completionTokens: result.conversation.completionTokens ?? 0,
            totalTokens: result.conversation.totalTokens ?? 0,
            error: result.error,
        };
    }

    // Normal case
    return {
        timestamp: new Date().toISOString(),
        agentModel,
        judgeModel,
        testId: result.testCase.id,
        verdict: result.judgeResult.verdict,
        reason: result.judgeResult.reason,
        durationMs: result.durationMs,
        turns: result.conversation.totalTurns,
        resultBytes: sumResultBytes(result.conversation),
        promptTokens: result.conversation.promptTokens ?? 0,
        completionTokens: result.conversation.completionTokens ?? 0,
        totalTokens: result.conversation.totalTokens ?? 0,
        error: null,
    };
}

/**
 * Update results database with new evaluation results
 * Only updates entries for tests that ran (preserves other entries)
 */
export function updateResultsWithEvaluations(
    database: ResultsDatabase,
    results: EvaluationResult[],
    agentModel: string,
    judgeModel: string,
): ResultsDatabase {
    // Clone database to avoid mutation
    const updatedDatabase: ResultsDatabase = {
        version: database.version,
        results: { ...database.results },
    };

    // Update each test result
    for (const result of results) {
        const record = convertEvaluationResultToRecord(result, agentModel, judgeModel);
        const key = buildResultKey(agentModel, judgeModel, result.testCase.id);
        updatedDatabase.results[key] = record;
    }

    return updatedDatabase;
}
