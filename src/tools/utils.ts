import type { ValidateFunction } from 'ajv';
import type Ajv from 'ajv';

import { ACTOR_ENUM_MAX_LENGTH, ACTOR_MAX_DESCRIPTION_LENGTH, RAG_WEB_BROWSER_WHITELISTED_FIELDS } from '../const.js';
import type { ActorInputSchema, ActorInputSchemaProperties, SchemaProperties } from '../types.js';
import {
    addGlobsProperties,
    addKeyValueProperties,
    addProxyProperties,
    addPseudoUrlsProperties,
    addRequestListSourcesProperties,
    addResourcePickerProperties as addArrayResourcePickerProperties,
} from '../utils/apify-properties.js';

export function actorNameToToolName(actorName: string): string {
    return actorName
        .replace(/\//g, '-slash-')
        .replace(/\./g, '-dot-')
        .slice(0, 64);
}

export function getToolSchemaID(actorName: string): string {
    return `https://apify.com/mcp/${actorNameToToolName(actorName)}/schema.json`;
}

// source https://github.com/ajv-validator/ajv/issues/1413#issuecomment-867064234
export function fixedAjvCompile(ajvInstance: Ajv, schema: object): ValidateFunction<unknown> {
    const validate = ajvInstance.compile(schema);
    ajvInstance.removeSchema(schema);

    // Force reset values that aren't reset with removeSchema
    /* eslint-disable no-underscore-dangle */
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (ajvInstance.scope as any)._values.schema!.delete(schema);
    (ajvInstance.scope as any)._values.validate!.delete(validate);
    const schemaIdx = (ajvInstance.scope as any)._scope.schema.indexOf(schema);
    const validateIdx = (ajvInstance.scope as any)._scope.validate.indexOf(validate);
    if (schemaIdx !== -1) (ajvInstance.scope as any)._scope.schema.splice(schemaIdx, 1);
    if (validateIdx !== -1) (ajvInstance.scope as any)._scope.validate.splice(validateIdx, 1);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    /* eslint-enable no-underscore-dangle */
    return validate;
}

/**
 * Builds nested properties for object types in the schema.
 *
 * Specifically handles special cases like proxy configuration and request list sources
 * by adding predefined nested properties to these object types.
 * This is necessary for the agent to correctly infer how to structure object inputs
 * when passing arguments to the Actor.
 *
 * For proxy objects (type='object', editor='proxy'), adds 'useApifyProxy' property.
 * For request list sources (type='array', editor='requestListSources'), adds URL structure to items.
 *
 * @param {Record<string, SchemaProperties>} properties - The input schema properties
 * @returns {Record<string, SchemaProperties>} Modified properties with nested properties
 */
export function buildApifySpecificProperties(properties: Record<string, SchemaProperties>): Record<string, SchemaProperties> {
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
 * @param properties
 */
export function filterSchemaProperties(properties: { [key: string]: SchemaProperties }): {
    [key: string]: SchemaProperties
} {
    const filteredProperties: { [key: string]: SchemaProperties } = {};
    for (const [key, property] of Object.entries(properties)) {
        filteredProperties[key] = {
            title: property.title,
            description: property.description,
            enum: property.enum,
            type: property.type,
            default: property.default,
            prefill: property.prefill,
            properties: property.properties,
            items: property.items,
            required: property.required,
        };
    }
    return filteredProperties;
}

/**
 * For array properties missing items.type, infers and sets the type using inferArrayItemType.
 * @param properties
 */
export function inferArrayItemsTypeIfMissing(properties: { [key: string]: SchemaProperties }): {
    [key: string]: SchemaProperties
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
 * This is done for maximum compatibility in case where library or agent framework does not consider
 * required fields and does not handle the JSON schema properly: we are prepending this to the description
 * as a preventive measure.
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
export function buildActorInputSchema(actorFullName: string, input: ActorInputSchema | undefined, isRag: boolean) {
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

    // Work on a shallow cloned structure (deep clone only if needed later)
    const working = structuredClone(input);

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

    let finalSchema = working;
    if (isRag) {
        finalSchema = pruneSchemaPropertiesByWhitelist(finalSchema, RAG_WEB_BROWSER_WHITELISTED_FIELDS);
    }

    finalSchema.$id = getToolSchemaID(actorFullName);
    return { inputSchema: finalSchema };
}

/**
 * Returns a shallow-cloned input schema that keeps only whitelisted properties
 * and filters the required array accordingly. All other top-level fields are preserved.
 * If properties are missing, the original input is returned unchanged.
 *
 * This is used specifically for apify/rag-web-browser where we want to expose
 * only a subset of input properties to the MCP tool without redefining the schema.
 */
export function pruneSchemaPropertiesByWhitelist(
    input: ActorInputSchema,
    whitelist: Iterable<string>,
): ActorInputSchema {
    if (!input || !input.properties || typeof input.properties !== 'object' || !whitelist) return input;

    const allowed = new Set<string>(Array.from(whitelist));
    const newProps: Record<string, SchemaProperties> = {};
    for (const key of Object.keys(input.properties)) {
        if (allowed.has(key)) newProps[key] = input.properties[key];
    }

    const cloned: ActorInputSchema = { ...input, properties: newProps };
    if (Array.isArray(input.required)) {
        cloned.required = input.required.filter((k) => allowed.has(k));
    }
    return cloned;
}

/**
 * Helps determine the type of items in an array schema property.
 * Priority order: explicit type in items > prefill type > default value type > editor type.
 *
 * Based on JSON schema, the array needs a type, and most of the time Actor input schema does not have this, so we need to infer that.
 *
 */
export function inferArrayItemType(property: SchemaProperties): string | null {
    return property.items?.type
        || (Array.isArray(property.prefill) && property.prefill.length > 0 && typeof property.prefill[0])
        || (Array.isArray(property.default) && property.default.length > 0 && typeof property.default[0])
        || (property.editor && getEditorItemType(property.editor))
        || null;

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
 * Add enum values as string to property descriptions.
 *
 * This is done as a preventive measure to prevent cases where library or agent framework
 * does not handle enums or examples based on JSON schema definition.
 *
 * https://json-schema.org/understanding-json-schema/reference/enum
 * https://json-schema.org/understanding-json-schema/reference/annotations
 *
 * @param properties
 */
export function addEnumsToDescriptionsWithExamples(properties: Record<string, SchemaProperties>): Record<string, SchemaProperties> {
    for (const property of Object.values(properties)) {
        if (property.enum && property.enum.length > 0) {
            property.description = `${property.description}\nPossible values: ${property.enum.slice(0, 20).join(',')}`;
        }
        const value = property.prefill ?? property.default;
        if (value && !(Array.isArray(value) && value.length === 0)) {
            property.examples = Array.isArray(value) ? value : [value];
            property.description = `${property.description}\nExample values: ${JSON.stringify(value)}`;
        }
    }
    return properties;
}

/**
 * Helper function to shorten the enum list if it is too long.
 *
 * @param {string[]} enumList - The list of enum values to be shortened.
 * @returns {string[] | undefined} - The shortened enum list or undefined if the list is too long.
 */
export function shortenEnum(enumList: string[]): string[] | undefined {
    let charCount = 0;
    const resultEnumList = enumList.filter((enumValue) => {
        charCount += enumValue.length;
        return charCount <= ACTOR_ENUM_MAX_LENGTH;
    });

    return resultEnumList.length > 0 ? resultEnumList : undefined;
}

/**
 * Shortens the description, enum, and items.enum properties of the schema properties.
 * This is mostly problem with compass/crawler-google-places, which has large number of categories
 * such as ( 'abbey', 'accountant', 'accounting',  'acupuncturist', .... )
 * @param properties
 */
export function shortenProperties(properties: { [key: string]: SchemaProperties }): {
    [key: string]: SchemaProperties
} {
    for (const property of Object.values(properties)) {
        if (property.description.length > ACTOR_MAX_DESCRIPTION_LENGTH) {
            property.description = `${property.description.slice(0, ACTOR_MAX_DESCRIPTION_LENGTH)}...`;
        }

        if (property.enum && property.enum?.length > 0) {
            property.enum = shortenEnum(property.enum);
        }

        if (property.items?.enum && property.items.enum.length > 0) {
            property.items.enum = shortenEnum(property.items.enum);
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
    transformedProperties = addEnumsToDescriptionsWithExamples(transformedProperties);
    transformedProperties = encodeDotPropertyNames(transformedProperties);
    return transformedProperties;
}
