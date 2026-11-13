import { createHash } from 'node:crypto';

import type { ValidateFunction } from 'ajv';

import { LruCache } from '@apify/datastructures';

import { ACTOR_ENUM_MAX_LENGTH, ACTOR_MAX_DESCRIPTION_LENGTH } from '../const.js';
import { SchemaTooLargeError } from '../errors.js';
import type { ActorInputSchema, SchemaProperties } from '../types.js';
import { createAjv, fixZodSchemaRequired } from '../utils/ajv.js';
import {
    addGlobsProperties,
    addKeyValueProperties,
    addProxyProperties,
    addPseudoUrlsProperties,
    addRequestListSourcesProperties,
    addResourcePickerProperties as addArrayResourcePickerProperties,
} from '../utils/apify_properties.js';
import { getToolSchemaID } from './actor_tool_naming.js';

type ActorInputSchemaProperties = Record<string, SchemaProperties>;

// Real Apify Actor input schemas run up to ~140 KB post-transform; cap at 256 KB to bound AJV's
// synchronous codegen so a pathological untrusted schema can't freeze the event loop. Only the
// untrusted callers (actor_tools_factory, mcp/proxy) reach AJV through here; trusted compileSchema()
// is intentionally uncapped. A schema that a `$ref` points to counts again at every place Ajv compiles it.
export const MAX_UNTRUSTED_SCHEMA_BYTES = 262_144;

/**
 * Bytes alone do not bound the compile time, which grows with the number of subschemas Ajv generates code for;
 * a schema that a `$ref` points to counts again at every place Ajv compiles it. A generous backstop: the
 * largest input schema of a public Actor in the Apify Store (2026-10) has 784 subschemas.
 */
export const MAX_UNTRUSTED_SUBSCHEMAS = 2000;

/**
 * The generated validator builds the path of a failing value from every level above it, so its size grows
 * faster than the schema as subschemas nest. The deepest input schema of a public Actor in the Apify Store
 * (2026-10) has 12 nested levels.
 */
export const MAX_UNTRUSTED_SUBSCHEMA_DEPTH = 32;

/**
 * Ajv checks that the values of an `enum` are unique by comparing each pair of them. The longest `enum`
 * of a public Actor in the Apify Store (2026-10) has 1,158 values.
 */
export const MAX_UNTRUSTED_ENUM_VALUES = 3000;

/** Keywords whose value is data: an object inside it is not a subschema, whatever it looks like. */
const DATA_KEYWORDS = new Set(['default', 'prefill', 'enum', 'example', 'examples', 'const']);
/** Keywords whose value maps a name to a subschema, so its keys are not keywords. */
const SUBSCHEMA_MAP_KEYWORDS = new Set([
    'properties',
    'patternProperties',
    'dependencies',
    'dependentSchemas',
    'definitions',
    '$defs',
]);
/** Keywords whose subschemas Ajv compiles where they are referenced, not where they stand. */
const DEFINITION_KEYWORDS = new Set(['definitions', '$defs']);
const SUBSCHEMA_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'items', 'prefixItems']);

/**
 * V8 may drop a compiled function that was not called for a while and compile it again on its next call, from
 * wherever in the stack that call is made. `assertValidatorRuns` calls this many frames deeper to leave room.
 */
const VALIDATOR_CHECK_STACK_FRAMES = 200;

const UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE = 1000;
// A failed compilation costs as much as a successful one, so the cache remembers its error too.
const untrustedValidatorCache = new LruCache<
    { validate: ValidateFunction<unknown>; schema: object } | { compileError: unknown }
>({
    maxLength: UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE,
});

const isSubschema = (value: unknown): boolean =>
    typeof value === 'boolean' || (typeof value === 'object' && value !== null && !Array.isArray(value));

type ChildSubschema = { subschema: unknown; isCompiled: boolean };

/** The subschemas directly inside a schema; `default`, `enum` and other data values hold none. */
function getChildSubschemas(schema: object): ChildSubschema[] {
    const childSubschemas: ChildSubschema[] = [];
    for (const [keyword, value] of Object.entries(schema)) {
        if (DATA_KEYWORDS.has(keyword) || typeof value !== 'object' || value === null) continue;

        const isCompiled = !DEFINITION_KEYWORDS.has(keyword);
        if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) || (SUBSCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value))) {
            for (const member of Object.values(value)) {
                if (isSubschema(member)) childSubschemas.push({ subschema: member, isCompiled });
            }
        } else if (!Array.isArray(value)) {
            childSubschemas.push({ subschema: value, isCompiled });
        }
    }
    return childSubschemas;
}

