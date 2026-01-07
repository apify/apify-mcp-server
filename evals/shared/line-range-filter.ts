/**
 * Filter test cases by line ranges
 */

import type { LineRange } from './line-range-parser.js';

/**
 * Type for test cases with line number metadata
 */
export type TestCaseWithLineNumbers = {
    _lineStart: number;
    _lineEnd: number;
    [key: string]: unknown;
};

/**
 * Filter test cases by line ranges (inclusive)
 * A test case is included if it overlaps with ANY of the provided ranges
 *
 * Overlap logic:
 * - Test case overlaps if: testStart <= rangeEnd AND testEnd >= rangeStart
 *
 * Examples:
 * - Range 277-283, Test 280-290 → Included (overlaps)
 * - Range 277-283, Test 270-278 → Included (overlaps)
 * - Range 277-283, Test 284-290 → Excluded (no overlap)
 *
 * @param testCases - Test cases with line number metadata
 * @param ranges - Array of line ranges to filter by
 * @returns Filtered test cases that overlap with any range
 */
export function filterByLineRanges<T extends TestCaseWithLineNumbers>(
    testCases: T[],
    ranges: LineRange[],
): T[] {
    return testCases.filter((tc) => {
        // Include if test case overlaps with ANY range
        // eslint-disable-next-line no-underscore-dangle
        return ranges.some((range) => tc._lineStart <= range.end && tc._lineEnd >= range.start);
    });
}
