import { describe, expect, it } from 'vitest';

import { ACTOR_ENUM_MAX_LENGTH, ACTOR_MAX_DESCRIPTION_LENGTH } from '../../src/const.js';
import { buildNestedProperties, markInputPropertiesAsRequired, shortenProperties } from '../../src/tools/utils.js';
import type { IActorInputSchema, ISchemaProperties } from '../../src/types.js';

describe('buildNestedProperties', () => {
    it('should add useApifyProxy property to proxy objects', () => {
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

        const result = buildNestedProperties(properties);

        // Check that proxy object has useApifyProxy property
        expect(result.proxy.properties).toBeDefined();
        expect(result.proxy.properties?.useApifyProxy).toBeDefined();
        expect(result.proxy.properties?.useApifyProxy.type).toBe('boolean');
        expect(result.proxy.properties?.useApifyProxy.default).toBe(true);
        expect(result.proxy.required).toContain('useApifyProxy');

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

        const result = buildNestedProperties(properties);

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

        const result = buildNestedProperties(properties);

        // Check that regular properties remain unchanged
        expect(result).toEqual(properties);
    });

    it('should handle empty properties object', () => {
        const properties: Record<string, ISchemaProperties> = {};
        const result = buildNestedProperties(properties);
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
        expect(result.prop1.enum!.length).toBeLessThan(enumValues.length);

        // Calculate total character length of enum values
        const totalLength = result.prop1.enum!.reduce((sum, val) => sum + val.length, 0);
        expect(totalLength).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);
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
        expect(result.prop1.items!.enum!.length).toBeLessThan(enumValues.length);

        // Calculate total character length of enum values
        const totalLength = result.prop1.items!.enum!.reduce((sum, val) => sum + val.length, 0);
        expect(totalLength).toBeLessThanOrEqual(ACTOR_ENUM_MAX_LENGTH);
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
