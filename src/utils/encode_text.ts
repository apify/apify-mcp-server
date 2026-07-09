/** Markdown code fences keyed by encoding. Labels are ASCII, so char length == byte length. */
const FENCES = {
    json: { prefix: '```json\n', suffix: '\n```' },
} as const;

/** Wrap an already-encoded body in the Markdown code fence for its format. */
function fence(format: keyof typeof FENCES, body: string): string {
    return `${FENCES[format].prefix}${body}${FENCES[format].suffix}`;
}

/**
 * Wrap a JSON-serialisable value in a ```json code fence. Used by single-object tools, which have
 * no `structuredContent` fallback, so this can never emit anything but JSON.
 */
export function wrapJsonText(value: unknown): string {
    return fence('json', JSON.stringify(value));
}
