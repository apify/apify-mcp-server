import { createHash } from 'node:crypto';

import type { ValidateFunction } from 'ajv';

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
import { LruCache } from '../utils/lru.js';
import { getToolSchemaID } from './actor_tool_naming.js';

type ActorInputSchemaProperties = Record<string, SchemaProperties>;

// Real Apify Actor input schemas run up to ~140 KB post-transform; cap at 256 KB to bound AJV's
// synchronous codegen so a pathological untrusted schema can't freeze the event loop. Only the
// untrusted callers (actor_tools_factory, mcp/proxy) reach AJV through here; trusted compileSchema()
// is intentionally uncapped. A schema that a `$ref` points to counts again at every place Ajv compiles it.
export const MAX_UNTRUSTED_SCHEMA_BYTES = 262_144;

/**
 * The compile time and the memory of a validator grow with the code Ajv generates for it, not with the bytes of
 * its schema. The code is estimated from the schema before Ajv runs and measured when Ajv has generated it;
 * neither may exceed this. A generous backstop: the validator of the largest input schema of a public Actor in
 * the Apify Store (2026-10) is estimated at 2.9 MB and measures 1.3 MB.
 */
export const MAX_UNTRUSTED_VALIDATOR_CODE_BYTES = 6_291_456;

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

/**
 * A generated validator checks the properties of an object one inside another, and a JavaScript engine can
 * only compile code that nests so deep; how deep depends on the Node.js version. This limit is below what
 * Node.js 22, 24 and 26 compile, so a schema loads on all of them or on none: an object with 1,300 typed
 * properties loads. The nesting is estimated from the schema before Ajv runs and measured on the code Ajv
 * generates. The validator of the widest input schema of a public Actor in the Apify Store (2026-10) nests
 * 457 deep.
 */
export const MAX_UNTRUSTED_VALIDATOR_NESTING = 1320;

/**
 * The part of that nesting that may come from anything but the properties of an object: other keywords, the
 * members of schema lists and listed values. The validators of the input schemas of public Actors in the Apify
 * Store (2026-10) use at most 230 of it.
 */
export const MAX_UNTRUSTED_VALIDATOR_NESTING_OUTSIDE_PROPERTIES = 800;

/**
 * A schema can apply several references to one and the same value, and the schemas they point to can do so
 * again; this limits how many referenced schemas one value is checked against in all. The input schemas of
 * public Actors in the Apify Store (2026-10) do not use references this way.
 */
export const MAX_UNTRUSTED_SAME_VALUE_SCHEMAS = 1000;

/** In serialized JSON: an `$id` key at any depth whose string value holds the end of a comment. */
const ID_WITH_COMMENT_END = /"\$id":"(?:[^"\\]|\\.)*?\*\//;

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
/** Keywords whose subschemas check the same value as the schema they stand in. */
const SAME_VALUE_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependencies'];
/** The keywords Ajv generates code for, read from Ajv so that the list follows its version. */
const CODE_KEYWORDS = new Set(createAjv().RULES.rules.flatMap((group) => group.rules.map((rule) => rule.keyword)));

/** At most this much code checks one keyword and reports its error, without the paths in the error. */
const KEYWORD_CODE_BYTES = 1024;
/** The same for a keyword whose value is a number, a boolean or a string, except `type` with its conversions. */
const SCALAR_KEYWORD_CODE_BYTES = 512;
/** At most this much code stands for one listed value: a required name, a type, a property name, an enum value. */
const LISTED_VALUE_CODE_BYTES = 256;
/** Ajv checks a longer `required` or `enum` list in a loop instead of writing every value into the code. */
const LISTED_VALUES_IN_CODE = 200;
/**
 * Ajv joins the checks of the listed values into one expression, one value at a time, so a long list counts
 * for more than its length: the cube of the length, divided by this, is added to its code.
 */
