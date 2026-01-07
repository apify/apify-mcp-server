/**
 * Results writer for persisting test results to JSON file
 * Stores latest result per (agentModel, judgeModel, testId) combination
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EvaluationResult, ResultsDatabase, TestResultRecord } from './output-formatter.js';

/**
 * Build composite key for storing results
 * Format: "{agentModel}:{judgeModel}:{testId}"
 */
export function buildResultKey(agentModel: string, judgeModel: string, testId: string): string {
    return `${agentModel}:${judgeModel}:${testId}`;
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
