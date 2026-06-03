import { encode } from '@toon-format/toon';

import { JSON_FENCE_PREFIX, JSON_FENCE_SUFFIX } from './mcp.js';

/**
 * Recursion guard for {@link dotFlatten}. The deepest real Apify-API fixture measured is
 * depth 9 (a user-declared dataset schema), so 20 leaves a comfortable margin while still
 * stopping runaway recursion on pathological input.
 */
const MAX_DEPTH = 20;

export const TOON_FENCE_PREFIX = '```toon\n';
export const TOON_FENCE_SUFFIX = '\n```';

function flattenValue(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RangeError('dotFlatten: max depth exceeded');
    if (Array.isArray(value)) return value.map((item) => flattenValue(item, depth + 1));
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        flattenInto(value as Record<string, unknown>, '', depth, out);
        return out;
    }
    return value; // scalar or null — unchanged
}

function flattenInto(obj: Record<string, unknown>, prefix: string, depth: number, out: Record<string, unknown>): void {
    if (depth > MAX_DEPTH) throw new RangeError('dotFlatten: max depth exceeded');
    for (const [rawKey, v] of Object.entries(obj)) {
        // `.` is the nesting separator, so normalise any literal dot in a source key to avoid
        // ambiguity. The collision guard below catches the case where this would overwrite a key.
        const key = prefix ? `${prefix}.${rawKey.replaceAll('.', '_')}` : rawKey.replaceAll('.', '_');
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            flattenInto(v as Record<string, unknown>, key, depth + 1, out); // lift nested object into dotted keys
        } else {
            // `out` is a plain object, so a source key equal to an Object.prototype member
            // (`constructor`, `__proto__`, `toString`, …) trips this guard as a false positive and
            // drops the TOON candidate — JSON still ships, lossless. Apify payload keys are never
            // named this, so we accept it rather than carry a null-prototype map.
            if (key in out) throw new RangeError(`dotFlatten: key collision on "${key}"`);
            out[key] = flattenValue(v, depth + 1); // scalars unchanged; arrays recursed into
        }
    }
}

/**
 * Lifts nested-object keys into dot-joined top-level keys so arrays of uniform objects qualify
 * for TOON's tabular form. Arrays are preserved (each object element flattened individually);
 * scalars, null, and inline scalar arrays are unchanged. Throws `RangeError` on depth overflow
 * or a normalisation collision — the caller drops the TOON candidate and ships JSON.
 *
 * Lossy w.r.t. the original key names only when a source key contains a literal `.`
 * (normalised to `_`); `structuredContent` preserves the originals for programmatic consumers.
 */
export function dotFlatten(value: unknown): unknown {
    return flattenValue(value, 0);
}

/**
 * Encodes a JSON-serialisable value as fenced text for the LLM, shipping whichever of the JSON or
 * dot-flattened-TOON encodings is smaller (UTF-8 bytes). JSON is always a candidate, so the result
 * is never larger than the plain JSON fence; the TOON candidate is dropped if `dotFlatten`/`encode`
 * throws.
 *
 * The text may be TOON — programmatic JSON consumers must read `structuredContent` instead. Only
 * wire this on tools that ship `structuredContent` as the JSON fallback.
 */
export function encodeCompactText(value: unknown): string {
    // Single source of truth: both candidates derive from this one serialisation, so the TOON
    // candidate can never encode different data than JSON. A `Date` (or any `toJSON` carrier)
    // becomes its ISO string here, not an empty object — `dotFlatten` works on the JSON data
    // model only. A non-serialisable value (circular, BigInt) throws here; API payloads are
    // always JSON, so let it crash.
    const jsonStr = JSON.stringify(value);
    const json = `${JSON_FENCE_PREFIX}${jsonStr}${JSON_FENCE_SUFFIX}`;
    let toon: string | undefined;
    try {
        toon = `${TOON_FENCE_PREFIX}${encode(dotFlatten(JSON.parse(jsonStr)))}${TOON_FENCE_SUFFIX}`;
    } catch {
        // dotFlatten threw (depth overflow or key collision) or encode failed — JSON ships.
    }
    return toon !== undefined && Buffer.byteLength(toon, 'utf8') < Buffer.byteLength(json, 'utf8') ? toon : json;
}
