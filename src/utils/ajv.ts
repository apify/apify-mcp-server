import type { ValidateFunction } from 'ajv';
import Ajv from 'ajv';

import type { ValidationInputChange } from '../types.js';

export const ajv = new Ajv({ coerceTypes: 'array', strict: false, removeAdditional: true });

// `pattern`/`patternProperties` compile a RegExp from untrusted Actor / proxied-MCP input schemas;
// a catastrophic-backtracking pattern freezes the single-threaded event loop (ReDoS). `format` is
// inert today (ajv-formats is not registered) but would arm the same vector if it ever were. This
// layer only sanitizes LLM args — the Actor re-validates its real input on the run — so dropping
// regex enforcement removes the DoS surface with no loss of protection. Consequence for `src/`
// schemas: a `.regex()` on a Zod field is NOT enforced here. It still reaches `tools/list` and still
// fires in a tool body's `parse()`, where it throws a raw ZodError at the client instead of a
// readable error — so rely on the API's own validation rather than adding one. `taskNameSchema`
// (`tools/tasks/task_helpers.ts`) still carries one and predates this note.
ajv.removeKeyword('pattern');
ajv.removeKeyword('patternProperties');
ajv.removeKeyword('format');

/**
 * Removes the `$schema` property and drops fields with real `default` values from `required`.
 *
 * Per Apify's input-schema spec, "Default + Required doesn't make sense" — a field with a
 * default is effectively optional because the platform fills it in. Zod 4.x `toJSONSchema()`
 * has the same issue: it lists `.default()` fields as required and emits `$schema` that
 * breaks AJV compilation.
 *
 * Uses a value-check (`field.default !== undefined`), not key-presence (`'default' in field`):
 * `default: undefined` must mean "no default" regardless of producer. `filterSchemaProperties()`
 * no longer emits it (#675), but hand-built schemas and future call sites still can — apify-core's
 * equivalent (`getAjvValidator`, `input_schema.both.ts`) applies the same value-check rule.
 *
 * @see https://github.com/apify/apify-mcp-server/issues/637
 */
export function fixZodSchemaRequired(schema: Record<string, unknown>): Record<string, unknown> {
    const cleaned = { ...schema };
    delete cleaned.$schema;

    if (Array.isArray(cleaned.required) && typeof cleaned.properties === 'object' && cleaned.properties !== null) {
        const properties = cleaned.properties as Record<string, unknown>;
        cleaned.required = (cleaned.required as string[]).filter((fieldName) => {
            const fieldSchema = properties[fieldName];
            if (typeof fieldSchema !== 'object' || fieldSchema === null) return true;
            return (fieldSchema as { default?: unknown }).default === undefined;
        });
    }

    return cleaned;
}

/**
 * Compiles a JSON schema with AJV, automatically cleaning the $schema property
 * and fixing the required array.
 *
 * **Unknown properties are silently stripped** by the AJV `removeAdditional: true` option
 * (set on the shared `ajv` instance). MCP / LLM clients regularly send extra top-level keys
 * (client metadata, duplicated hints, transport leftovers) that would otherwise cause validation
 * failures. Stripping them is safer than allowing them through with `additionalProperties: true`,
 * because no downstream code should rely on undeclared properties.
 *
 * **Payment fields** (e.g. Skyfire's `skyfire-pay-id`) are removed by the payment provider's
 * `removePaymentFields()` *before* AJV validation runs (see `prepareToolCallContext()`),
 * so they are never subject to this stripping.
 */
export function compileSchema(schema: Record<string, unknown>): ValidateFunction {
    return ajv.compile(fixZodSchemaRequired(schema));
}

/**
 * What a passing check changed in an input, comparing a snapshot taken before the check with the input
 * after it: `coerced` when a value changed JSON type (including scalar-to-array and back), `removed` when
 * a key was dropped from an object, at any depth. `undefined` when nothing changed.
 */
export function getValidationInputChange(before: unknown, after: unknown): ValidationInputChange | undefined {
    const { isCoerced, isRemoved } = findInputChanges(before, after);
    if (isCoerced && isRemoved) return 'coerced_and_removed';
    if (isCoerced) return 'coerced';
    if (isRemoved) return 'removed';
    return undefined;
}

function getJsonType(value: unknown): string {
    if (value === null) return 'null';
    return Array.isArray(value) ? 'array' : typeof value;
}

function findInputChanges(before: unknown, after: unknown): { isCoerced: boolean; isRemoved: boolean } {
    if (getJsonType(before) !== getJsonType(after)) return { isCoerced: true, isRemoved: false };
    const changes = { isCoerced: false, isRemoved: false };
    if (typeof before !== 'object' || before === null) return changes;
    // Arrays walk by index: AJV never drops an item, so only nested values can change.
    const afterEntries = after as Record<string, unknown>;
    for (const [key, value] of Object.entries(before)) {
        if (!Object.hasOwn(afterEntries, key)) {
            changes.isRemoved = true;
            continue;
        }
        const nested = findInputChanges(value, afterEntries[key]);
        changes.isCoerced ||= nested.isCoerced;
        changes.isRemoved ||= nested.isRemoved;
    }
    return changes;
}