/** What the size check needs to know about the `$ref` keywords of one schema. */
type SchemaReferences = {
    /** Objects with a `$ref` somewhere inside. Ajv compiles such a schema once; it copies any other one. */
    referenceHolders: Set<object>;
    /** A nested `$id` can change what any reference points to. */
    hasNestedId: boolean;
    /**
     * How many times the references can make Ajv compile the whole schema at most, wherever they point: each
     * can start one more compilation, and each compilation can copy any part of the schema in at each reference.
     */
    worstCaseCopies: number;
    /** Objects and booleans in the schema: no part of it has more subschemas. */
    valueCount: number;
};

function findSchemaReferences(schema: object): SchemaReferences {
    const referenceHolders = new Set<object>();
    const parents = new Map<object, object>();
    let hasNestedId = false;
    let valueCount = 0;
    let referenceCount = 0;
    const pendingValues: object[] = [schema];
    for (let value = pendingValues.pop(); value !== undefined; value = pendingValues.pop()) {
        valueCount++;
        if (value !== schema && '$id' in value && typeof value.$id === 'string') hasNestedId = true;
        if ('$ref' in value) {
            referenceCount++;
            for (let holder: object | undefined = value; holder && !referenceHolders.has(holder); ) {
                referenceHolders.add(holder);
                holder = parents.get(holder);
            }
        }
        for (const member of Object.values(value)) {
            if (typeof member === 'object' && member !== null) {
                parents.set(member, value);
                pendingValues.push(member);
            } else if (typeof member === 'boolean') {
                valueCount++;
            }
        }
    }
    return { referenceHolders, hasNestedId, worstCaseCopies: (1 + referenceCount) ** 2, valueCount };
}

