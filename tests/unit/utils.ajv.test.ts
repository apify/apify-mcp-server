import { describe, expect, it } from 'vitest';

import { ajv, compileSchema, fixZodSchemaRequired } from '../../src/utils/ajv.js';

describe('compileSchema', () => {
    it('should validate declared properties normally', () => {
        const validate = compileSchema({
            type: 'object',
            properties: {
                name: { type: 'string' },
                count: { type: 'number' },
            },
            required: ['name'],
            additionalProperties: false,
        });

        const data = { name: 'test', count: 5 };
        expect(validate(data)).toBe(true);
    });

    it('should mutate the input object by stripping additional properties', () => {
        const validate = compileSchema({
            type: 'object',
            properties: {
                name: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
        });

        const data: Record<string, unknown> = { name: 'test', extraKey: 'noise', anotherExtra: 42 };
        expect(validate(data)).toBe(true);
        expect(data).toEqual({ name: 'test' });
    });

    it('should still reject invalid declared properties', () => {
        const validate = compileSchema({
            type: 'object',
            properties: {
                name: { type: 'string' },
                count: { type: 'number' },
            },
            required: ['name'],
            additionalProperties: false,
        });

        expect(validate({ count: 5 })).toBe(false); // missing required 'name'
        expect(validate({ name: [1, 2] })).toBe(false); // wrong type (array, not coercible to string)
    });

    it('should allow omitting a field that has a default even when it is listed as required', () => {
        const validate = compileSchema({
            type: 'object',
            properties: {
                name: { type: 'string' },
                format: { type: 'string', default: 'json' },
            },
            required: ['name', 'format'],
            additionalProperties: false,
        });

        // 'format' has a default so it shouldn't be required
        expect(validate({ name: 'test' })).toBe(true);
    });
});

describe('fixZodSchemaRequired', () => {
    // Regression: #637 — phantom `default: undefined` must not clear required fields.
    it('keeps required fields whose `default` is explicitly undefined', () => {
        const result = fixZodSchemaRequired({
            type: 'object',
            properties: {
                query: { type: 'string', default: undefined },
                maxResults: { type: 'integer', default: 3 },
            },
            required: ['query', 'maxResults'],
        });

        expect(result.required).toEqual(['query']);
    });

    it('removes fields with a real default from the `required` array (properties are left intact)', () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                format: { type: 'string', default: 'json' },
            },
            required: ['name', 'format'],
        };

        const result = fixZodSchemaRequired(schema);

        expect(result.required).toEqual(['name']);
        // `format` must still be in `properties` — we only edited `required`, not the fields.
        expect(result.properties).toEqual(schema.properties);
    });

    it('keeps required fields when properties have no `default` key at all', () => {
        const result = fixZodSchemaRequired({
            type: 'object',
            properties: {
                url: { type: 'string' },
            },
            required: ['url'],
        });

        expect(result.required).toEqual(['url']);
    });
});

describe('ajv instance — Actor input schemas', () => {
    it('should strip extra properties when schema has additionalProperties: false', () => {
        const validate = ajv.compile({
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
            additionalProperties: false,
        });

        const data: Record<string, unknown> = { url: 'https://example.com', extraNoise: 'stripped' };
        expect(validate(data)).toBe(true);
        expect(data).toEqual({ url: 'https://example.com' });
    });

    it('should keep extra properties when schema omits additionalProperties', () => {
        const validate = ajv.compile({
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
        });

        const data: Record<string, unknown> = { url: 'https://example.com', dynamicField: 'kept' };
        expect(validate(data)).toBe(true);
        expect(data).toEqual({ url: 'https://example.com', dynamicField: 'kept' });
    });
});
