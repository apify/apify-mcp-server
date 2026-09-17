/**
 * Test case filtering utilities
 */

/** The fields {@link filterByCategory} and {@link filterById} match on. */
type FilterableTestCase = {
    id: string;
    category: string;
};

/**
 * Filter test cases by category. Supports wildcard patterns (e.g., "search-actors*" matches
 * "search-actors-1", "search-actors-2", etc.)
 */
export function filterByCategory<T extends FilterableTestCase>(testCases: T[], category: string): T[] {
    // Convert wildcard pattern to regex
    const pattern = category.replace(/\*/g, '.*');
    const regex = new RegExp(`^${pattern}$`);

    return testCases.filter((testCase) => regex.test(testCase.category));
}

/** Filter test cases by ID using regex pattern. */
export function filterById<T extends FilterableTestCase>(testCases: T[], idPattern: string): T[] {
    const regex = new RegExp(idPattern);
    return testCases.filter((testCase) => regex.test(testCase.id));
}