const LISTED_VALUES_JOIN_DIVISOR = 512;
/** The code that adds an array index or a property name unknown until run time to a path. */
const PATH_STEP_CODE_BYTES = 64;
/** At most this many blocks, one inside another, check one keyword apart from its listed values. */
const KEYWORD_NESTED_BLOCKS = 2;
/** The blocks of a validator function around the checks of its schema. */
const FUNCTION_NESTED_BLOCKS = 4;

export const UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE = 1000;
/**
 * V8 keeps the code of every cached validator and several times as much memory for what it compiled from it.
 * The validators of 1,000 typical public Actors have about 44 MB of code together.
 */
export const UNTRUSTED_VALIDATOR_CACHE_MAX_CODE_BYTES = 64 * 1024 * 1024;
/** What a caller gets: the schema and a validator that holds no compiled code, see `createServedValidator`. */
type ServedValidator = { validate: ValidateFunction<unknown>; schema: object };
// A failed compilation costs as much as a successful one, so the cache remembers its error too.
const untrustedValidatorCache = new LruCache<
    { compiledValidate: ValidateFunction<unknown>; served: ServedValidator } | { compileError: unknown }
>(UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE);
/** The code of the validators added to the cache since it was last emptied; never less than what it holds. */
let cachedValidatorCodeBytes = 0;

/** How much of its two limits the validator cache uses. */
export const getUntrustedValidatorCacheUsage = (): { entries: number; codeBytes: number } => ({
    entries: untrustedValidatorCache.size,
    codeBytes: cachedValidatorCodeBytes,
});

const isSubschema = (value: unknown): boolean =>
    typeof value === 'boolean' || (typeof value === 'object' && value !== null && !Array.isArray(value));

/**
 * The code one step of a path adds to every error reported below it: the error holds the path of its value,
 * where Ajv writes a name as a JSON string, and the path of its keyword, where the name is a URI fragment.
 * Without a `name` the step is an array index or a property name unknown until run time.
 */
function getPathStepCodeBytes(keyword: string, name?: string): number {
    if (name === undefined) return 2 * keyword.length + PATH_STEP_CODE_BYTES;
    const escapedName = name.replace(/[~/]/g, '~0');
    let fragmentBytes;
    try {
        fragmentBytes = encodeURIComponent(escapedName).length;
    } catch {
        // A name with half of a surrogate pair has no URI form, and Ajv fails to compile its schema.
        fragmentBytes = 0;
    }
    return 2 * keyword.length + JSON.stringify(escapedName).length + fragmentBytes + 4;
}

/**
 * An upper estimate of the code Ajv generates for the keywords of one subschema, without its subschemas:
 * each keyword reports an error that holds `pathCodeBytes` of paths, and each listed value is written out.
 */
function estimateCodeBytes(subschema: unknown, pathCodeBytes: number): number {
    if (subschema === false) return SCALAR_KEYWORD_CODE_BYTES + pathCodeBytes;
    if (typeof subschema !== 'object' || subschema === null) return 0;
    let codeBytes = 0;
    const addListedValues = (count: number): void => {
        codeBytes += count * LISTED_VALUE_CODE_BYTES + count ** 3 / LISTED_VALUES_JOIN_DIVISOR;
    };
    for (const [keyword, value] of Object.entries(subschema)) {
        if (!CODE_KEYWORDS.has(keyword)) continue;

        if (typeof value !== 'object' || value === null) {
            codeBytes += (keyword === 'type' ? KEYWORD_CODE_BYTES : SCALAR_KEYWORD_CODE_BYTES) + pathCodeBytes;
            continue;
        }
        // The code reads a list or an object from the schema, by the path of its keyword, up to twice.
        codeBytes += KEYWORD_CODE_BYTES + 3 * pathCodeBytes;
        if (Array.isArray(value)) {
            addListedValues(Math.min(value.length, LISTED_VALUES_IN_CODE));
        } else if (keyword === 'properties' || keyword === 'dependencies') {
            const members = Object.values(value);
            codeBytes += members.length * LISTED_VALUE_CODE_BYTES;
            for (const member of members) {
                // The names a property depends on are checked, and reported, apart from the other properties,
                // and Ajv has no loop for them.
                if (Array.isArray(member)) {
                    codeBytes += KEYWORD_CODE_BYTES + 3 * pathCodeBytes;
                    addListedValues(member.length);
                }
            }
        }
    }
    return codeBytes;
}

