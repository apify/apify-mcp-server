/**
 * Test case loader and filter for workflow evaluations
 * Uses shared utilities with workflow-specific validation
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TestCaseWithLineNumbers } from '../shared/line_range_filter.js';
import {
    filterTestCases as filterTestCasesShared,
    loadTestCases as loadTestCasesShared,
} from '../shared/test_case_loader.js';
import { WORKFLOW_EVAL_ARM, type WorkflowTestCase } from '../shared/types.js';

// Re-export WorkflowTestCase type for backwards compatibility
export type { WorkflowTestCase } from '../shared/types.js';

/**
 * Workflow test case with line number metadata
 */
export type WorkflowTestCaseWithLineNumbers = WorkflowTestCase & TestCaseWithLineNumbers;

function validateTestCases(testCases: WorkflowTestCase[]): void {
    const seenIds = new Set<string>();

    for (let index = 0; index < testCases.length; index++) {
        const testCase = testCases[index];
        const testCaseRef = `Test case #${index + 1} (id: ${testCase.id || 'missing'})`;
        const missingFields: string[] = [];
        if (!testCase.id) missingFields.push('id');
        if (!testCase.category) missingFields.push('category');
        if (!testCase.query) missingFields.push('query');
        if (!testCase.reference) missingFields.push('reference');

        if (missingFields.length > 0) {
            throw new Error(
                `${testCaseRef}: Missing or empty required field(s): ${missingFields.join(', ')}\n` +
                    `Required fields: id, category, query, reference\n` +
                    `Test case: ${JSON.stringify(testCase, null, 2)}`,
            );
        }
        if (seenIds.has(testCase.id)) {
            throw new Error(
                `${testCaseRef}: Duplicate test case ID '${testCase.id}'\nEach test case must have a unique ID.`,
            );
        }
        seenIds.add(testCase.id);

        const enabledTools = new Set(testCase.tools);
        const duplicateTool = testCase.disallowedTools?.find((tool) => enabledTools.has(tool));
        if (duplicateTool) {
            throw new Error(`${testCaseRef}: Tool '${duplicateTool}' is both enabled and disallowed.`);
        }

        const allowedTargets = new Set(testCase.allowedCallActorTargets);
        const duplicateTarget = testCase.disallowedCallActorTargets?.find((target) => allowedTargets.has(target));
        if (duplicateTarget) {
            throw new Error(`${testCaseRef}: Actor target '${duplicateTarget}' is both allowed and disallowed.`);
        }

        if (testCase.arm && !Object.values(WORKFLOW_EVAL_ARM).includes(testCase.arm)) {
            throw new Error(`${testCaseRef}: Unsupported evaluation arm '${testCase.arm}'.`);
        }
    }

    const pairs = new Map<string, WorkflowTestCase[]>();
    for (const testCase of testCases) {
        if (!testCase.pairId) continue;
        pairs.set(testCase.pairId, [...(pairs.get(testCase.pairId) ?? []), testCase]);
    }
    for (const [pairId, pair] of pairs) {
        if (new Set(pair.map((testCase) => testCase.query)).size > 1) {
            throw new Error(`Test case pair '${pairId}' must use the same query in every arm.`);
        }
    }
}

/**
 * Load workflow test cases from JSON file with validation
 */
export function loadTestCases(filePath?: string): WorkflowTestCase[] {
    const testCasesPath = path.resolve(filePath || path.join(process.cwd(), 'evals/workflows/test_cases.json'));

    if (!fs.existsSync(testCasesPath)) {
        throw new Error(`Test cases file not found: ${testCasesPath}`);
    }

    // Use shared loader
    const testData = loadTestCasesShared(testCasesPath);
    const testCases = testData.testCases as WorkflowTestCase[];

    validateTestCases(testCases);
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
    const testCasesPath = path.resolve(filePath || path.join(process.cwd(), 'evals/workflows/test_cases.json'));

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

    validateTestCases(testCases);

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
