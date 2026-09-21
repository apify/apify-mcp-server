/**
 * Shared test case filtering utilities
 */

import type { BaseTestCase } from './types.js';

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