/**
 * An upper estimate of the blocks the checks of one subschema open one inside another, without its subschemas:
 * Ajv checks the next keyword, property, list member or listed value inside the check of the one before.
 * `properties` counts the blocks of the properties of an object, `others` all the other ones.
 */
function estimateNestedBlocks(subschema: unknown): { properties: number; others: number } {
    const nestedBlocks = { properties: 0, others: 0 };
    if (typeof subschema !== 'object' || subschema === null) return nestedBlocks;
    for (const [keyword, value] of Object.entries(subschema)) {
        if (!CODE_KEYWORDS.has(keyword)) continue;

        nestedBlocks.others += KEYWORD_NESTED_BLOCKS;
        if (Array.isArray(value)) {
            nestedBlocks.others += SUBSCHEMA_LIST_KEYWORDS.has(keyword)
                ? value.length
                : Math.min(value.length, LISTED_VALUES_IN_CODE);
        } else if (keyword === 'properties') {
            nestedBlocks.properties += Object.keys(value ?? {}).length;
        } else if (keyword === 'dependencies') {
            for (const member of Object.values(value ?? {})) {
                nestedBlocks.others += 1 + (Array.isArray(member) ? member.length : 0);
            }
        }
    }
    return nestedBlocks;
}

type ChildSubschema = { subschema: unknown; isCompiled: boolean; isDefinition: boolean; pathStepCodeBytes: number };

/** The subschemas directly inside a schema; `default`, `enum` and other data values hold none. */
function getChildSubschemas(schema: object): ChildSubschema[] {
    const childSubschemas: ChildSubschema[] = [];
    for (const [keyword, value] of Object.entries(schema)) {
        if (DATA_KEYWORDS.has(keyword) || typeof value !== 'object' || value === null) continue;

        const isDefinition = DEFINITION_KEYWORDS.has(keyword);
        const isCompiled = !isDefinition;
        if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) || (SUBSCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value))) {
            for (const [name, member] of Object.entries(value)) {
                if (!isSubschema(member)) continue;
                childSubschemas.push({
                    subschema: member,
                    isCompiled,
                    isDefinition,
                    pathStepCodeBytes: getPathStepCodeBytes(keyword, name),
                });
            }
        } else if (!Array.isArray(value)) {
            childSubschemas.push({
                subschema: value,
                isCompiled,
                isDefinition,
                pathStepCodeBytes: getPathStepCodeBytes(keyword),
            });
        }
    }
    return childSubschemas;
}

/** What the size check needs to know about the `$ref` keywords of one schema. */
type SchemaReferences = {
    /** Objects with a `$ref` somewhere inside. Ajv compiles such a schema once; it copies any other one. */
    referenceHolders: Set<object>;
    /** The value of every `$ref` keyword. */
    references: Set<string>;
    /** A nested `$id` can change what any reference points to. */
    hasNestedId: boolean;
    /**
     * The validator code and the schema copies at most, wherever the references point: each reference can start
     * one more compilation, and each compilation can copy any part of the schema in at each reference.
     */
    worstCaseCodeBytes: number;
    worstCaseCopies: number;
};

