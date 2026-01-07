/**
 * Line range parser for filtering test cases by line numbers in JSON file
 */

export type LineRange = {
    start: number;
    end: number;
};

/**
 * Parse line range string into array of ranges
 * Supports formats:
 * - Single line: "100" → [{start: 100, end: 100}]
 * - Range: "10-20" → [{start: 10, end: 20}]
 * - Multiple: "10-20,50-60,100" → [{start: 10, end: 20}, {start: 50, end: 60}, {start: 100, end: 100}]
 *
 * @param rangeString - Line range string (e.g., "10-20,50-60,100")
 * @returns Array of line ranges
 * @throws Error if format is invalid
 */
export function parseLineRanges(rangeString: string): LineRange[] {
    const trimmed = rangeString.trim();
    if (!trimmed) {
        throw new Error('Line range string cannot be empty');
    }

    const parts = trimmed.split(',').map((p) => p.trim());
    const ranges: LineRange[] = [];

    for (const part of parts) {
        if (!part) {
            throw new Error('Empty range part found (check for extra commas)');
        }

        if (part.includes('-')) {
            // Range format: "10-20"
            const rangeParts = part.split('-');
            if (rangeParts.length !== 2) {
                throw new Error(`Invalid range format: "${part}" (expected format: "start-end")`);
            }

            const start = parseInt(rangeParts[0].trim(), 10);
            const end = parseInt(rangeParts[1].trim(), 10);

            if (Number.isNaN(start) || Number.isNaN(end)) {
                throw new Error(`Invalid range: "${part}" (start and end must be integers)`);
            }

            if (start <= 0 || end <= 0) {
                throw new Error(`Invalid range: "${part}" (line numbers must be positive)`);
            }

            if (start > end) {
                throw new Error(`Invalid range: "${part}" (start must be <= end)`);
            }

            ranges.push({ start, end });
        } else {
            // Single line: "100"
            const line = parseInt(part, 10);

            if (Number.isNaN(line)) {
                throw new Error(`Invalid line number: "${part}" (must be an integer)`);
            }

            if (line <= 0) {
                throw new Error(`Invalid line number: "${part}" (must be positive)`);
            }

            ranges.push({ start: line, end: line });
        }
    }

    return ranges;
}

/**
 * Validate that line ranges are valid (no overlaps, sorted, etc.)
 * Currently just checks basic constraints (already done in parseLineRanges)
 *
 * @param ranges - Array of line ranges
 * @throws Error if validation fails
 */
export function validateLineRanges(ranges: LineRange[]): void {
    if (ranges.length === 0) {
        throw new Error('No line ranges provided');
    }

    // All validation is already done in parseLineRanges
    // This function exists for future extensibility
}

/**
 * Check if any range is out of bounds
 *
 * @param ranges - Array of line ranges
 * @param maxLine - Maximum line number in file
 * @returns true if any range starts beyond maxLine
 */
export function checkRangesOutOfBounds(ranges: LineRange[], maxLine: number): boolean {
    return ranges.some((range) => range.start > maxLine);
}
