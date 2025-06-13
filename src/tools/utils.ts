import type { ValidateFunction } from 'ajv';
import type Ajv from 'ajv';

import { ACTOR_ENUM_MAX_LENGTH, ACTOR_MAX_DESCRIPTION_LENGTH } from '../const.js';
import type { IActorInputSchema, ISchemaProperties } from '../types.js';

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
 * @param {Record<string, ISchemaProperties>} properties - The input schema properties
 * @returns {Record<string, ISchemaProperties>} Modified properties with nested properties
 */
export function buildNestedProperties(properties: Record<string, ISchemaProperties>): Record<string, ISchemaProperties> {
    const clonedProperties = { ...properties };

    for (const [propertyName, property] of Object.entries(clonedProperties)) {
        if (property.type === 'object' && property.editor === 'proxy') {
            clonedProperties[propertyName] = {
                ...property,
                properties: {
                    ...property.properties,
                    useApifyProxy: {
                        title: 'Use Apify Proxy',
                        type: 'boolean',
                        description: 'Whether to use Apify Proxy - ALWAYS SET TO TRUE.',
                        default: true,
                        examples: [true],
                    },
                },
                required: ['useApifyProxy'],
            };
        } else if (property.type === 'array' && property.editor === 'requestListSources') {
            clonedProperties[propertyName] = {
                ...property,
                items: {
                    ...property.items,
                    type: 'object',
                    title: 'Request list source',
                    description: 'Request list source',
                    properties: {
                        url: {
                            title: 'URL',
                            type: 'string',
                            description: 'URL of the request list source',
                        },
                    },
                },
            };
        }
    }

    return clonedProperties;
}

/**
 * Filters schema properties to include only the necessary fields.
 *
 * This is done to reduce the size of the input schema and to make it more readable.
 *
 * @param properties
 */
export function filterSchemaProperties(properties: { [key: string]: ISchemaProperties }): {
    [key: string]: ISchemaProperties
} {
    const filteredProperties: { [key: string]: ISchemaProperties } = {};
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
        if (property.type === 'array' && !property.items?.type) {
            const itemsType = inferArrayItemType(property);
            if (itemsType) {
                filteredProperties[key].items = {
                    ...filteredProperties[key].items,
                    title: filteredProperties[key].title ?? 'Item',
                    description: filteredProperties[key].description ?? 'Item',
                    type: itemsType,
                };
            }
        }
    }
    return filteredProperties;
}

/**
 * Marks input properties as required by adding a "REQUIRED" prefix to their descriptions.
 * Takes an IActorInput object and returns a modified Record of SchemaProperties.
 *
 * This is done for maximum compatibility in case where library or agent framework does not consider
 * required fields and does not handle the JSON schema properly: we are prepending this to the description
 * as a preventive measure.
 * @param {IActorInputSchema} input - Actor input object containing properties and required fields
 * @returns {Record<string, ISchemaProperties>} - Modified properties with required fields marked
 */
export function markInputPropertiesAsRequired(input: IActorInputSchema): Record<string, ISchemaProperties> {
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
 * Helps determine the type of items in an array schema property.
 * Priority order: explicit type in items > prefill type > default value type > editor type.
 *
 * Based on JSON schema, the array needs a type, and most of the time Actor input schema does not have this, so we need to infer that.
 *
 */
export function inferArrayItemType(property: ISchemaProperties): string | null {
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
export function addEnumsToDescriptionsWithExamples(properties: Record<string, ISchemaProperties>): Record<string, ISchemaProperties> {
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
 * @param properties
 */
export function shortenProperties(properties: { [key: string]: ISchemaProperties }): {
    [key: string]: ISchemaProperties
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