function findSchemaReferences(schema: object): SchemaReferences {
    const referenceHolders = new Set<object>();
    const references = new Set<string>();
    const parents = new Map<object, object>();
    const pathCodeBytes = new Map<object, number>([[schema, 0]]);
    const values: object[] = [];
    let hasNestedId = false;
    let falseSubschemaCount = 0;
    let referenceCount = 0;
    let longestPathCodeBytes = 0;
    const pendingValues: object[] = [schema];
    for (let value = pendingValues.pop(); value !== undefined; value = pendingValues.pop()) {
        values.push(value);
        const valuePathCodeBytes = pathCodeBytes.get(value) ?? 0;
        longestPathCodeBytes = Math.max(longestPathCodeBytes, valuePathCodeBytes);
        if (value !== schema && '$id' in value && typeof value.$id === 'string') hasNestedId = true;
        if ('$ref' in value) {
            referenceCount++;
            if (typeof value.$ref === 'string') {
                references.add(value.$ref);
                longestPathCodeBytes = Math.max(
                    longestPathCodeBytes,
                    valuePathCodeBytes + getPathStepCodeBytes('$ref', value.$ref),
                );
            }
            for (let holder: object | undefined = value; holder && !referenceHolders.has(holder); ) {
                referenceHolders.add(holder);
                holder = parents.get(holder);
            }
        }
        for (const [name, member] of Object.entries(value)) {
            if (typeof member === 'object' && member !== null) {
                parents.set(member, value);
                pathCodeBytes.set(member, valuePathCodeBytes + getPathStepCodeBytes('', name));
                pendingValues.push(member);
            } else if (member === false) {
                falseSubschemaCount++;
            }
        }
    }
    // A copied schema reports its errors with the path to its reference in front of its own.
    let codeBytes = estimateCodeBytes(false, 2 * longestPathCodeBytes) * falseSubschemaCount;
    for (const value of values) codeBytes += estimateCodeBytes(value, 2 * longestPathCodeBytes);
    const worstCaseCopies = (1 + referenceCount) ** 2;
    return {
        referenceHolders,
        references,
        hasNestedId,
        worstCaseCodeBytes: codeBytes * worstCaseCopies,
        worstCaseCopies,
    };
}

