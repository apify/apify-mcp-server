/**
 * Shared test case loading and filtering utilities
 */

import { readFileSync } from 'node:fs';
import { dirname as pathDirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaseTestCase, TestData } from './types.js';

/**
 * Load test cases from a JSON file
 * Supports both relative and absolute paths
 *
 * @param filePath - Path to test cases JSON file (relative to caller or absolute)
 * @returns Test data with version and test cases
 */
export function loadTestCases(filePath: string): TestData {
    const filename = fileURLToPath(import.meta.url);
    const dirname = pathDirname(filename);

    // Support both relative (from evals/) and absolute paths
    let testCasesPath: string;
    if (filePath.startsWith('/')) {
        testCasesPath = filePath;
    } else {
        // Relative to evals/ directory (two levels up from shared/)
        testCasesPath = join(dirname, '..', filePath);
    }

    const fileContent = readFileSync(testCasesPath, 'utf-8');
    return JSON.parse(fileContent) as TestData;
}

/**
 * Filter test cases by category
 * Supports wildcard patterns (e.g., "search-actors*" matches "search-actors-1", "search-actors-2", etc.)
 *
 * @param testCases - Array of test cases to filter
 * @param category - Category pattern (supports * wildcard)
 * @returns Filtered test cases
 */
export function filterByCategory<T extends BaseTestCase>(testCases: T[], category: string): T[] {
    // Convert wildcard pattern to regex
    const pattern = category.replace(/\*/g, '.*');
    const regex = new RegExp(`^${pattern}$`);

    return testCases.filter((testCase) => regex.test(testCase.category));
}

/**
 * Filter test cases by ID using regex pattern
 *
 * @param testCases - Array of test cases to filter
 * @param idPattern - Regex pattern to match against test case IDs
 * @returns Filtered test cases
 */
export function filterById<T extends BaseTestCase>(testCases: T[], idPattern: string): T[] {
    const regex = new RegExp(idPattern);
    return testCases.filter((testCase) => regex.test(testCase.id));
}

/**
 * Filter test cases by ID or category
 * Generic filter function for workflow evaluations
 *
 * @param testCases - Array of test cases to filter
 * @param options - Filter options (id and/or category)
 * @returns Filtered test cases
 */
export function filterTestCases<T extends BaseTestCase>(
    testCases: T[],
    options: { id?: string; category?: string },
): T[] {
    let filtered = testCases;

    if (options.id) {
        filtered = filterById(filtered, options.id);
    }

    if (options.category) {
        filtered = filterByCategory(filtered, options.category);
    }

    return filtered;
}
