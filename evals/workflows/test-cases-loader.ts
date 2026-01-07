/**
 * Test case loader and filter for workflow evaluations
 * Uses shared utilities with workflow-specific validation
 */

import fs from 'node:fs';
import path from 'node:path';

import { filterTestCases as filterTestCasesShared, loadTestCases as loadTestCasesShared } from '../shared/test-case-loader.js';
import type { WorkflowTestCase } from '../shared/types.js';

// Re-export WorkflowTestCase type for backwards compatibility
export type { WorkflowTestCase } from '../shared/types.js';

/**
 * Load workflow test cases from JSON file with validation
 */
export function loadTestCases(filePath?: string): WorkflowTestCase[] {
    const testCasesPath = filePath || path.join(process.cwd(), 'evals/workflows/test-cases.json');

    if (!fs.existsSync(testCasesPath)) {
        throw new Error(`Test cases file not found: ${testCasesPath}`);
    }

    // Use shared loader
    const testData = loadTestCasesShared(testCasesPath);
    const testCases = testData.testCases as WorkflowTestCase[];

    // Validate test cases
    const seenIds = new Set<string>();

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const testCaseRef = `Test case #${i + 1} (id: ${tc.id || 'missing'})`;

        // Check required fields
        const missingFields: string[] = [];
        if (!tc.id) missingFields.push('id');
        if (!tc.category) missingFields.push('category');
        if (!tc.query) missingFields.push('query');
        if (!tc.reference) missingFields.push('reference');

        if (missingFields.length > 0) {
            throw new Error(
                `${testCaseRef}: Missing or empty required field(s): ${missingFields.join(', ')}\n`
                + `Required fields: id, category, query, reference\n`
                + `Test case: ${JSON.stringify(tc, null, 2)}`,
            );
        }

        // Check for duplicate IDs
        if (seenIds.has(tc.id)) {
            throw new Error(
                `${testCaseRef}: Duplicate test case ID '${tc.id}'\n`
                + `Each test case must have a unique ID.`,
            );
        }
        seenIds.add(tc.id);
    }

    return testCases;
}

/**
 * Filter test cases by ID or category
 * Wrapper around shared filter function
 */
export function filterTestCases(
    testCases: WorkflowTestCase[],
    options: { id?: string; category?: string },
): WorkflowTestCase[] {
    return filterTestCasesShared(testCases, options);
}
