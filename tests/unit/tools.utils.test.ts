import { describe, expect, it } from 'vitest';

import { ACTOR_ENUM_MAX_LENGTH, ACTOR_MAX_DESCRIPTION_LENGTH } from '../../src/const.js';
import { buildApifySpecificProperties, decodeDotPropertyNames, encodeDotPropertyNames,
    inferArrayItemsTypeIfMissing, inferArrayItemType, markInputPropertiesAsRequired, shortenEnum, shortenProperties,
    transformActorInputSchemaProperties } from '../../src/tools/utils.js';
import type { IActorInputSchema, ISchemaProperties } from '../../src/types.js';

describe('buildApifySpecificProperties', () => {
    it('should add resource picker structure to array items with editor resourcePicker', () => {
        const properties: Record<string, ISchemaProperties> = {
            resources: {
                type: 'array',
                title: 'Resources',
                description: 'Array of resources',
                editor: 'resourcePicker',
            },
            otherProp: {
                type: 'string',
                title: 'Other property',
                description: 'Some other property',
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that resourcePicker array has proper item structure (string type)

        expect(result.resources.items).toBeDefined();
        expect(result.resources.items?.type).toBe('string');
        expect(result.resources.items?.title).toBeDefined();
        expect(result.resources.items?.description).toBeDefined();

        // Check that other properties remain unchanged
        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('should add key and value structure to array items with editor keyValue', () => {
        const properties: Record<string, ISchemaProperties> = {
            keyValuePairs: {
                type: 'array',
                title: 'Key-Value Pairs',
                description: 'Array of key-value pairs',
                editor: 'keyValue',
            },
            otherProp: {
                type: 'string',
                title: 'Other property',
                description: 'Some other property',
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that keyValue array has proper item structure
        expect(result.keyValuePairs.items).toBeDefined();
        expect(result.keyValuePairs.items?.type).toBe('object');
        expect(result.keyValuePairs.items?.properties?.key).toBeDefined();
        expect(result.keyValuePairs.items?.properties?.key.type).toBe('string');
        expect(result.keyValuePairs.items?.properties?.value).toBeDefined();
        expect(result.keyValuePairs.items?.properties?.value.type).toBe('string');

        // Check that other properties remain unchanged
        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('should add globs structure to array items with editor globs', () => {
        const properties: Record<string, ISchemaProperties> = {
            globs: {
                type: 'array',
                title: 'Globs',
                description: 'Globs array',
                editor: 'globs',
            },
            otherProp: {
                type: 'string',
                title: 'Other property',
                description: 'Some other property',
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that globs array has proper item structure
        expect(result.globs.items).toBeDefined();
        expect(result.globs.items?.type).toBe('object');
        expect(result.globs.items?.properties?.glob).toBeDefined();
        expect(result.globs.items?.properties?.glob.type).toBe('string');
        expect(result.globs.items?.properties?.method).toBeDefined();
        expect(result.globs.items?.properties?.method.type).toBe('string');
        expect(result.globs.items?.properties?.payload).toBeDefined();
        expect(result.globs.items?.properties?.payload.type).toBe('string');
        expect(result.globs.items?.properties?.userData).toBeDefined();
        expect(result.globs.items?.properties?.userData.type).toBe('object');
        expect(result.globs.items?.properties?.headers).toBeDefined();
        expect(result.globs.items?.properties?.headers.type).toBe('object');

        // Check that other properties remain unchanged
        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('should add pseudoUrls structure to array items with items.editor pseudoUrls', () => {
        const properties: Record<string, ISchemaProperties> = {
            pseudoUrls: {
                type: 'array',
                title: 'PseudoUrls',
                description: 'PseudoUrls array',
                editor: 'pseudoUrls',
            },
            otherProp: {
                type: 'string',
                title: 'Other property',
                description: 'Some other property',
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that pseudoUrls array has proper item structure
        expect(result.pseudoUrls.items).toBeDefined();
        expect(result.pseudoUrls.items?.type).toBe('object');
        expect(result.pseudoUrls.items?.properties?.purl).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.purl.type).toBe('string');
        expect(result.pseudoUrls.items?.properties?.method).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.method.type).toBe('string');
        expect(result.pseudoUrls.items?.properties?.payload).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.payload.type).toBe('string');
        expect(result.pseudoUrls.items?.properties?.userData).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.userData.type).toBe('object');
        expect(result.pseudoUrls.items?.properties?.headers).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.headers.type).toBe('object');

        // Check that other properties remain unchanged
        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('should add useApifyProxy, apifyProxyGroups, and proxyUrls properties to proxy objects', () => {
        const properties: Record<string, ISchemaProperties> = {
            proxy: {
                type: 'object',
                editor: 'proxy',
                title: 'Proxy configuration',
                description: 'Proxy settings',
                properties: {},
            },
            otherProp: {
                type: 'string',
                title: 'Other property',
                description: 'Some other property',
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that proxy object has useApifyProxy property
        expect(result.proxy.properties).toBeDefined();
        expect(result.proxy.properties?.useApifyProxy).toBeDefined();
        expect(result.proxy.properties?.useApifyProxy.type).toBe('boolean');
        expect(result.proxy.properties?.useApifyProxy.default).toBe(true);
        expect(result.proxy.required).toContain('useApifyProxy');

        // Check that proxy object has apifyProxyGroups property
        expect(result.proxy.properties?.apifyProxyGroups).toBeDefined();
        expect(result.proxy.properties?.apifyProxyGroups.type).toBe('array');
        expect(result.proxy.properties?.apifyProxyGroups.items).toBeDefined();
        expect(result.proxy.properties?.apifyProxyGroups.items?.enum).toEqual([
            'RESIDENTIAL',
            'DATACENTER',
        ]);

        // Check that proxy object has proxyUrls property
        expect(result.proxy.properties?.proxyUrls).toBeDefined();
        expect(result.proxy.properties?.proxyUrls.type).toBe('array');
        expect(result.proxy.properties?.proxyUrls.items).toBeDefined();
        expect(result.proxy.properties?.proxyUrls.items?.type).toBe('string');

        // Check that other properties remain unchanged
        expect(result.otherProp).toEqual(properties.otherProp);
    });

    it('should add URL structure to requestListSources array items', () => {
        const properties: Record<string, ISchemaProperties> = {
            sources: {
                type: 'array',
                editor: 'requestListSources',
                title: 'Request list sources',
                description: 'Sources to scrape',
            },
            otherProp: {
                type: 'string',
                title: 'Other property',
                description: 'Some other property',
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that requestListSources array has proper item structure
        expect(result.sources.items).toBeDefined();
        expect(result.sources.items?.type).toBe('object');
        expect(result.sources.items?.properties?.url).toBeDefined();
        expect(result.sources.items?.properties?.url.type).toBe('string');

        // Check that other properties remain unchanged
        expect(result.otherProp).toEqual(properties.otherProp);
    });

    it('should not modify properties that don\'t match special cases', () => {
        const properties: Record<string, ISchemaProperties> = {
            regularObject: {
                type: 'object',
                title: 'Regular object',
                description: 'A regular object without special editor',
                properties: {
                    subProp: {
                        type: 'string',
                        title: 'Sub property',
                        description: 'Sub property description',
                    },
                },
            },
            regularArray: {
                type: 'array',
                title: 'Regular array',
                description: 'A regular array without special editor',
                items: {
                    type: 'string',
                    title: 'Item',
                    description: 'Item description',
                },
            },
        };

        const result = buildApifySpecificProperties(properties);

        // Check that regular properties remain unchanged
        expect(result).toEqual(properties);
    });

    it('should handle empty properties object', () => {
        const properties: Record<string, ISchemaProperties> = {};
        const result = buildApifySpecificProperties(properties);
        expect(result).toEqual({});
    });
});

describe('markInputPropertiesAsRequired', () => {
    it('should add REQUIRED prefix to required properties', () => {
        const input: IActorInputSchema = {
            title: 'Test Schema',
            type: 'object',
            required: ['requiredProp1', 'requiredProp2'],
            properties: {
                requiredProp1: {
                    type: 'string',
                    title: 'Required Property 1',
                    description: 'This is required',
                },
                requiredProp2: {
                    type: 'number',
                    title: 'Required Property 2',
                    description: 'This is also required',
                },
                optionalProp: {
                    type: 'boolean',
                    title: 'Optional Property',
                    description: 'This is optional',
                },
            },
        };

        const result = markInputPropertiesAsRequired(input);

        // Check that required properties have REQUIRED prefix
        expect(result.requiredProp1.description).toContain('**REQUIRED**');
        expect(result.requiredProp2.description).toContain('**REQUIRED**');

        // Check that optional properties remain unchanged
        expect(result.optionalProp.description).toBe('This is optional');
    });

    it('should handle input without required fields', () => {
        const input: IActorInputSchema = {
            title: 'Test Schema',
            type: 'object',
            properties: {
                prop1: {
                    type: 'string',
                    title: 'Property 1',
                    description: 'Description 1',
                },
                prop2: {
                    type: 'number',
                    title: 'Property 2',
                    description: 'Description 2',
                },
            },
        };

        const result = markInputPropertiesAsRequired(input);

        // Check that no properties were modified
        expect(result).toEqual(input.properties);
    });

    it('should handle empty required array', () => {
        const input: IActorInputSchema = {
            title: 'Test Schema',
            type: 'object',
            required: [],
            properties: {
                prop1: {
                    type: 'string',
                    title: 'Property 1',
                    description: 'Description 1',
                },
            },
        };

        const result = markInputPropertiesAsRequired(input);

        // Check that no properties were modified
        expect(result).toEqual(input.properties);
    });
});

describe('shortenProperties', () => {
    it('should truncate long descriptions', () => {
        const longDescription = 'a'.repeat(ACTOR_MAX_DESCRIPTION_LENGTH + 100);
        const properties: Record<string, ISchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: longDescription,
            },
        };

        const result = shortenProperties(properties);

        // Check that description was truncated
        expect(result.prop1.description.length).toBeLessThanOrEqual(ACTOR_MAX_DESCRIPTION_LENGTH + 3); // +3 for "..."
        expect(result.prop1.description.endsWith('...')).toBe(true);
    });

    it('should not modify descriptions that are within limits', () => {
        const description = 'This is a normal description';
        const properties: Record<string, ISchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description,
            },
        };

        const result = shortenProperties(properties);

        // Check that description was not modified
        expect(result.prop1.description).toBe(description);
    });

    it('should shorten enum values if they exceed the limit', () => {
        // Create an enum with many values to exceed the character limit
        const enumValues = Array.from({ length: 50 }, (_, i) => `enum-value-${i}`);
        const properties: Record<string, ISchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: 'Property with enum',
                enum: enumValues,
            },
        };

        const result = shortenProperties(properties);

        // Check that enum was shortened
        expect(result.prop1.enum).toBeDefined();
        if (result.prop1.enum) {
            expect(result.prop1.enum.length).toBeLessThan(30);
            const totalEnumLen = result.prop1.enum.reduce((sum, v) => sum + v.length, 0);
            expect(totalEnumLen).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);

            // Calculate total character length of enum values
            const totalLength = result.prop1.enum.reduce((sum, val) => sum + val.length, 0);
            expect(totalLength).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);
        } else {
            expect(result.prop1.enum).toBeUndefined();
        }
    });

    it('should shorten items.enum values if they exceed the limit', () => {
        // Create an enum with many values to exceed the character limit
        const enumValues = Array.from({ length: 50 }, (_, i) => `enum-value-${i}`);
        const properties: Record<string, ISchemaProperties> = {
            prop1: {
                type: 'array',
                title: 'Property 1',
                description: 'Property with items.enum',
                items: {
                    type: 'string',
                    title: 'Item',
                    description: 'Item description',
                    enum: enumValues,
                },
            },
        };

        const result = shortenProperties(properties);

        // Check that items.enum was shortened
        expect(result.prop1.items?.enum).toBeDefined();
        if (result.prop1.items?.enum) {
            expect(result.prop1.items.enum.length).toBeLessThan(enumValues.length);
            const totalLength = result.prop1.items.enum.reduce((sum, val) => sum + val.length, 0);
            expect(totalLength).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);

            // Calculate total character length of enum values
            expect(totalLength).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);
        } else {
            expect(result.prop1.items?.enum).toBeUndefined();
        }
    });

    it('should handle properties without enum or items.enum', () => {
        const properties: Record<string, ISchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: 'Regular property',
            },
            prop2: {
                type: 'array',
                title: 'Property 2',
                description: 'Array property',
                items: {
                    type: 'string',
                    title: 'Item',
                    description: 'Item description',
                },
            },
        };

        const result = shortenProperties(properties);

        // Check that properties were not modified
        expect(result).toEqual(properties);
    });

    it('should handle empty enum arrays', () => {
        const properties: Record<string, ISchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: 'Property with empty enum',
                enum: [],
            },
            prop2: {
                type: 'array',
                title: 'Property 2',
                description: 'Array with empty items.enum',
                items: {
                    type: 'string',
                    title: 'Item',
                    description: 'Item description',
                    enum: [],
                },
            },
        };

        const result = shortenProperties(properties);

        // Check that properties were not modified
        expect(result).toEqual(properties);
    });
});

describe('encodeDotPropertyNames', () => {
    it('should replace dots in property names with -dot-', () => {
        const input = {
            'foo.bar': { type: 'string', title: 'Foo Bar', description: 'desc' },
            baz: { type: 'number', title: 'Baz', description: 'desc2' },
            'a.b.c': { type: 'boolean', title: 'A B C', description: 'desc3' },
        };
        const result = encodeDotPropertyNames(input);
        expect(result['foo-dot-bar']).toBeDefined();
        expect(result['a-dot-b-dot-c']).toBeDefined();
        expect(result.baz).toBeDefined();
        expect(result['foo.bar']).toBeUndefined();
        expect(result['a.b.c']).toBeUndefined();
    });

    it('should not modify property names without dots', () => {
        const input = {
            foo: { type: 'string', title: 'Foo', description: 'desc' },
            bar: { type: 'number', title: 'Bar', description: 'desc2' },
        };
        const result = encodeDotPropertyNames(input);
        expect(result).toEqual(input);
    });
});

describe('decodeDotPropertyNames', () => {
    it('should replace -dot- in property names with dots', () => {
        const input = {
            'foo-dot-bar': { type: 'string', title: 'Foo Bar', description: 'desc' },
            baz: { type: 'number', title: 'Baz', description: 'desc2' },
            'a-dot-b-dot-c': { type: 'boolean', title: 'A B C', description: 'desc3' },
        };
        const result = decodeDotPropertyNames(input);
        expect(result['foo.bar']).toBeDefined();
        expect(result['a.b.c']).toBeDefined();
        expect(result.baz).toBeDefined();
        expect(result['foo-dot-bar']).toBeUndefined();
        expect(result['a-dot-b-dot-c']).toBeUndefined();
    });

    it('should not modify property names without -dot-', () => {
        const input = {
            foo: { type: 'string', title: 'Foo', description: 'desc' },
            bar: { type: 'number', title: 'Bar', description: 'desc2' },
        };
        const result = decodeDotPropertyNames(input);
        expect(result).toEqual(input);
    });
});

// ----------------------
// Tests for transformActorInputSchemaProperties
// ----------------------
describe('transformActorInputSchemaProperties', () => {
    it('should correctly transform a schema with all Apify-specific types and features', () => {
        const input: IActorInputSchema = {
            title: 'Complex Schema',
            type: 'object',
            required: [
                'resourcePicker',
                'keyValue',
                'globs',
                'pseudoUrls',
                'proxy',
                'requestListSources',
                'simpleString',
                'enumString',
                'arrayOfStrings',
                'dotted.name',
            ],
            properties: {
                resourcePicker: {
                    type: 'array',
                    title: 'Resource Picker',
                    description: 'Pick a resource',
                    editor: 'resourcePicker',
                },
                keyValue: {
                    type: 'array',
                    title: 'Key Value',
                    description: 'Key value pairs',
                    editor: 'keyValue',
                },
                globs: {
                    type: 'array',
                    title: 'Globs',
                    description: 'Globs array',
                    editor: 'globs',
                },
                pseudoUrls: {
                    type: 'array',
                    title: 'PseudoUrls',
                    description: 'PseudoUrls array',
                    editor: 'pseudoUrls',
                },
                proxy: {
                    type: 'object',
                    title: 'Proxy',
                    description: 'Proxy config',
                    editor: 'proxy',
                    properties: {},
                },
                requestListSources: {
                    type: 'array',
                    title: 'Request List Sources',
                    description: 'Sources',
                    editor: 'requestListSources',
                },
                simpleString: {
                    type: 'string',
                    title: 'Simple String',
                    description: 'A simple string',
                },
                enumString: {
                    type: 'string',
                    title: 'Enum String',
                    description: 'A string with enum',
                    enum: ['A', 'B', 'C'],
                    default: 'A',
                },
                arrayOfStrings: {
                    type: 'array',
                    title: 'Array of Strings',
                    description: 'An array of strings',
                    prefill: ['foo', 'bar'],
                },
                'dotted.name': {
                    type: 'number',
                    title: 'Dotted Name',
                    description: 'A property with a dot in its name',
                },
            },
        };

        const result = transformActorInputSchemaProperties(input);

        // Resource Picker
        expect(result.resourcePicker).toBeDefined();
        expect(result.resourcePicker.items).toBeDefined();
        expect(result.resourcePicker.items?.type).toBe('string');
        expect(result.resourcePicker.description).toContain('**REQUIRED**');

        // Key Value
        expect(result.keyValue).toBeDefined();
        expect(result.keyValue.items).toBeDefined();
        expect(result.keyValue.items?.type).toBe('object');
        expect(result.keyValue.items?.properties?.key).toBeDefined();
        expect(result.keyValue.items?.properties?.value).toBeDefined();
        expect(result.keyValue.description).toContain('**REQUIRED**');

        // Globs
        expect(result.globs).toBeDefined();
        expect(result.globs.items).toBeDefined();
        expect(result.globs.items?.properties?.glob).toBeDefined();
        expect(result.globs.items?.properties?.userData).toBeDefined();
        expect(result.globs.description).toContain('**REQUIRED**');

        // PseudoUrls
        expect(result.pseudoUrls).toBeDefined();
        expect(result.pseudoUrls.items).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.purl).toBeDefined();
        expect(result.pseudoUrls.items?.properties?.method).toBeDefined();
        expect(result.pseudoUrls.description).toContain('**REQUIRED**');

        // Proxy
        expect(result.proxy).toBeDefined();
        expect(result.proxy.properties?.useApifyProxy).toBeDefined();
        expect(result.proxy.properties?.apifyProxyGroups).toBeDefined();
        expect(result.proxy.properties?.proxyUrls).toBeDefined();
        expect(result.proxy.required).toContain('useApifyProxy');
        expect(result.proxy.description).toContain('**REQUIRED**');

        // Request List Sources
        expect(result.requestListSources).toBeDefined();
        expect(result.requestListSources.items).toBeDefined();
        expect(result.requestListSources.items?.properties?.url).toBeDefined();
        expect(result.requestListSources.description).toContain('**REQUIRED**');

        // Simple String
        expect(result.simpleString).toBeDefined();
        expect(result.simpleString.type).toBe('string');
        expect(result.simpleString.description).toContain('**REQUIRED**');

        // Enum String
        expect(result.enumString).toBeDefined();
        expect(result.enumString.enum).toBeDefined();
        expect(result.enumString.description).toContain('Possible values:');
        expect(result.enumString.description).toContain('Example values:');
        expect(result.enumString.description).toContain('**REQUIRED**');

        // Array of Strings
        expect(result.arrayOfStrings).toBeDefined();
        expect(result.arrayOfStrings.items).toBeDefined();
        expect(result.arrayOfStrings.items?.type).toBe('string');
        expect(result.arrayOfStrings.description).toContain('**REQUIRED**');

        // Dotted property name
        expect(result['dotted-dot-name']).toBeDefined();
        expect(result['dotted-dot-name'].type).toBe('number');
        expect(result['dotted-dot-name'].description).toContain('**REQUIRED**');
        // Should not have the original dotted name
        expect(result['dotted.name']).toBeUndefined();
    });
    it('should apply all transformations in the correct order', () => {
        const input = {
            title: 'Test',
            type: 'object',
            required: ['foo.bar', 'enumProp'],
            properties: {
                'foo.bar': {
                    type: 'string',
                    title: 'Foo Bar',
                    description: 'desc',
                },
                proxy: {
                    type: 'object',
                    editor: 'proxy',
                    title: 'Proxy',
                    description: 'Proxy desc',
                    properties: {},
                },
                sources: {
                    type: 'array',
                    editor: 'requestListSources',
                    title: 'Sources',
                    description: 'Sources desc',
                },
                enumProp: {
                    type: 'string',
                    title: 'Enum',
                    description: 'Enum desc',
                    enum: Array.from({ length: 30 }, (_, i) => `val${i}`),
                },
                longDesc: {
                    type: 'string',
                    title: 'Long',
                    description: 'a'.repeat(ACTOR_MAX_DESCRIPTION_LENGTH + 10),
                },
            },
        };
        const result = transformActorInputSchemaProperties(input);
        // 1. markInputPropertiesAsRequired: required fields get **REQUIRED** in description
        expect(result['foo-dot-bar'].description).toContain('**REQUIRED**');
        expect(result.enumProp.description).toContain('**REQUIRED**');
        // 2. buildNestedProperties: proxy gets useApifyProxy, sources gets url
        expect(result.proxy.properties).toBeDefined();
        expect(result.proxy.properties?.useApifyProxy).toBeDefined();
        expect(result.sources.items).toBeDefined();
        expect(result.sources.items?.properties?.url).toBeDefined();
        // 3. filterSchemaProperties: only allowed fields present
        expect(Object.keys(result['foo-dot-bar'])).toEqual(
            expect.arrayContaining(['title', 'description', 'type', 'default', 'prefill', 'properties', 'items', 'required', 'enum']),
        );
        // 4. shortenProperties: longDesc is truncated, enumProp.enum is shortened
        expect(result.longDesc.description.length).toBeLessThanOrEqual(ACTOR_MAX_DESCRIPTION_LENGTH + 3);
        if (result.enumProp.enum) {
            expect(result.enumProp.enum.length).toBeLessThanOrEqual(30);
            const totalEnumLen = result.enumProp.enum.reduce((sum, v) => sum + v.length, 0);
            expect(totalEnumLen).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);
        } else {
            // If enum is too long, it may be set to undefined
            expect(result.enumProp.enum).toBeUndefined();
        }
        // 5. addEnumsToDescriptionsWithExamples: enum values in description
        expect(result.enumProp.description).toMatch(/Possible values:/);
        // 6. encodeDotPropertyNames: foo.bar becomes foo-dot-bar
        expect(result['foo-dot-bar']).toBeDefined();
        expect(result['foo.bar']).toBeUndefined();
    });

    it('should handle input with no required, no enums, no dots', () => {
        const input = {
            title: 'Simple',
            type: 'object',
            properties: {
                simple: {
                    type: 'string',
                    title: 'Simple',
                    description: 'desc',
                },
            },
        };
        const result = transformActorInputSchemaProperties(input);
        expect(result.simple.description).toBe('desc');
        expect(result.simple.enum).toBeUndefined();
        expect(result.simple).toBeDefined();
    });

    it('should encode all dotted property names', () => {
        const input = {
            title: 'Dots',
            type: 'object',
            properties: {
                'a.b': { type: 'string', title: 'A B', description: 'desc' },
                'c.d.e': { type: 'number', title: 'CDE', description: 'desc2' },
            },
        };
        const result = transformActorInputSchemaProperties(input);
        expect(result['a-dot-b']).toBeDefined();
        expect(result['c-dot-d-dot-e']).toBeDefined();
        expect(result['a.b']).toBeUndefined();
        expect(result['c.d.e']).toBeUndefined();
    });

    it('should not mutate the input object', () => {
        const input = {
            title: 'Immut',
            type: 'object',
            required: ['foo'],
            properties: {
                foo: { type: 'string', title: 'Foo', description: 'desc' },
            },
        };
        const inputCopy = JSON.parse(JSON.stringify(input));
        transformActorInputSchemaProperties(input);
        expect(input).toEqual(inputCopy);
    });

    it('should build array items property correctly for stringList editor with place IDs', () => {
        const input: IActorInputSchema = {
            type: 'object',
            schemaVersion: 1,
            properties: {
                placeIds: {
                    title: '🗃 Place IDs',
                    type: 'array',
                    description: 'List of place IDs.',
                    editor: 'stringList',
                },
            },
        };

        const result = transformActorInputSchemaProperties(input);

        // Verify that array items type was correctly inferred and set
        expect(result.placeIds.type).toBe('array');
        expect(result.placeIds.items).toBeDefined();
        expect(result.placeIds.items?.type).toBe('string');
        expect(result.placeIds.items?.title).toBe('🗃 Place IDs');
        expect(result.placeIds.items?.description).toBe(input.properties.placeIds.description);

        // Verify that the property name was encoded (dots replaced with -dot-)
        expect(result.placeIds).toBeDefined();

        // Verify that other transformations were applied
        expect(result.placeIds.title).toBe('🗃 Place IDs');
        expect(result.placeIds.description).toBe(input.properties.placeIds.description);
    });
});

