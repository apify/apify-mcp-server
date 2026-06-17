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

/**
 * Operational override: set `APIFY_MCP_DISABLE_TOON=1` to make {@link encodeToon} emit lossless
 * JSON instead of TOON, without a code change or branch switch. Lets the eval harness A/B JSON vs
 * TOON on one branch (the MCP subprocess inherits the env). Distinct from the per-call error
 * fallback in `encodeToon`: this opts out of TOON up front by request, not on encode failure.
 */
function isToonDisabled(): boolean {
    const value = process.env.APIFY_MCP_DISABLE_TOON;
    return value === '1' || value === 'true';
}

function flattenValue(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RangeError('dotFlatten: max depth exceeded');
    if (Array.isArray(value)) return value.map((item) => flattenValue(item, depth + 1));
    if (value !== null && typeof value === 'object') {
        // Null prototype so `key in out` (below) tests own keys only: source keys named like an
        // `Object.prototype` member (`constructor`, `__proto__`, `toString`, …) neither trip a
        // false-positive collision nor reach the prototype setter.
        const out: Record<string, unknown> = Object.create(null);
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
            // Only a genuine normalisation clash remains (`a.b` and `a_b` both map to `a_b`); fail
            // loud so the caller drops TOON and ships lossless JSON instead of overwriting silently.
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
    // Operational opt-out: ship JSON (same fence the catch below uses) when TOON is disabled.
    if (isToonDisabled()) return fence('json', jsonStr);
    try {
        return fence('toon', encode(dotFlatten(JSON.parse(jsonStr))));
    } catch (err) {
        // dotFlatten threw (depth overflow or key collision) or encode failed — ship JSON instead.
        // Log it: the fallback is lossless, but a recurring failure means TOON is silently disabled.
        log.debug('encodeToon: TOON encoding failed, shipping JSON', { err });
        return fence('json', jsonStr);
    }
}