/** The value a `#/...` reference points to, found the way Ajv finds it. */
function getReferencedValue(schema: object, reference: string): unknown {
    let value: unknown = schema;
    for (const segment of reference.slice(2).split('/')) {
        if (typeof value !== 'object' || value === null) return undefined;
        let key;
        try {
            key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
        } catch {
            // Not a URI fragment; Ajv fails to compile such a reference.
            return undefined;
        }
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
 * Throws SchemaTooLargeError on a schema over the byte, the validator code, the nesting or the enum limit. The
 * bytes and the code are counted as Ajv compiles them: a referenced schema counts at each place it is compiled.
 * The nesting of the validator code is estimated for every subschema, a definition as a validator of its own.
 */
function validateSchemaSize(schema: object, serialized: string, schemaReferences: SchemaReferences | undefined): void {
    let schemaBytes = Buffer.byteLength(serialized);
    const addSchemaBytes = (bytes: number): void => {
        schemaBytes += bytes;
        if (schemaBytes > MAX_UNTRUSTED_SCHEMA_BYTES) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_SCHEMA_BYTES, 'bytes');
        }
    };
    addSchemaBytes(0);
    let references = schemaReferences;
    const compiledReferences = new Set<string>();
    const referencedSchemaBytes = new Map<unknown, number>();
    let validatorCodeBytes = 0;
    const addValidatorCodeBytes = (bytes: number): void => {
        validatorCodeBytes += bytes;
        if (validatorCodeBytes > MAX_UNTRUSTED_VALIDATOR_CODE_BYTES) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES, 'bytes of validator code');
        }
    };
    // `isCompiled` is false inside a definition: Ajv compiles it where it is referenced, not where it stands.
    // `nestedBlocks` are the blocks of validator code a subschema is checked inside.
    const functionNestedBlocks = { properties: 0, others: FUNCTION_NESTED_BLOCKS };
    const pendingSubschemas: {
        subschema: unknown;
        isCompiled: boolean;
        depth: number;
        pathCodeBytes: number;
        nestedBlocks: { properties: number; others: number };
    }[] = [{ subschema: schema, depth: 0, pathCodeBytes: 0, nestedBlocks: functionNestedBlocks, isCompiled: true }];
    for (let pending = pendingSubschemas.pop(); pending !== undefined; pending = pendingSubschemas.pop()) {
        const { subschema, depth, pathCodeBytes, isCompiled } = pending;
        const ownNestedBlocks = estimateNestedBlocks(subschema);
        const nestedBlocks = {
            properties: pending.nestedBlocks.properties + ownNestedBlocks.properties,
            others: pending.nestedBlocks.others + ownNestedBlocks.others,
        };
        if (nestedBlocks.properties + nestedBlocks.others > MAX_UNTRUSTED_VALIDATOR_NESTING) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_VALIDATOR_NESTING, 'nested blocks of validator code');
        }
        if (nestedBlocks.others > MAX_UNTRUSTED_VALIDATOR_NESTING_OUTSIDE_PROPERTIES) {
            throw new SchemaTooLargeError(
                MAX_UNTRUSTED_VALIDATOR_NESTING_OUTSIDE_PROPERTIES,
                'nested blocks of validator code',
            );
        }
        if (isCompiled) addValidatorCodeBytes(estimateCodeBytes(subschema, pathCodeBytes));
        if (isCompiled && depth > MAX_UNTRUSTED_SUBSCHEMA_DEPTH) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_SUBSCHEMA_DEPTH, 'nested levels');
        }
        if (typeof subschema !== 'object' || subschema === null) continue;

        // Ajv checks the schema itself too, definitions included, so this limit holds for all of it.
        if ('enum' in subschema && Array.isArray(subschema.enum)) {
            if (subschema.enum.length > MAX_UNTRUSTED_ENUM_VALUES) {
                throw new SchemaTooLargeError(MAX_UNTRUSTED_ENUM_VALUES, 'enum values');
            }
            // Comparing the pairs of values takes time like compiling code does: about half a byte for a pair.
            addValidatorCodeBytes(subschema.enum.length ** 2 / 2);
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
                if (references.worstCaseCodeBytes > MAX_UNTRUSTED_VALIDATOR_CODE_BYTES) {
                    throw new SchemaTooLargeError(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES, 'bytes of validator code');
                }
                addSchemaBytes(schemaBytes * (references.worstCaseCopies - 1));
                references = undefined;
            }
            // A referenced schema takes the place of its reference, and reports the reference in its errors.
            for (const referencedSchema of referencedSchemas ?? []) {
                const bytes =
                    referencedSchemaBytes.get(referencedSchema) ??
                    Buffer.byteLength(JSON.stringify(referencedSchema) ?? '');
                referencedSchemaBytes.set(referencedSchema, bytes);
                addSchemaBytes(bytes);
                pendingSubschemas.push({
                    subschema: referencedSchema,
                    depth,
                    pathCodeBytes: pathCodeBytes + getPathStepCodeBytes('$ref', subschema.$ref),
                    // A schema with references of its own gets a validator function of its own.
                    nestedBlocks: schemaReferences?.referenceHolders.has(referencedSchema as object)
                        ? functionNestedBlocks
                        : nestedBlocks,
                    isCompiled: true,
                });
            }
        }
        for (const child of getChildSubschemas(subschema)) {
            pendingSubschemas.push({
                subschema: child.subschema,
                depth: depth + 1,
                pathCodeBytes: pathCodeBytes + child.pathStepCodeBytes,
                nestedBlocks: child.isDefinition ? functionNestedBlocks : nestedBlocks,
                isCompiled: isCompiled && child.isCompiled,
            });
        }
    }
}

/** The `$ref` values a schema applies to the value it checks itself, not to a property or an item of it. */
function getSameValueReferences(schema: object): string[] {
    const references: string[] = [];
    const pendingSubschemas: unknown[] = [schema];
    while (pendingSubschemas.length > 0) {
        const subschema = pendingSubschemas.pop();
        if (typeof subschema !== 'object' || subschema === null) continue;

        const keywords = subschema as Record<string, unknown>;
        if (typeof keywords.$ref === 'string') references.push(keywords.$ref);
        for (const keyword of SAME_VALUE_KEYWORDS) {
            const value = keywords[keyword];
            if (keyword === 'dependencies' || Array.isArray(value))
                pendingSubschemas.push(...Object.values(value ?? {}));
            else pendingSubschemas.push(value);
        }
    }
    return references;
}

