import { describe, expect, it, vi } from 'vitest';

import { SchemaTooLargeError } from '../../src/errors.js';
import {
    compileUntrustedSchema,
    getUntrustedValidatorCacheUsage,
    MAX_UNTRUSTED_VALIDATOR_CODE_BYTES,
    MAX_UNTRUSTED_VALIDATOR_NESTING,
    UNTRUSTED_VALIDATOR_CACHE_MAX_CODE_BYTES,
    UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE,
} from '../../src/tools/actor_input_schema.js';
import type * as AjvModule from '../../src/utils/ajv.js';
import { createAjv } from '../../src/utils/ajv.js';

// The real Ajv, wrapped so that a test can stand in for what Ajv generates or for an engine that cannot run it.
vi.mock('../../src/utils/ajv.js', async (importOriginal) => {
    const actual = await importOriginal<typeof AjvModule>();
    return { ...actual, createAjv: vi.fn(actual.createAjv) };
});

const { createAjv: createRealAjv } = await vi.importActual<typeof AjvModule>('../../src/utils/ajv.js');

const schemaFor = (actorName: string) => ({
    type: 'object',
    title: `Input of ${actorName}`,
    properties: { startUrls: { type: 'array', items: { type: 'string' } } },
});

/** Makes the next compilation report `codeBytes` more validator code than Ajv generates. */
function addValidatorCodeOnce(codeBytes: number): void {
    vi.mocked(createAjv).mockImplementationOnce((checkCode) => {
        checkCode?.('x'.repeat(codeBytes));
        return createRealAjv(checkCode);
    });
}

