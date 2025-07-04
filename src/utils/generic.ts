/**
 * Recursively gets the value in a nested object for each key in the keys array.
 * Each key can be a dot-separated path (e.g. 'a.b.c').
 * Returns an object mapping each key to its resolved value (or undefined if not found).
 */
export function getValuesByDotKeys<T extends object>(obj: T, keys: string[]): Record<string, unknown> {
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