/**
 * Follows the references a schema applies to one and the same value, such as the members of an `allOf`.
 * Throws an Error when they lead back to where they started: such a schema describes no value. Throws
 * SchemaTooLargeError when one value is checked against more referenced schemas than the limit.
 * A schema that refers to itself for a property or for the items of an array, like a tree, moves into the data
 * and is fine.
 */
function assertReferencesEnd(schema: object, { references, hasNestedId }: SchemaReferences): void {
    // A nested `$id` can change what any reference points to; such a schema is left to Ajv.
    if (hasNestedId) return;
    // The referenced schemas one value is checked against in a schema; `undefined` while they are being counted.
    const sameValueSchemaCounts = new Map<unknown, number | undefined>();
    // Starts at the whole schema and at every schema a reference points to.
    const pendingSchemas = [{ references: ['#', ...references], nextIndex: 0, target: undefined as unknown, count: 0 }];
    for (let pending = pendingSchemas.at(-1); pending !== undefined; pending = pendingSchemas.at(-1)) {
        const reference = pending.references[pending.nextIndex++];
        if (reference === undefined) {
            sameValueSchemaCounts.set(pending.target, pending.count);
            pendingSchemas.pop();
            const referrer = pendingSchemas.at(-1);
            // The starting points are not one value.
            if (referrer && referrer.target !== undefined) referrer.count += 1 + pending.count;
            if (pending.count > MAX_UNTRUSTED_SAME_VALUE_SCHEMAS) {
                throw new SchemaTooLargeError(MAX_UNTRUSTED_SAME_VALUE_SCHEMAS, 'referenced schemas for one value');
            }
            continue;
        }
        let target: unknown;
        if (reference === '#' || reference === '#/') target = schema;
        else if (reference.startsWith('#/')) target = getReferencedValue(schema, reference);
        if (typeof target !== 'object' || target === null) continue;

        if (!sameValueSchemaCounts.has(target)) {
            sameValueSchemaCounts.set(target, undefined);
            pendingSchemas.push({ references: getSameValueReferences(target), nextIndex: 0, target, count: 0 });
            continue;
        }
        const count = sameValueSchemaCounts.get(target);
        if (count === undefined) {
            throw new Error('Input schema has a reference that leads back to itself without reading any input');
        }
        if (pending.target !== undefined) pending.count += 1 + count;
    }
}

/** How deep the brackets of a piece of generated code nest; brackets inside its string literals do not count. */
function getCodeNesting(code: string): number {
    let nesting = 0;
    let deepestNesting = 0;
    for (let index = 0; index < code.length; index++) {
        const character = code[index];
        if (character === '"') {
            // Ajv writes every string as a JSON string.
            for (index++; index < code.length && code[index] !== '"'; index++) if (code[index] === '\\') index++;
        } else if (character === '{' || character === '(' || character === '[') {
            deepestNesting = Math.max(deepestNesting, ++nesting);
        } else if (character === '}' || character === ')' || character === ']') {
            nesting--;
        }
    }
    return deepestNesting;
}

/**
 * Compiles an Actor or proxied-MCP input schema, one validator per schema content.
 *
 * Create a fresh Ajv instance per compilation to avoid unbounded memory growth.
 * Ajv internally caches every compiled schema in a Map that is never evicted.
 *
 * The returned validator holds no compiled code, see `createServedValidator`.
 */
export function compileUntrustedSchema<T extends object>(
    schema: T,
): { validate: ValidateFunction<unknown>; schema: T } {
    const serialized = JSON.stringify(schema);
    const cacheKey = createHash('sha256').update(serialized).digest('base64');
    const cached = untrustedValidatorCache.get(cacheKey);
    if (cached && 'compileError' in cached) throw cached.compileError;
    // A hit holds a schema with the same content as `schema`, so it is still a T.
    if (cached) return cached.served as { validate: ValidateFunction<unknown>; schema: T };

    const served = createServedValidator(cacheKey, schema);
    compileIntoCache(cacheKey, served, serialized);
    return served;
}

