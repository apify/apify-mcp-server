import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads and parses a JSON file relative to the caller's module URL.
 * Resolves the path from the directory of the calling module (via `import.meta.url`).
 *
 * @param importMetaUrl - The `import.meta.url` of the calling module.
 * @param relativePath - The relative path to the JSON file from the calling module.
 * @returns The parsed JSON content.
 * @example
 * const serverJson = readJsonFile(import.meta.url, '../../server.json');
 */
export function readJsonFile<T = unknown>(importMetaUrl: string, relativePath: string): T {
    const jsonPath = resolve(dirname(fileURLToPath(importMetaUrl)), relativePath);
    return JSON.parse(readFileSync(jsonPath, 'utf-8')) as T;
}

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
    return input
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
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
 * Backtick + straight & smart double-quote chars LLMs wrap user inputs in.
 * Shared between `stripQuoteWrappers` (which also strips apostrophes from ids)
 * and `normalizeRecordKey` (which preserves apostrophes in KV record keys).
 * Single source of truth: extend here and both call sites pick it up.
 */
export const QUOTE_WRAPPER_CHARS = '`"“”‘’';

/**
 * Strip surrounding quote/backtick wrappers and whitespace from an LLM-supplied id.
 *
 * LLMs paste names wrapped in markdown backticks or smart quotes; the Apify API
 * treats those as distinct strings and 404s. Strips any leading/trailing run of
 * `` ` ``, `'`, `"` or smart quotes — handles matched pairs, unpaired leakage,
 * and nested wrappers (`` `"id"` ``) uniformly.
 */
const STRIP_QUOTE_WRAPPERS_REGEX = new RegExp(`^[${QUOTE_WRAPPER_CHARS}']+|[${QUOTE_WRAPPER_CHARS}']+$`, 'g');
export function stripQuoteWrappers(s: string): string {
    return s.trim().replace(STRIP_QUOTE_WRAPPERS_REGEX, '').trim();
}

/** Best-effort byte size of a value for summaries. */
export function computeValueBytes(value: unknown): number | undefined {
    if (Buffer.isBuffer(value)) return value.length;
    if (typeof value === 'string') return Buffer.byteLength(value);
    try {
        return Buffer.byteLength(JSON.stringify(value));
    } catch {
        return undefined;
    }
}
