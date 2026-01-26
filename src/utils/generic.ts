/**
 * Parses a comma-separated string into an array of trimmed strings.
 * Empty strings are filtered out after trimming.
 *
 * @param input - The comma-separated string to parse. If undefined, returns an empty array.
 * @returns An array of trimmed, non-empty strings.
 * @example
 * parseCommaSeparatedList("a, b, c"); // ["a", "b", "c"]
 * parseCommaSeparatedList("a, , b"); // ["a", "b"]
 */
export function parseCommaSeparatedList(input?: string): string[] {
    if (!input) {
        return [];
    }
    return input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parses a query parameter that can be either a string or an array of strings.
 * Handles comma-separated values in strings and filters out empty values.
 *
 * @param param - A query parameter that can be a string, array of strings, or undefined
 * @returns An array of trimmed, non-empty strings
 * @example
 * parseQueryParamList("a,b,c"); // ["a", "b", "c"]
 * parseQueryParamList(["a", "b"]); // ["a", "b"]
 * parseQueryParamList(undefined); // []
 */
export function parseQueryParamList(param?: string | string[]): string[] {
    if (!param) {
        return [];
    }
    if (Array.isArray(param)) {
        return param.flatMap((item) => parseCommaSeparatedList(item));
    }
    return parseCommaSeparatedList(param);
}

/**
 * Recursively gets the value in a nested object for each key in the keys array.
 * Each key can be a dot-separated path (e.g. 'a.b.c').
 * Returns an object mapping each key to its resolved value (or undefined if not found).
 *
 * @example
 * const obj = { a: { b: { c: 42 } }, nested: { d: 100 } };
 * const value = getValuesByDotKeys(obj, ['a.b.c', 'a.b.d', 'nested']);
 * value; // { 'a.b.c': 42, 'a.b.d': undefined, 'nested': { d: 100 } }
 */
export function getValuesByDotKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
        const path = key.split('.');
        let current: unknown = obj;
        for (const segment of path) {
            if (
                current !== null
                && typeof current === 'object'
                && Object.prototype.hasOwnProperty.call(current, segment)
            ) {
                // Use index signature to avoid 'any' and type errors
                current = (current as Record<string, unknown>)[segment];
            } else {
                current = undefined;
                break;
            }
        }
        result[key] = current;
    }
    return result;
}

/**
 * Validates whether a given string is a well-formed URL.
 *
 * Allows only valid HTTP or HTTPS URLs.
 */
export function isValidHttpUrl(urlString: string): boolean {
    if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
        return false;
    }
    try {
        /* eslint-disable no-new */
        new URL(urlString);
        return true;
    } catch {
        return false;
    }
}