/** The value a `#/...` reference points to, found the way Ajv finds it. */
function getReferencedValue(schema: object, reference: string): unknown {
    let value: unknown = schema;
    for (const segment of reference.slice(2).split('/')) {
        if (typeof value !== 'object' || value === null) return undefined;
        const key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

/**
 * The schemas Ajv compiles for one `$ref`, or `undefined` when the check cannot tell where the reference points.
 * Ajv copies in a schema that has no references of its own at every use, and compiles any other schema once
 * for each spelling of the reference. A reference to a schema that is only a reference itself leads on to that
 * one's target; the check does not tell such a schema apart and counts both.
 */
function getSchemasCompiledForReference(
    schema: object,
    reference: string,
    { referenceHolders, hasNestedId }: SchemaReferences,
    compiledReferences: Set<string>,
): unknown[] | undefined {
    const isFirstUse = !compiledReferences.has(reference);
    compiledReferences.add(reference);
    const compiledSchemas: unknown[] = [];
    const followedReferences = new Set<string>();
    for (let current = reference; !followedReferences.has(current); ) {
        followedReferences.add(current);
        // Ajv calls the validator of the whole schema for these two.
        if (!hasNestedId && (current === '#' || current === '#/')) break;
        // Ajv reads a second `#` in a reference its own way.
        if (hasNestedId || !current.startsWith('#/') || current.includes('#', 1)) return undefined;
        const target = getReferencedValue(schema, current);
        const hasReferences = typeof target === 'object' && target !== null && referenceHolders.has(target);
        // Ajv fails to compile a reference that points nowhere.
        if (target !== undefined && (isFirstUse || !hasReferences)) compiledSchemas.push(target);
        if (!hasReferences || !('$ref' in target) || typeof target.$ref !== 'string') break;
        current = target.$ref;
    }
    return compiledSchemas;
}

/**
 * Throws SchemaTooLargeError on a schema over the byte, the subschema, the nesting or the enum limit. The bytes
 * and the subschemas are counted as Ajv compiles them: a referenced schema counts at each place it is compiled.
 */
function validateSchemaSize(schema: object, serialized: string): void {
    let schemaBytes = Buffer.byteLength(serialized);
    const addSchemaBytes = (bytes: number): void => {
        schemaBytes += bytes;
        if (schemaBytes > MAX_UNTRUSTED_SCHEMA_BYTES) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_SCHEMA_BYTES, 'bytes');
        }
    };
    addSchemaBytes(0);
    // In serialized JSON only a key is a string followed by a colon.
    let references = serialized.includes('"$ref":') ? findSchemaReferences(schema) : undefined;
    const compiledReferences = new Set<string>();
    const referencedSchemaBytes = new Map<unknown, number>();
    let subschemaCount = 0;
    // `isCompiled` is false inside a definition: Ajv compiles it where it is referenced, not where it stands.
    const pendingSubschemas: (ChildSubschema & { depth: number })[] = [
        { subschema: schema, depth: 0, isCompiled: true },
    ];
    for (let pending = pendingSubschemas.pop(); pending !== undefined; pending = pendingSubschemas.pop()) {
        const { subschema, depth, isCompiled } = pending;
        if (isCompiled) subschemaCount++;
        if (subschemaCount > MAX_UNTRUSTED_SUBSCHEMAS) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_SUBSCHEMAS, 'subschemas');
        }
        if (isCompiled && depth > MAX_UNTRUSTED_SUBSCHEMA_DEPTH) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_SUBSCHEMA_DEPTH, 'nested levels');
        }
        if (typeof subschema !== 'object' || subschema === null) continue;

        // Ajv checks the schema itself too, definitions included, so this limit holds for all of it.
        if ('enum' in subschema && Array.isArray(subschema.enum) && subschema.enum.length > MAX_UNTRUSTED_ENUM_VALUES) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_ENUM_VALUES, 'enum values');
        }
        if (references && isCompiled && '$ref' in subschema && typeof subschema.$ref === 'string') {
            const referencedSchemas = getSchemasCompiledForReference(
                schema,
                subschema.$ref,
                references,
                compiledReferences,
            );
            if (referencedSchemas === undefined) {
                // The schema has to fit with the worst case for its references, which are not followed any more.
                if (references.valueCount * references.worstCaseCopies > MAX_UNTRUSTED_SUBSCHEMAS) {
                    throw new SchemaTooLargeError(MAX_UNTRUSTED_SUBSCHEMAS, 'subschemas');
                }
                addSchemaBytes(schemaBytes * (references.worstCaseCopies - 1));
                references = undefined;
            }
            // A referenced schema takes the place of its reference.
            for (const referencedSchema of referencedSchemas ?? []) {
                const bytes =
                    referencedSchemaBytes.get(referencedSchema) ??
                    Buffer.byteLength(JSON.stringify(referencedSchema) ?? '');
                referencedSchemaBytes.set(referencedSchema, bytes);
                addSchemaBytes(bytes);
                pendingSubschemas.push({ subschema: referencedSchema, depth, isCompiled: true });
            }
        }
        for (const child of getChildSubschemas(subschema)) {
            pendingSubschemas.push({ ...child, depth: depth + 1, isCompiled: isCompiled && child.isCompiled });
        }
    }
}

/** Calls `run` from `frames` calls deeper in the stack. */
const callFromDeeperStack = (frames: number, run: () => void): void =>
    frames > 0 ? callFromDeeperStack(frames - 1, run) : run();

/**
 * Throws a RangeError when a compiled validator cannot run. Ajv validates the subschemas of a schema one inside
 * another, V8 compiles a function on its first call, and it cannot compile one whose blocks nest too deep
 * ("Maximum call stack size exceeded"): without this check such a schema compiles and every validation fails.
 * A schema Ajv did not copy in at its `$ref` has a validator function of its own.
 */
function assertValidatorRuns(validate: ValidateFunction<unknown>): void {
    const validators: unknown[] = [validate];
    for (const referenced of Object.values(validate.schemaEnv?.refs ?? {})) {
        if (typeof referenced === 'object' && 'validate' in referenced) validators.push(referenced.validate);
    }
    callFromDeeperStack(VALIDATOR_CHECK_STACK_FRAMES, () => {
        for (const validator of validators) {
            // An `$async` schema returns a promise that rejects on invalid data.
            if (typeof validator === 'function') Promise.resolve(validator({})).catch(() => undefined);
        }
    });
}

/**
 * Compiles an Actor or proxied-MCP input schema, one validator per schema content.
 *
 * Create a fresh Ajv instance per compilation to avoid unbounded memory growth.
 * Ajv internally caches every compiled schema in a Map that is never evicted.
 */