/**
 * The validator a tool keeps: it looks the compiled validator up in the cache at each call and compiles it again
 * when the cache has dropped it. A tool that stays loaded keeps no compiled code alive this way, so the limits
 * of the cache are the limits of all the compiled validators of the process.
 */
function createServedValidator<T extends object>(
    cacheKey: string,
    schema: T,
): { validate: ValidateFunction<unknown>; schema: T } {
    // The validator is added below: it refers to `served` itself.
    const served = { schema } as { validate: ValidateFunction<unknown>; schema: T };
    const validate = (data: unknown): boolean => {
        const cached = untrustedValidatorCache.get(cacheKey);
        const compiledValidate =
            cached && 'compiledValidate' in cached ? cached.compiledValidate : compileIntoCache(cacheKey, served);
        const isValid = compiledValidate(data);
        served.validate.errors = compiledValidate.errors;
        return isValid;
    };
    // It has what the callers of a validator use: the call, `errors` and `schema`.
    served.validate = Object.assign(validate, { schema }) as unknown as ValidateFunction<unknown>;
    return served;
}

/**
 * Checks and compiles the schema of `served` and adds the validator, or the error it fails with, to the cache.
 * Throws what `compileUntrustedSchema` throws.
 */
function compileIntoCache(
    cacheKey: string,
    served: ServedValidator,
    serialized = JSON.stringify(served.schema),
): ValidateFunction<unknown> {
    const { schema } = served;
    let codeBytes = 0;
    // Ajv hands over the code of each validator function before V8 parses it.
    const checkCode = (code: string): void => {
        codeBytes += code.length;
        if (codeBytes > MAX_UNTRUSTED_VALIDATOR_CODE_BYTES) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES, 'bytes of validator code');
        }
        if (getCodeNesting(code) > MAX_UNTRUSTED_VALIDATOR_NESTING) {
            throw new SchemaTooLargeError(MAX_UNTRUSTED_VALIDATOR_NESTING, 'nested blocks of validator code');
        }
    };
    try {
        // Ajv writes an `$id` into a comment of the code it generates, so it may not hold the end of a comment.
        if (ID_WITH_COMMENT_END.test(serialized)) throw new Error('Input schema has an `$id` that is not supported');
        // A validator of such a schema would answer with a promise; the server validates synchronously.
        if ('$async' in schema && schema.$async) throw new Error('Input schema uses `$async`, which is not supported');
        // In serialized JSON only a key is a string followed by a colon.
        const references = serialized.includes('"$ref":') ? findSchemaReferences(schema) : undefined;
        // Ajv codegen is synchronous; an oversized untrusted schema would freeze the event loop.
        validateSchemaSize(schema, serialized, references);
        if (references) assertReferencesEnd(schema, references);

        const compiledValidate = createAjv(checkCode).compile(schema);
        addToValidatorCache(cacheKey, { compiledValidate, served }, codeBytes);
        return compiledValidate;
    } catch (error) {
        // Ajv runs out of stack on a schema that nests too deep. How deep depends on the Node.js version and on
        // the stack of this call, so that answer is not kept; every other one follows from the schema.
        if (error instanceof RangeError) throw new SchemaTooLargeError();
        // Until its stack is read, an error keeps what the functions on its stack worked with: here the code Ajv
        // had generated. Reading it leaves only the text.
        if (error instanceof Error) void error.stack;
        addToValidatorCache(cacheKey, { compileError: error }, 0);
        throw error;
    }
}

/** Empties the cache first when the code of its validators would exceed what the process can hold. */
function addToValidatorCache(
    cacheKey: string,
    entry: { compiledValidate: ValidateFunction<unknown>; served: ServedValidator } | { compileError: unknown },
    codeBytes: number,
): void {
    if (cachedValidatorCodeBytes + codeBytes > UNTRUSTED_VALIDATOR_CACHE_MAX_CODE_BYTES) {
        untrustedValidatorCache.clear();
        cachedValidatorCodeBytes = 0;
    }
    cachedValidatorCodeBytes += codeBytes;
    untrustedValidatorCache.set(cacheKey, entry);
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
