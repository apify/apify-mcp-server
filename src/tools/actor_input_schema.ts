import { createHash } from 'node:crypto';

import type { ValidateFunction } from 'ajv';

import log from '@apify/log';

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
// is intentionally uncapped.
export const MAX_UNTRUSTED_SCHEMA_BYTES = 262_144;

// Ajv compile time does not follow schema size, so a schema over any of these limits is served without
// local validation; the platform or the proxied MCP server validates the input.
export const MAX_VALIDATED_SCHEMA_BYTES = 65_536;
export const MAX_VALIDATED_SCHEMA_OBJECTS = 300;
export const MAX_VALIDATED_SCHEMA_DEPTH = 32;

// Only a definition is compiled once. Ajv compiles any other `$ref` target again inside the schema around
// it, and compiles a target once per spelling of its ref; `%` and `~` escapes spell one name many ways.
const DEFINITION_REF_PATTERN = /^#\/(?:definitions|\$defs)\/[^/%~]+$/;

type ExceededCompileLimit = 'bytes' | 'nested-objects' | 'depth' | '$ref' | '$id';
type CompiledSchema = {
    validate: ValidateFunction<unknown>;
    schema: object;
    exceededLimit: ExceededCompileLimit | null;
};

const UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE = 1000;
const untrustedValidatorCache = new LruCache<CompiledSchema>(UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE);

/** Returns the limit that makes the schema too costly to compile, or null when Ajv may compile it. */
function findExceededCompileLimit(schema: object, serializedBytes: number): ExceededCompileLimit | null {
    if (serializedBytes > MAX_VALIDATED_SCHEMA_BYTES) return 'bytes';

    // The root is not a nested object.
    let nestedObjectCount = -1;
    const pending: [unknown, number][] = [[schema, 0]];
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
        const [node, depth] = entry;
        if (typeof node !== 'object' || node === null) continue;
        if (depth > MAX_VALIDATED_SCHEMA_DEPTH) return 'depth';
        if (Array.isArray(node)) {
            // A boolean in `anyOf`, `oneOf`, `allOf` or `items` is a schema, and costs like an object there.
            nestedObjectCount += node.filter((item) => typeof item === 'boolean').length;
        } else {
            // A property named `$ref`, `$id` or `dependencies` holds a schema object, not a string or name lists.
            const { $ref, $id, dependencies } = node as Record<string, unknown>;
            if (typeof $ref === 'string' && !DEFINITION_REF_PATTERN.test($ref)) return '$ref';
            // A nested `$id` can give a schema that is not a definition the name of one.
            if (depth > 0 && typeof $id === 'string') return '$id';
            nestedObjectCount++;
            // Ajv's code for a list of dependency names grows faster than the list.
            for (const names of Object.values(dependencies ?? {})) {
                if (Array.isArray(names)) nestedObjectCount += names.length;
            }
        }
        if (nestedObjectCount > MAX_VALIDATED_SCHEMA_OBJECTS) return 'nested-objects';
        pending.push(...Object.values(node).map((child): [unknown, number] => [child, depth + 1]));
    }
    return null;
}

/**
 * Compiles an Actor or proxied-MCP input schema, one validator per schema content.
 * Returns the schema to serve: a copy without Ajv's root `$async`, which is what the validator is compiled from.
 * A schema that is costly to compile gets a validator that accepts every input and leaves it unchanged.
 *
 * Create a fresh Ajv instance per compilation to avoid unbounded memory growth.
 * Ajv internally caches every compiled schema in a Map that is never evicted.
 */
export function compileUntrustedSchema<T extends object>(
    schema: T,
    logContext: Record<string, unknown> = {},
): { validate: ValidateFunction<unknown>; schema: T } {
    // Validators are called synchronously, so the schema is compiled without Ajv's root `$async`.
    // Below the root Ajv ignores the keyword or fails the compile.
    const syncSchema = { ...schema };
    delete (syncSchema as { $async?: unknown }).$async;

    const serialized = JSON.stringify(syncSchema);
    const serializedBytes = Buffer.byteLength(serialized);
    // Ajv codegen is synchronous; an oversized untrusted schema would freeze the event loop.
    if (serializedBytes > MAX_UNTRUSTED_SCHEMA_BYTES) {
        throw new SchemaTooLargeError(MAX_UNTRUSTED_SCHEMA_BYTES);
    }

    const cacheKey = createHash('sha256').update(serialized).digest('base64');
    let compiled = untrustedValidatorCache.get(cacheKey);
    if (!compiled) {
        const exceededLimit = findExceededCompileLimit(syncSchema, serializedBytes);
        // An inlined `$ref` is compiled again at every place that refers to it.
        const ajv = createAjv({ inlineRefs: false });
        compiled = { validate: ajv.compile(exceededLimit ? {} : syncSchema), schema: syncSchema, exceededLimit };
        untrustedValidatorCache.set(cacheKey, compiled);
    }
    if (compiled.exceededLimit) {
        log.info('Skipped input validation, schema is costly to compile', {
            ...logContext,
            exceededLimit: compiled.exceededLimit,
            schemaBytes: serializedBytes,
        });
    }
    // A hit holds a schema with the same content as `syncSchema`, so it is still a T.
    return compiled as CompiledSchema & { schema: T };
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
