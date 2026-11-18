import { describe, expect, it } from 'vitest';

import { compileSchema, createAjv, fixZodSchemaRequired, hasCoercedValue } from '../../src/utils/ajv.js';

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

describe('createAjv — regex keywords disabled (ReDoS guard)', () => {
    // The `pattern`/`patternProperties`/`format` keywords compile an attacker-controlled RegExp from
    // untrusted schemas, enabling catastrophic-backtracking ReDoS. They are removed from the instance,
    // so the keyword is ignored: a value that would violate the pattern still validates.
    it('does not enforce `pattern` (no RegExp is compiled from the schema)', () => {
        const validate = createAjv().compile({
            type: 'object',
            properties: { q: { type: 'string', pattern: '^(a+)+$' } },
            required: ['q'],
        });
        expect(validate({ q: 'this-would-never-match-the-pattern!' })).toBe(true);
    });

    it('does not enforce `patternProperties`', () => {
        const validate = createAjv().compile({
            type: 'object',
            patternProperties: { '^(a+)+$': { type: 'string' } },
        });
        expect(validate({ anything: 123 })).toBe(true);
    });

    it('does not enforce `format`', () => {
        const validate = createAjv().compile({
            type: 'object',
            properties: { email: { type: 'string', format: 'email' } },
        });
        expect(validate({ email: 'not-an-email' })).toBe(true);
    });
});

describe('createAjv — `uniqueItems` disabled', () => {
    // The keyword is removed from the instance (`createAjv` says why), so an array with a repeated item validates.
    it('does not enforce `uniqueItems`', () => {
        const validate = createAjv().compile({
            type: 'object',
            properties: { startUrls: { type: 'array', uniqueItems: true } },
        });
        expect(validate({ startUrls: ['https://apify.com', 'https://apify.com'] })).toBe(true);
    });
});

describe('createAjv — Actor input schemas', () => {
    it('strips extra properties when schema has additionalProperties: false', () => {
        const validate = createAjv().compile({
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
        const validate = createAjv().compile({
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
        });

        const data: Record<string, unknown> = { url: 'https://example.com', dynamicField: 'kept' };
        expect(validate(data)).toBe(true);
        expect(data).toEqual({ url: 'https://example.com', dynamicField: 'kept' });
    });
});

describe('hasCoercedValue — a value Ajv changed in place', () => {
    // Shaped like a real Actor input schema; validation runs on the data in place, as at the call sites.
    const validate = compileSchema({
        type: 'object',
        properties: {
            maxItems: { type: 'integer' },
            queries: { type: 'array', items: { type: 'string' } },
            proxyConfiguration: { type: 'object', properties: { useApifyProxy: { type: 'boolean' } } },
            startUrls: { type: 'array', items: { type: 'object', properties: { depth: { type: 'integer' } } } },
        },
        additionalProperties: false,
    });

    function validateAndCheck(input: Record<string, unknown>): boolean {
        const before = structuredClone(input);
        expect(validate(input)).toBe(true);
        return hasCoercedValue(before, input);
    }

    it('detects a numeric string converted to an integer', () => {
        expect(validateAndCheck({ maxItems: '50' })).toBe(true);
    });

    it('detects a single value wrapped into an array', () => {
        expect(validateAndCheck({ queries: 'cafe' })).toBe(true);
    });

    it('detects a coerced value inside a nested object', () => {
        expect(validateAndCheck({ proxyConfiguration: { useApifyProxy: 'true' } })).toBe(true);
    });

    it('detects a coerced value inside an array item', () => {
        expect(validateAndCheck({ startUrls: [{ depth: 1 }, { depth: '2' }] })).toBe(true);
    });

    it('ignores a field Ajv removed', () => {
        expect(validateAndCheck({ maxItems: 50, searchStringsArray: ['cafe'] })).toBe(false);
    });

    it('reports nothing for input that already matches the schema', () => {
        expect(validateAndCheck({ maxItems: 50, queries: ['cafe'], startUrls: [{ depth: 1 }] })).toBe(false);
    });
});
