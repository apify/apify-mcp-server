import type { ValidateFunction } from 'ajv';
import Ajv from 'ajv';

/**
 * Once the generated code is handed over, Ajv starts the code of a schema that has an `$id` with a comment that
 * names the code after it. The name is not needed, and the engine keeps named code longer.
 */
const CODE_NAME_COMMENT = /\/\*# sourceURL=[\s\S]*?\*\//;

const hasSchemaId = (schema: unknown): boolean =>
    typeof schema === 'object' && schema !== null && '$id' in schema && typeof schema.$id === 'string';

/**
 * Ajv with the server's validation policy. One instance per compile, never shared: Ajv caches every compiled
 * schema in a Map that is never evicted.
 *
 * `checkCode` receives the code of every validator function Ajv generates, before the function is created; what
 * it throws fails the compilation. The code has no text of an `$id` in it: see `CODE_NAME_COMMENT`, which relies
 * on `compileUntrustedSchema` refusing an `$id` that holds the end of a comment.
 */
export function createAjv(checkCode?: (code: string) => void): Ajv {
    const instance = new Ajv({
        coerceTypes: 'array',
        strict: false,
        removeAdditional: true,
        // On a failed compilation Ajv writes the whole generated validator source to the console.
        logger: false,
        // The optimization pass only shortens the generated code, and its time grows with the square of
        // the schema size: without it a schema with 1,000 properties compiles about four times faster.
        code: {
            optimize: false,
            process: (code, schemaEnv) => {
                const unnamedCode = hasSchemaId(schemaEnv?.schema) ? code.replace(CODE_NAME_COMMENT, '') : code;
                checkCode?.(unnamedCode);
                return unnamedCode;
            },
        },
    });

    // `pattern`/`patternProperties` compile a RegExp from untrusted Actor / proxied-MCP input schemas;
    // a catastrophic-backtracking pattern freezes the single-threaded event loop (ReDoS). `format` is
    // inert today (ajv-formats is not registered) but would arm the same vector if it ever were. This
    // layer only sanitizes LLM args — the Actor re-validates its real input on the run — so dropping
    // regex enforcement removes the DoS surface with no loss of protection. Consequence for `src/`
    // schemas: a `.regex()` on a Zod field is NOT enforced here. It still reaches `tools/list` and still
    // fires in a tool body's `parse()`, which the server reports as invalid arguments. `taskNameSchema`
    // (`tools/tasks/task_helpers.ts`) carries one.
    instance.removeKeyword('pattern');
    instance.removeKeyword('patternProperties');
    instance.removeKeyword('format');
    return instance;
}

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
 * (set in `createAjv`). MCP / LLM clients regularly send extra top-level keys
 * (client metadata, duplicated hints, transport leftovers) that would otherwise cause validation
 * failures. Stripping them is safer than allowing them through with `additionalProperties: true`,
 * because no downstream code should rely on undeclared properties.
 *
 * **Payment fields** (e.g. Skyfire's `skyfire-pay-id`) are removed by the payment provider's
 * `removePaymentFields()` *before* AJV validation runs (see `prepareToolCallContext()`),
 * so they are never subject to this stripping.
 */
export function compileSchema(schema: Record<string, unknown>): ValidateFunction {
    return createAjv().compile(fixZodSchemaRequired(schema));
}
