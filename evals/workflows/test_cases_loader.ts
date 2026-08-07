/**
 * Test case loader for workflow evaluations.
 * Uses the shared JSON reader plus workflow-specific validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadTestCases as loadTestCasesShared } from '../shared/test_case_loader.js';
import { WorkflowTestCaseValidator } from '../shared/types.js';
import type { WorkflowTestCase } from '../shared/types.js';

// Re-export WorkflowTestCase type for backwards compatibility
export type { WorkflowTestCase } from '../shared/types.js';

/** The canonical test cases file, resolved from this module so cwd cannot change it. */
export const DEFAULT_TEST_CASES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test_cases.json');

const WorkflowTestCasesValidator = z
    .array(WorkflowTestCaseValidator)
    .refine((testCases) => new Set(testCases.map((testCase) => testCase.id)).size === testCases.length, {
        message: 'Test case ids must be unique',
    });

/**
 * Absolute path of the file a run reads.
 *
 * `--test-cases-path` is resolved against cwd, like any other CLI path argument.
 * Resolving here rather than at each use site is what keeps the existence check,
 * the read and the dataset name pointing at one file: the shared reader resolves
 * relative paths against `evals/`, so an unresolved path would be checked in one
 * place and read from another.
 */
export function resolveTestCasesPath(filePath?: string): string {
    return filePath ? path.resolve(filePath) : DEFAULT_TEST_CASES_PATH;
}

/**
 * Load workflow test cases from a JSON file, validating every case.
 */
export function loadTestCases(filePath?: string): WorkflowTestCase[] {
    const testCasesPath = resolveTestCasesPath(filePath);

    if (!fs.existsSync(testCasesPath)) {
        throw new Error(`Test cases file not found: ${testCasesPath}`);
    }

    return WorkflowTestCasesValidator.parse(loadTestCasesShared(testCasesPath).testCases);
}