export function compileUntrustedSchema<T extends object>(
    schema: T,
): { validate: ValidateFunction<unknown>; schema: T } {
    const serialized = JSON.stringify(schema);
    // Ajv codegen is synchronous; an oversized untrusted schema would freeze the event loop.
    validateSchemaSize(schema, serialized);

    const cacheKey = createHash('sha256').update(serialized).digest('base64');
    const cached = untrustedValidatorCache.get(cacheKey);
    if (cached && 'compileError' in cached) throw cached.compileError;
    // A hit holds a schema with the same content as `schema`, so it is still a T.
    if (cached) return cached as { validate: ValidateFunction<unknown>; schema: T };

    try {
        const compiled = { validate: createAjv().compile(schema), schema };
        assertValidatorRuns(compiled.validate);
        untrustedValidatorCache.add(cacheKey, compiled);
        return compiled;
    } catch (error) {
        // Ajv and V8 both run out of stack on a schema that nests too deep.
        const compileError = error instanceof RangeError ? new SchemaTooLargeError() : error;
        untrustedValidatorCache.add(cacheKey, { compileError });
        throw compileError;
    }
}

/**
 * Adds predefined nested properties to special-case object types so the agent can structure
 * object inputs correctly:
 * - proxy objects (type='object', editor='proxy') get a 'useApifyProxy' property.
 * - request list sources (type='array', editor='requestListSources') get URL structure on items.
 *
 * @param {Record<string, SchemaProperties>} properties - The input schema properties
 * @returns {Record<string, SchemaProperties>} Modified properties with nested properties
 */
export function buildApifySpecificProperties(
    properties: Record<string, SchemaProperties>,
): Record<string, SchemaProperties> {
    const clonedProperties = { ...properties };

    for (const [propertyName, property] of Object.entries(clonedProperties)) {
        if (property.type === 'object' && property.editor === 'proxy') {
            clonedProperties[propertyName] = addProxyProperties(property);
        } else if (property.type === 'array' && property.editor === 'requestListSources') {
            clonedProperties[propertyName] = addRequestListSourcesProperties(property);
        } else if (property.type === 'array' && property.editor === 'pseudoUrls') {
            clonedProperties[propertyName] = addPseudoUrlsProperties(property);
        } else if (property.type === 'array' && property.editor === 'globs') {
            clonedProperties[propertyName] = addGlobsProperties(property);
        } else if (property.type === 'array' && property.editor === 'keyValue') {
            clonedProperties[propertyName] = addKeyValueProperties(property);
        } else if (property.type === 'array' && property.editor === 'resourcePicker') {
            clonedProperties[propertyName] = addArrayResourcePickerProperties(property);
        }
    }

    return clonedProperties;
}

/**
 * Filters schema properties to include only the necessary fields.
 * This is done to reduce the size of the input schema and to make it more readable.
 *
 * Only copies a whitelisted key when the upstream property actually declares it, so
 * unset fields (e.g. no `default`) aren't turned into phantom `default: undefined` keys.
 *
 * @param properties
 */
export function filterSchemaProperties(properties: { [key: string]: SchemaProperties }): {
    [key: string]: SchemaProperties;
} {
    const filteredProperties: { [key: string]: SchemaProperties } = {};
    for (const [key, property] of Object.entries(properties)) {
        filteredProperties[key] = {
            title: property.title,
            description: property.description,
            type: property.type,
            ...(property.enum !== undefined && { enum: property.enum }),
            ...(property.default !== undefined && { default: property.default }),
            ...(property.prefill !== undefined && { prefill: property.prefill }),
            ...(property.properties !== undefined && { properties: property.properties }),
            ...(property.items !== undefined && { items: property.items }),
            ...(property.required !== undefined && { required: property.required }),
        };
    }
    return filteredProperties;
}

/**
 * For array properties missing items.type, infers and sets the type using inferArrayItemType.
 * @param properties
 */
export function inferArrayItemsTypeIfMissing(properties: { [key: string]: SchemaProperties }): {
    [key: string]: SchemaProperties;
} {
    for (const [, property] of Object.entries(properties)) {
        if (property.type === 'array' && !property.items?.type) {
            const itemsType = inferArrayItemType(property);
            if (itemsType) {
                property.items = {
                    ...property.items,
                    title: property.title ?? 'Item',
                    description: property.description ?? 'Item',
                    type: itemsType,
                };
            }
        }
    }
    return properties;
}

/**
 * Marks input properties as required by adding a "REQUIRED" prefix to their descriptions.
 * Takes an ActorInput object and returns a modified Record of SchemaProperties.
 *
 * Prepending to the description (rather than relying on the schema's `required` array) maximizes
 * compatibility with libraries/agent frameworks that ignore or mishandle required fields.
 * @param {ActorInputSchema} input - Actor input object containing properties and required fields
 * @returns {Record<string, SchemaProperties>} - Modified properties with required fields marked
 */
