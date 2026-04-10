import type { ValidateFunction } from 'ajv';
import Ajv from 'ajv';

export const ajv = new Ajv({ coerceTypes: 'array', strict: false, removeAdditional: true });

/**
 * Removes the $schema property and fixes the required array from a JSON schema.
 * The z.toJSONSchema() function in Zod 4.x has two issues:
 * 1. Includes a $schema reference that can cause issues when compiling with AJV
 * 2. Incorrectly marks fields with default values as required
 *
 * This function fixes both issues to ensure proper schema validation.
 * Exported so MCP tool listings can apply the same fix via `fixZodInputSchemaRequired` (see `getToolPublicFieldOnly`).
 */
export function fixZodSchemaRequired(schema: Record<string, unknown>): Record<string, unknown> {
    const cleaned = { ...schema };
    delete cleaned.$schema;

    // Fix the required array: remove fields that have default values
    if (Array.isArray(cleaned.required) && typeof cleaned.properties === 'object' && cleaned.properties !== null) {
        const properties = cleaned.properties as Record<string, unknown>;
        cleaned.required = (cleaned.required as string[]).filter(
            (fieldName) => {
                const fieldSchema = properties[fieldName];
                // Only include in required if the field doesn't have a default value
                return !(typeof fieldSchema === 'object' && fieldSchema !== null && 'default' in fieldSchema);
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