describe('inferArrayItemType', () => {
    it('infers array item type from editor', () => {
        const property = {
            type: 'array',
            editor: 'stringList',
            title: '',
            description: '',
            enum: [],
            default: '',
            prefill: '',
        };
        expect(inferArrayItemType(property)).toBe('string');
    });

    it('infers string type for stringList editor with place IDs input', () => {
        const property: ISchemaProperties = {
            title: 'Place IDs',
            type: 'array',
            description: 'List of place IDs.',
            editor: 'stringList',
        };

        expect(inferArrayItemType(property)).toBe('string');
    });
});

describe('inferArrayItemsTypeIfMissing', () => {
    it('should infer and set items type for array property with stringList editor', () => {
        const properties: { [key: string]: ISchemaProperties } = {
            placeIds: {
                title: '🗃 Place IDs',
                type: 'array',
                description: 'List of place IDs.',
                editor: 'stringList',
            },
        };

        const result = inferArrayItemsTypeIfMissing(properties);

        expect(result.placeIds.items).toBeDefined();
        expect(result.placeIds.items?.type).toBe('string');
        expect(result.placeIds.items?.title).toBe('🗃 Place IDs');
        expect(result.placeIds.items?.description).toBe(properties.placeIds.description);
    });

    it('should not modify array properties that already have items.type defined', () => {
        const properties: { [key: string]: ISchemaProperties } = {
            existingArray: {
                title: 'Existing Array',
                type: 'array',
                description: 'Array with existing items type',
                items: {
                    type: 'number',
                    title: 'Number Item',
                    description: 'A number item',
                },
            },
        };

        const result = inferArrayItemsTypeIfMissing(properties);

        expect(result.existingArray.items?.type).toBe('number');
        expect(result.existingArray.items?.title).toBe('Number Item');
        expect(result.existingArray.items?.description).toBe('A number item');
    });
});

describe('shortenEnum', () => {
    it('shorten enum list', () => {
        const enumList: string[] = [];
        const wordLength = 10;
        const wordCount = 30;

        for (let i = 0; i < wordCount; i++) {
            enumList.push('a'.repeat(wordLength));
        }

        const shortenedList = shortenEnum(enumList);

        expect(shortenedList?.length || 0).toBe(ACTOR_ENUM_MAX_LENGTH / wordLength);
    });
});