export function markInputPropertiesAsRequired(input: ActorInputSchema): Record<string, SchemaProperties> {
    const { required = [], properties } = input;

    for (const property of Object.keys(properties)) {
        if (required.includes(property)) {
            properties[property] = {
                ...properties[property],
                description: `**REQUIRED** ${properties[property].description}`,
            };
        }
    }

    return properties;
}

/**
 * Builds the final Actor input schema for MCP tool usage.
 */
export function buildActorInputSchema(actorFullName: string, input: ActorInputSchema | undefined) {
    if (!input) {
        return {
            inputSchema: {
                $id: getToolSchemaID(actorFullName),
                type: 'object',
                properties: {},
                required: [],
            },
        };
    }

    // A required property with a default is optional: the platform fills it in (see apify/apify-mcp-server#1513).
    const working = fixZodSchemaRequired(structuredClone(input)) as ActorInputSchema;

    if (working && typeof working === 'object' && 'properties' in working && working.properties) {
        working.properties = transformActorInputSchemaProperties(working);
    }

    // Remove the schemaVersion field if present
    // since it was causing issues with Gemini CLI
    // https://github.com/apify/apify-mcp-server/issues/295
    if (working.schemaVersion) {
        delete working.schemaVersion;
    }

    // Remove $ref and $schema fields if present
    // since AJV cannot resolve external schema references
    // $ref and $schema are present in apify/website-content-crawler input schema
    if ('$ref' in working) {
        delete (working as { $ref?: string }).$ref;
    }
    if ('$schema' in working) {
        delete (working as { $schema?: string }).$schema;
    }

    working.$id = getToolSchemaID(actorFullName);
    return { inputSchema: working };
}

/**
 * Determines the type of items in an array schema property, since Actor input schemas usually
 * omit `items.type`.
 * Priority order: explicit type in items > prefill type > default value type > editor type.
 */
export function inferArrayItemType(property: SchemaProperties): string | null {
    return (
        property.items?.type ||
        (Array.isArray(property.prefill) && property.prefill.length > 0 && typeof property.prefill[0]) ||
        (Array.isArray(property.default) && property.default.length > 0 && typeof property.default[0]) ||
        (property.editor && getEditorItemType(property.editor)) ||
        null
    );

    function getEditorItemType(editor: string): string | null {
        const editorTypeMap: Record<string, string> = {
            requestListSources: 'object',
            stringList: 'string',
            json: 'object',
            globs: 'object',
            select: 'string',
        };
        return editorTypeMap[editor] || null;
    }
}

/**
 * Adds prefill/default values to descriptions as examples, for clients that ignore JSON Schema
 * `examples`. Never duplicates `enum` here — a kept enum already carries its values in the
 * schema; only `shortenProperties()`'s dropped-enum note needs to spell them out in text.
 */
export function addExampleValuesToDescriptions(
    properties: Record<string, SchemaProperties>,
): Record<string, SchemaProperties> {
    for (const property of Object.values(properties)) {
        const value = property.prefill ?? property.default;
        if (value && !(Array.isArray(value) && value.length === 0)) {
            property.examples = Array.isArray(value) ? value : [value];
            property.description = `${property.description}\nExample values: ${JSON.stringify(value)}`;
        }
    }
    return properties;
}

const ENUM_DROPPED_NOTE_EXAMPLE_COUNT = 10;
const ENUM_DROPPED_NOTE_EXAMPLE_MAX_LENGTH = 60;

/** Note for a dropped enum, with complete examples that remain valid inputs. */
function buildEnumDroppedNote(rawValues: string[]): string {
    const examples = rawValues
        .filter((value) => value !== '' && value.length <= ENUM_DROPPED_NOTE_EXAMPLE_MAX_LENGTH)
        .slice(0, ENUM_DROPPED_NOTE_EXAMPLE_COUNT);
    const exampleText = examples.length > 0 ? ` Examples: ${examples.join(', ')}.` : '';
    return `\n\nThe complete list of accepted values is too long to include.${exampleText}`;
}

/**
 * Blanks removed, kept whole if it fits ACTOR_ENUM_MAX_LENGTH; otherwise dropped entirely
 * — a partially-cut enum falsely implies exhaustiveness to both the LLM and AJV.
 */
