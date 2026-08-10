/**
 * Test case loading and validation for workflow evaluations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { TestCaseWithLineNumbers } from '../shared/line_range_filter.js';
import { loadTestCases as loadTestCasesShared } from '../shared/test_case_loader.js';

/** Resolved from this module so cwd cannot change it. */
export const DEFAULT_TEST_CASES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test_cases.json');

/**
 * A workflow test case. Strict: cases also come back from a Langfuse dataset that can be
 * edited outside this repo, and a silently stripped typo (e.g. `failTool`) turns off the
 * behavior a case tests while it still passes.
 */
export const WorkflowTestCaseValidator = z.strictObject({
    id: z.string().min(1),
    /** Grouping key, e.g. "search-actors" */
    category: z.string().min(1),
    /** Prompt given to the agent */
    query: z.string().min(1),
    /** Requirements the judge scores the conversation against */
    reference: z.string().min(1),
    /** Defaults to the config value */
    maxTurns: z.number().int().positive().optional(),
    /** Tools to enable, e.g. ["actors", "docs", "apify/rag-web-browser"] */
    tools: z.array(z.string()).optional(),
    /** Tools the harness force-fails with a synthetic INTERNAL_ERROR. See mcp_client.ts. */
    failTools: z.array(z.string()).optional(),
});

export type WorkflowTestCase = z.infer<typeof WorkflowTestCaseValidator>;

export type WorkflowTestCaseWithLineNumbers = WorkflowTestCase & TestCaseWithLineNumbers;

const WorkflowTestCasesValidator = z
    .array(WorkflowTestCaseValidator)
    .refine((testCases) => new Set(testCases.map((testCase) => testCase.id)).size === testCases.length, {
        message: 'Test case ids must be unique',
    });

/**
 * Resolve `--test-cases-path` against cwd. Callers must resolve once, up front: the shared
 * reader resolves relative paths against `evals/`, so an unresolved path would name one
 * file and read another.
 */
export function resolveTestCasesPath(filePath?: string): string {
    return filePath ? path.resolve(filePath) : DEFAULT_TEST_CASES_PATH;
}

/** Takes an absolute path from `resolveTestCasesPath`. */
export function loadTestCases(testCasesPath: string): WorkflowTestCase[] {
    return WorkflowTestCasesValidator.parse(loadTestCasesShared(testCasesPath).testCases);
}

/** Line span of one test case object in the raw JSON, located by its "id" field. */
function findLineSpan(fileContent: string, id: string): TestCaseWithLineNumbers {
    const idPosition = fileContent.indexOf(`"id": "${id}"`);
    if (idPosition === -1) {
        throw new Error(`Failed to find test case with id "${id}" in file`);
    }

    // Walk back to the '{' opening this test case, then forward to its match.
    let braceStart = idPosition;
    while (braceStart > 0 && fileContent[braceStart] !== '{') braceStart--;

    let depth = 0;
    let endPosition = braceStart;
    for (let i = braceStart; i < fileContent.length; i++) {
        if (fileContent[i] === '{') depth++;
        if (fileContent[i] === '}') {
            depth--;
            if (depth === 0) {
                endPosition = i;
                break;
            }
        }
    }

    return {
        _lineStart: fileContent.substring(0, idPosition).split('\n').length,
        _lineEnd: fileContent.substring(0, endPosition + 1).split('\n').length,
    };
}

/** Like `loadTestCases`, plus the line span each case occupies, for `--lines` filtering. */
export function loadTestCasesWithLineNumbers(testCasesPath: string): {
    testCases: WorkflowTestCaseWithLineNumbers[];
    totalLines: number;
} {
    const testCases = loadTestCases(testCasesPath);
    const fileContent = fs.readFileSync(testCasesPath, 'utf-8');

    return {
        testCases: testCases.map((testCase) => ({ ...testCase, ...findLineSpan(fileContent, testCase.id) })),
        totalLines: fileContent.split('\n').length,
    };
}
