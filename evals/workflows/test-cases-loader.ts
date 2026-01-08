/**
 * Test case loader and filter for workflow evaluations
 * Uses shared utilities with workflow-specific validation
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseWithLineNumbers } from '../shared/line-range-filter.js';
import { filterTestCases as filterTestCasesShared, loadTestCases as loadTestCasesShared } from '../shared/test-case-loader.js';
import type { WorkflowTestCase } from '../shared/types.js';

// Re-export WorkflowTestCase type for backwards compatibility
export type { WorkflowTestCase } from '../shared/types.js';

/**
 * Workflow test case with line number metadata
 */
export type WorkflowTestCaseWithLineNumbers = WorkflowTestCase & TestCaseWithLineNumbers;

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

/**
 * Load test cases with line number metadata
 * Tracks which lines each test case spans in the JSON file
 *
 * @param filePath - Optional path to test cases JSON file
 * @returns Test cases with line numbers and total line count
 */
export function loadTestCasesWithLineNumbers(filePath?: string): {
    testCases: WorkflowTestCaseWithLineNumbers[];
    totalLines: number;
} {
    const testCasesPath = filePath || path.join(process.cwd(), 'evals/workflows/test-cases.json');

    if (!fs.existsSync(testCasesPath)) {
        throw new Error(`Test cases file not found: ${testCasesPath}`);
    }

    // Read file content and parse
    const fileContent = fs.readFileSync(testCasesPath, 'utf-8');
    const lines = fileContent.split('\n');
    const totalLines = lines.length;

    // Parse JSON
    const testData = JSON.parse(fileContent);
    const testCases = testData.testCases as WorkflowTestCase[];

    // Validate test cases (same as loadTestCases)
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

    // Attach line numbers to each test case by finding their position in the file
    const testCasesWithLines: WorkflowTestCaseWithLineNumbers[] = [];

    for (const tc of testCases) {
        // Find this test case's "id" field in the file to locate it
        const searchPattern = `"id": "${tc.id}"`;
        const idPosition = fileContent.indexOf(searchPattern);

        if (idPosition === -1) {
            throw new Error(`Failed to find test case with id "${tc.id}" in file`);
        }

        // Count newlines up to this position to get line start
        const contentBeforeId = fileContent.substring(0, idPosition);
        const lineStart = contentBeforeId.split('\n').length;

        // Find the closing brace for this test case object
        // Start from the opening brace before the id field
        let braceStart = idPosition;
        while (braceStart > 0 && fileContent[braceStart] !== '{') {
            braceStart--;
        }

        // Now count braces forward from here
        let braceCount = 0;
        let endPosition = braceStart;

        for (let j = braceStart; j < fileContent.length; j++) {
            if (fileContent[j] === '{') {
                braceCount++;
            }
            if (fileContent[j] === '}') {
                braceCount--;
                if (braceCount === 0) {
                    endPosition = j;
                    break;
                }
            }
        }

        // Count newlines up to end position
        const contentToEnd = fileContent.substring(0, endPosition + 1);
        const lineEnd = contentToEnd.split('\n').length;

        testCasesWithLines.push({
            ...tc,
            _lineStart: lineStart,
            _lineEnd: lineEnd,
        });
    }

    return {
        testCases: testCasesWithLines,
        totalLines,
    };
}
