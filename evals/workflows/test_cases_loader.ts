/**
 * Test case loader for workflow evaluations.
 * Uses the shared JSON reader plus workflow-specific validation.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { loadTestCases as loadTestCasesShared } from '../shared/test_case_loader.js';
import { WorkflowTestCaseValidator } from '../shared/types.js';
import type { WorkflowTestCase } from '../shared/types.js';

// Re-export WorkflowTestCase type for backwards compatibility
export type { WorkflowTestCase } from '../shared/types.js';

const WorkflowTestCasesValidator = z
    .array(WorkflowTestCaseValidator)
    .refine((testCases) => new Set(testCases.map((testCase) => testCase.id)).size === testCases.length, {
        message: 'Test case ids must be unique',
    });

/**
 * Load workflow test cases from a JSON file, validating every case.
 */
export function loadTestCases(filePath?: string): WorkflowTestCase[] {
    const testCasesPath = filePath || path.join(process.cwd(), 'evals/workflows/test_cases.json');

    if (!fs.existsSync(testCasesPath)) {
        throw new Error(`Test cases file not found: ${testCasesPath}`);
    }

    return WorkflowTestCasesValidator.parse(loadTestCasesShared(testCasesPath).testCases);
}