function getEnumIfFits(enumList: string[]): string[] | undefined {
    const nonEmpty = enumList.filter((value) => value !== '');
    if (nonEmpty.length === 0) return undefined;
    const charCount = nonEmpty.reduce((sum, value) => sum + value.length, 0);
    return charCount <= ACTOR_ENUM_MAX_LENGTH ? nonEmpty : undefined;
}

/** Cut at the last complete sentence in the cap, or the last complete word if there is none. */
function shortenDescription(description: string): string {
    const truncated = description.slice(0, ACTOR_MAX_DESCRIPTION_LENGTH);
    const remainder = description.slice(ACTOR_MAX_DESCRIPTION_LENGTH);
    const sentenceEnd =
        [...truncated.matchAll(/[.!?](?=\s)/g)].at(-1)?.index ??
        (/[.!?]$/.test(truncated) && /^\s/.test(remainder) ? truncated.length - 1 : undefined);
    const shortened =
        sentenceEnd === undefined
            ? `${/^\s/.test(remainder) ? truncated.trimEnd() : truncated.replace(/\s+\S*$/, '')}…`
            : truncated.slice(0, sentenceEnd + 1);
    return `${shortened}\n\n[Description truncated]`;
}

function applyEnumLimit(holder: { enum?: string[] }, descriptionHost: SchemaProperties, rawEnum: string[]): void {
    const enumValues = getEnumIfFits(rawEnum);
    if (enumValues) {
        holder.enum = enumValues;
        return;
    }
    delete holder.enum;
    if (rawEnum.some((value) => value !== '')) {
        descriptionHost.description += buildEnumDroppedNote(rawEnum);
    }
}

/** Caps description length; drops (not truncates) an oversized enum/items.enum, noting examples instead. */
export function shortenProperties(properties: { [key: string]: SchemaProperties }): {
    [key: string]: SchemaProperties;
} {
    for (const property of Object.values(properties)) {
        if (property.description.length > ACTOR_MAX_DESCRIPTION_LENGTH) {
            property.description = shortenDescription(property.description);
        }

        if (property.enum && property.enum.length > 0) {
            applyEnumLimit(property, property, property.enum);
        }

        if (property.items?.enum && property.items.enum.length > 0) {
            applyEnumLimit(property.items, property, property.items.enum);
        }
    }

    return properties;
}

/**
 * Fixes dot notation in the property names of schema properties.
 *
 * Some providers, such as Anthropic, allow only the following characters in property names: `^[a-zA-Z0-9_-]{1,64}$`.
 *
 * @param properties - The schema properties to fix.
 * @returns {Record<string, SchemaProperties>} The schema properties with fixed names.
 */
export function encodeDotPropertyNames(properties: Record<string, SchemaProperties>): Record<string, SchemaProperties> {
    const encodedProperties: Record<string, SchemaProperties> = {};
    for (const [key, value] of Object.entries(properties)) {
        // Replace dots with '-dot-' to avoid issues with property names
        const fixedKey = key.replace(/\./g, '-dot-');
        encodedProperties[fixedKey] = value;
    }
    return encodedProperties;
}

/**
 * Restores original property names by replacing '-dot-' with '.'.
 *
 * This is necessary to decode the property names that were encoded to avoid issues with providers
 * that do not allow dots in property names.
 *
 * @param properties - The schema properties with encoded names.
 * @returns {Record<string, SchemaProperties>} The schema properties with restored names.
 */
export function decodeDotPropertyNames(properties: Record<string, unknown>): Record<string, unknown> {
    const decodedProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
        // Replace '-dot-' with '.' to restore original property names
        const decodedKey = key.replace(/-dot-/g, '.');
        decodedProperties[decodedKey] = value;
    }
    return decodedProperties;
}

export function transformActorInputSchemaProperties(input: Readonly<ActorInputSchema>): ActorInputSchemaProperties {
    // Deep clone input to avoid mutating the original object
    const inputClone: ActorInputSchema = structuredClone(input);
    let transformedProperties = markInputPropertiesAsRequired(inputClone);
    transformedProperties = buildApifySpecificProperties(transformedProperties);
    transformedProperties = inferArrayItemsTypeIfMissing(transformedProperties);
    transformedProperties = filterSchemaProperties(transformedProperties);
    transformedProperties = shortenProperties(transformedProperties);
    transformedProperties = addExampleValuesToDescriptions(transformedProperties);
    transformedProperties = encodeDotPropertyNames(transformedProperties);
    return transformedProperties;
}
