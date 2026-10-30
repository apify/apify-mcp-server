import { describe, expect, it } from 'vitest';

import { ajv, compileSchema, fixZodSchemaRequired, getValidationInputChange } from '../../src/utils/ajv.js';

describe('compileSchema', () => {
    it('validates declared properties normally', () => {
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

    it('mutates the input object by stripping additional properties', () => {
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

    it('still rejects invalid declared properties', () => {
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

    it('allows omitting a field that has a default even when it is listed as required', () => {
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
    // Regression: #637 — `default: undefined`, from any producer, must not clear required fields.
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

describe('ajv instance — regex keywords disabled (ReDoS guard)', () => {
    // The `pattern`/`patternProperties`/`format` keywords compile an attacker-controlled RegExp from
    // untrusted schemas, enabling catastrophic-backtracking ReDoS. They are removed from the instance,
    // so the keyword is ignored: a value that would violate the pattern still validates.
    it('does not enforce `pattern` (no RegExp is compiled from the schema)', () => {
        const validate = ajv.compile({
            type: 'object',
            properties: { q: { type: 'string', pattern: '^(a+)+$' } },
            required: ['q'],
        });
        expect(validate({ q: 'this-would-never-match-the-pattern!' })).toBe(true);
    });

    it('does not enforce `patternProperties`', () => {
        const validate = ajv.compile({
            type: 'object',
            patternProperties: { '^(a+)+$': { type: 'string' } },
        });
        expect(validate({ anything: 123 })).toBe(true);
    });

    it('does not enforce `format`', () => {
        const validate = ajv.compile({
            type: 'object',
            properties: { email: { type: 'string', format: 'email' } },
        });
        expect(validate({ email: 'not-an-email' })).toBe(true);
    });
});

describe('ajv instance — Actor input schemas', () => {
    it('strips extra properties when schema has additionalProperties: false', () => {
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

    it('keeps extra properties when schema omits additionalProperties', () => {
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

describe('getValidationInputChange — what a passing check changed', () => {
    const validate = compileSchema({
        type: 'object',
        properties: {
            maxResults: { type: 'integer' },
            searchQueries: { type: 'array', items: { type: 'string' } },
            startUrls: {
                type: 'array',
                items: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
            },
            proxy: {
                type: 'object',
                properties: { useApifyProxy: { type: 'boolean' } },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    });

    function validateAndCompare(input: Record<string, unknown>) {
        const snapshot = structuredClone(input);
        expect(validate(input)).toBe(true);
        return getValidationInputChange(snapshot, input);
    }

    it('reports nothing for an input the check left unchanged', () => {
        expect(validateAndCompare({ maxResults: 5, searchQueries: ['apify'] })).toBeUndefined();
    });

    it('reports a numeric string turned into a number as coerced', () => {
        expect(validateAndCompare({ maxResults: '5' })).toBe('coerced');
    });

    // The scalar is wrapped in a new array; no key disappears, so it must not read as a removal.
    it('reports a scalar wrapped into an array as coerced, not removed', () => {
        expect(validateAndCompare({ searchQueries: 'apify' })).toBe('coerced');
    });

    it('reports a key dropped from an object inside an array as removed', () => {
        expect(validateAndCompare({ startUrls: [{ url: 'https://apify.com', label: 'home' }] })).toBe('removed');
    });

    it('reports a coercion and a removal in the same nested object as coerced_and_removed', () => {
        expect(validateAndCompare({ proxy: { useApifyProxy: 'true', groups: ['RESIDENTIAL'] } })).toBe(
            'coerced_and_removed',
        );
    });
});