describe('compileUntrustedSchema and the validator Ajv generates', () => {
    const groupOfFlags = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`flag${index}`, false]));
    const groupOf = (property: object) =>
        Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`field${index}`, property]));

    it.each([
        [
            'a long property name',
            { type: 'object', properties: { ['settings'.padEnd(20_000, 'x')]: { properties: groupOfFlags } } },
        ],
        [
            'a long property name for every property with one keyword',
            {
                type: 'object',
                properties: { ['settings'.padEnd(4000, 'x')]: { properties: groupOf({ type: 'string' }) } },
            },
        ],
        [
            'a long property name for every property with a list of names',
            {
                type: 'object',
                properties: { ['settings'.padEnd(4000, 'x')]: { properties: groupOf({ required: ['url'] }) } },
            },
        ],
        [
            'a property name with characters that are written as escapes',
            { type: 'object', properties: { ['\u0001'.repeat(2500)]: { properties: groupOfFlags } } },
        ],
        [
            'a long reference',
            {
                type: 'object',
                properties: { settings: { $ref: `#/$defs/${'settings'.padEnd(20_000, 'x')}` } },
                $defs: { ['settings'.padEnd(20_000, 'x')]: { properties: groupOfFlags } },
            },
        ],
    ])('refuses a schema whose errors would repeat %s too often, before Ajv generates any code', (_name, schema) => {
        vi.mocked(createAjv).mockClear();

        expect(() => compileUntrustedSchema(schema)).toThrow(SchemaTooLargeError);
        expect(createAjv).not.toHaveBeenCalled();
    });

    const names = (count: number) => Array.from({ length: count }, (_, index) => `field${index}`);
    const strings = (count: number) => names(count).map(() => ({ type: 'string' }));

    it.each([
        ['properties', { type: 'object', properties: Object.fromEntries(names(1400).map((name) => [name, {}])) }],
        ['members of a schema list', { allOf: strings(900) }],
        ['tuple items', { type: 'array', items: strings(900) }],
        ['names a property depends on', { dependencies: { url: names(900) } }],
        [
            'properties with dependencies',
            { dependencies: Object.fromEntries(names(450).map((name) => [name, ['url']])) },
        ],
        [
            'properties and list members together',
            { properties: Object.fromEntries(names(700).map((name) => [name, {}])), anyOf: strings(700) },
        ],
    ])(
        'refuses a schema whose validator would nest too deep for its %s, before Ajv generates any code',
        (_name, schema) => {
            vi.mocked(createAjv).mockClear();

            expect(() => compileUntrustedSchema(schema)).toThrow(SchemaTooLargeError);
            expect(createAjv).not.toHaveBeenCalled();
        },
    );

    it('throws SchemaTooLargeError when the generated code nests deeper than the limit', () => {
        vi.mocked(createAjv).mockImplementationOnce((checkCode) => {
            checkCode?.(
                `${'{'.repeat(MAX_UNTRUSTED_VALIDATOR_NESTING + 1)}${'}'.repeat(MAX_UNTRUSTED_VALIDATOR_NESTING + 1)}`,
            );
            return createRealAjv(checkCode);
        });

        expect(() => compileUntrustedSchema(schemaFor('apify/website-content-crawler'))).toThrow(
            /nested blocks of validator code/,
        );
    });

    it('refuses a schema that asks for asynchronous validation, which is not supported, before Ajv generates any code', () => {
        vi.mocked(createAjv).mockClear();
        const schema = { ...schemaFor('apify/instagram-scraper'), $async: true };

        expect(() => compileUntrustedSchema(schema)).toThrow(/not supported/);
        expect(() => compileUntrustedSchema(schema)).not.toThrow(SchemaTooLargeError);
        expect(createAjv).not.toHaveBeenCalled();
        expect(
            compileUntrustedSchema({ ...schema, $async: false }).validate({ startUrls: ['https://example.com'] }),
        ).toBe(true);
    });

    it('throws SchemaTooLargeError when the generated code is over the limit', () => {
        addValidatorCodeOnce(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES);

        expect(() => compileUntrustedSchema(schemaFor('apify/web-scraper'))).toThrow(SchemaTooLargeError);
    });

    it('does not remember that Ajv ran out of stack: the answer depends on the engine and the call stack', () => {
        vi.mocked(createAjv).mockImplementationOnce(() => {
            throw new RangeError('Maximum call stack size exceeded');
        });
        const schema = schemaFor('apify/puppeteer-scraper');

        expect(() => compileUntrustedSchema(schema)).toThrow(SchemaTooLargeError);
        expect(compileUntrustedSchema(schema).validate({ startUrls: ['https://example.com'] })).toBe(true);
    });

    it('drops the cached validators once their code takes more memory than the cache may use', () => {
        const first = compileUntrustedSchema(schemaFor('apify/playwright-scraper'));
        let compiledCount = 0;
        while (compileUntrustedSchema(schemaFor('apify/playwright-scraper')) === first && compiledCount < 100) {
            addValidatorCodeOnce(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES / 2);
            compileUntrustedSchema(schemaFor(`apify/large-input-${compiledCount++}`));
        }

        // Several of the largest validators fit; an unlimited number of them does not.
        expect(compiledCount).toBeGreaterThan(4);
        expect(compiledCount).toBeLessThan(100);
    });

    it('keeps the validator cache within its two limits, however many distinct schemas load', () => {
        let mostEntries = 0;
        let mostCodeBytes = 0;
        for (let index = 0; index < UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE + 200; index++) {
            // Every tenth schema stands for a large one.
            if (index % 10 === 0) addValidatorCodeOnce(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES / 4);
            compileUntrustedSchema(schemaFor(`apify/distinct-input-${index}`));
            const { entries, codeBytes } = getUntrustedValidatorCacheUsage();
            mostEntries = Math.max(mostEntries, entries);
            mostCodeBytes = Math.max(mostCodeBytes, codeBytes);
        }

        expect(mostEntries).toBeLessThanOrEqual(UNTRUSTED_VALIDATOR_CACHE_MAX_SIZE);
        expect(mostCodeBytes).toBeLessThanOrEqual(UNTRUSTED_VALIDATOR_CACHE_MAX_CODE_BYTES);
        // The cache was full: the limits were reached, not avoided.
        expect(mostCodeBytes).toBeGreaterThan(UNTRUSTED_VALIDATOR_CACHE_MAX_CODE_BYTES / 2);
    });

    it('serves a validator that holds no compiled code: it compiles again once the cache has dropped it', () => {
        const { validate } = compileUntrustedSchema({
            ...schemaFor('apify/google-search-scraper'),
            required: ['startUrls'],
        });
        expect(validate({ startUrls: ['https://example.com'] })).toBe(true);
        // Fills the cache until it is emptied.
        for (let index = 0; index < 100 && (index === 0 || getUntrustedValidatorCacheUsage().entries > 1); index++) {
            addValidatorCodeOnce(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES / 2);
            compileUntrustedSchema(schemaFor(`apify/large-search-input-${index}`));
        }
        vi.mocked(createAjv).mockClear();

        expect(validate({ startUrls: ['https://example.com'] })).toBe(true);
        expect(validate({})).toBe(false);
        expect(validate.errors).toMatchObject([{ keyword: 'required', params: { missingProperty: 'startUrls' } }]);
        expect(validate({ startUrls: [] })).toBe(true);
        expect(validate.errors).toBeNull();
        // One compilation for the three calls.
        expect(createAjv).toHaveBeenCalledOnce();
    });
});
