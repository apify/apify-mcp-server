import type { ValidateFunction } from 'ajv';
import Ajv from 'ajv';

export const ajv = new Ajv({ coerceTypes: 'array', strict: false, removeAdditional: true });

/**
 * Removes the `$schema` property and drops fields with real `default` values from `required`.
 *
 * Per Apify's input-schema spec, "Default + Required doesn't make sense" — a field with a
 * default is effectively optional because the platform fills it in. Zod 4.x `toJSONSchema()`
 * has the same issue: it lists `.default()` fields as required and emits `$schema` that
 * breaks AJV compilation.
 *
 * Uses a value-check (`field.default !== undefined`) instead of key-presence (`'default' in field`)
 * because `filterSchemaProperties()` assigns phantom `default: undefined` on every property (#675).
 *
 * @see https://github.com/apify/apify-mcp-server/issues/637
 */
export function fixZodSchemaRequired(schema: Record<string, unknown>): Record<string, unknown> {
    const cleaned = { ...schema };
    delete cleaned.$schema;

    if (Array.isArray(cleaned.required) && typeof cleaned.properties === 'object' && cleaned.properties !== null) {
        const properties = cleaned.properties as Record<string, unknown>;
        cleaned.required = (cleaned.required as string[]).filter(
            (fieldName) => {
                const fieldSchema = properties[fieldName];
                if (typeof fieldSchema !== 'object' || fieldSchema === null) return true;
                // Value-check (NOT `'default' in fieldSchema`) — see docstring for why.
                return (fieldSchema as { default?: unknown }).default === undefined;
            },
        );
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
