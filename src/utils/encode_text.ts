import { encode } from '@toon-format/toon';

import log from '@apify/log';

/**
 * Recursion guard for {@link dotFlatten}. The deepest real Apify-API fixture measured is
 * depth 9 (a user-declared dataset schema), so 20 leaves a comfortable margin while still
 * stopping runaway recursion on pathological input.
 */
const MAX_DEPTH = 20;

/** Markdown code fences keyed by encoding. Labels are ASCII, so char length == byte length. */
export const FENCES = {
    json: { prefix: '```json\n', suffix: '\n```' },
    toon: { prefix: '```toon\n', suffix: '\n```' },
} as const;

/** Wrap an already-encoded body in the Markdown code fence for its format. */
function fence(format: keyof typeof FENCES, body: string): string {
    return `${FENCES[format].prefix}${body}${FENCES[format].suffix}`;
}

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
            // `out` is a plain object, so a source key equal to an `Object.prototype` member
            // (`constructor`, `__proto__`, `toString`, `valueOf`, …) matches `in` on an empty
            // object and trips this guard as a FALSE-positive collision. Such keys can legitimately
            // occur in user/scraper-controlled `get-dataset-items` payloads; when they do, the TOON
            // candidate is dropped and JSON ships — lossless. Accepted, not fixed: a null-prototype
            // `out` (`Object.create(null)`) would remove the false positive, but the current guard
            // also fires before assignment, so a `__proto__` key cannot reach the prototype setter.
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
 * Wrap a JSON-serialisable value in a ```json code fence. Used by single-object tools, which have
 * no `structuredContent` fallback, so this can never emit anything but JSON.
 */
export function wrapJsonText(value: unknown): string {
    return fence('json', JSON.stringify(value));
}

/**
 * Encodes a JSON-serialisable value as a dot-flattened ```toon code fence for the LLM, falling back
 * to a ```json fence only if `dotFlatten`/`encode` throws (depth overflow or a normalisation key
 * collision). TOON is the stable shape; JSON is the error path, not a byte-driven alternative.
 *
 * The text may be TOON — programmatic JSON consumers must read `structuredContent` instead. Only
 * wire this on tools that ship `structuredContent` as the JSON fallback.
 */
export function encodeToon(value: unknown): string {
    // `value` is serialised through JSON so `dotFlatten` works on the JSON data model only: a `Date`
    // (or any `toJSON` carrier) becomes its ISO string here, not an empty object. A non-serialisable
    // value (circular, BigInt) throws here; API payloads are always JSON, so let it crash.
    const jsonStr = JSON.stringify(value);
    try {
        return fence('toon', encode(dotFlatten(JSON.parse(jsonStr))));
    } catch (err) {
        // dotFlatten threw (depth overflow or key collision) or encode failed — ship JSON instead.
        // Log it: the fallback is lossless, but a recurring failure means TOON is silently disabled.
        log.warning('encodeToon: TOON encoding failed, shipping JSON', { err });
        return fence('json', jsonStr);
    }
}
