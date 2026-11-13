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
        [
            'properties',
            { type: 'object', properties: Object.fromEntries(names(1400).map((name) => [name, { type: 'string' }])) },
        ],
        ['members of a schema list', { allOf: strings(900) }],
        ['tuple items', { type: 'array', items: strings(900) }],
        ['names a property depends on', { dependencies: { url: names(900) } }],
        [
            'properties with dependencies',
            { dependencies: Object.fromEntries(names(450).map((name) => [name, ['url']])) },
        ],
        [
            'properties and list members together',
            { properties: Object.fromEntries(names(700).map((name) => [name, false])), anyOf: strings(700) },
        ],
    ])(
        'refuses a schema whose validator would nest too deep for its %s, before Ajv generates any code',
        (_name, schema) => {
            vi.mocked(createAjv).mockClear();

            expect(() => compileUntrustedSchema(schema)).toThrow(SchemaTooLargeError);
            expect(createAjv).not.toHaveBeenCalled();
        },
    );

    it('does not count a property without a keyword to check towards the nesting', () => {
        const described = Object.fromEntries(
            names(2000).map((name) => [name, { title: name, description: 'Any value' }]),
        );

        const { validate } = compileUntrustedSchema({
            type: 'object',
            properties: { ...described, url: { type: 'string' } },
        });

        expect(validate({ field0: 1, field1999: {}, url: 'https://example.com' })).toBe(true);
        expect(validate({ url: {} })).toBe(false);
    });

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

    describe('a schema with an `$id`', () => {
        const withId = ($id: string) => ({ ...schemaFor('apify/facebook-posts-scraper'), $id });

        it('hands over validator code without the `$id` in it', () => {
            const codes: string[] = [];
            vi.mocked(createAjv).mockImplementationOnce((checkCode) =>
                createRealAjv((code) => {
                    codes.push(code);
                    checkCode?.(code);
                }),
            );

            const { validate } = compileUntrustedSchema(withId('https://example.com/schemas/facebook-posts.json'));

            expect(validate({ startUrls: ['https://example.com'] })).toBe(true);
            expect(validate({ startUrls: [{}] })).toBe(false);
            expect(codes.length).toBeGreaterThan(0);
            expect(codes.join('')).not.toContain('facebook-posts.json');
            expect(codes.join('')).not.toContain('sourceURL');
        });

        it.each([
            ['at the root', withId('https://example.com/*/posts.json')],
            ['in a nested schema', { type: 'object', properties: { post: withId('posts*/') } }],
            ['with an escaped character before it', withId('https://example.com/"posts"/*/')],
        ])('refuses an `$id` that holds the end of a comment %s, before Ajv generates any code', (_name, schema) => {
            vi.mocked(createAjv).mockClear();

            expect(() => compileUntrustedSchema(schema)).toThrow(/`\$id` that is not supported/);
            expect(createAjv).not.toHaveBeenCalled();
        });

        it('loads an `$id` with the same characters apart, and the same text outside an `$id`', () => {
            const schema = {
                ...withId('https://example.com/schemas/a*b/c.json'),
                description: 'Matches **/*.json files',
                properties: { glob: { type: 'string', default: '**/*.js', description: 'The "$id":"x*/" of a file' } },
            };

            expect(compileUntrustedSchema(schema).validate({ glob: 'src/**/*.ts' })).toBe(true);
        });
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

    it('drops the least recently used validators once their code takes more memory than the cache may use', () => {
        const used = compileUntrustedSchema(schemaFor('apify/playwright-scraper'));
        const unused = compileUntrustedSchema(schemaFor('apify/camoufox-scraper'));
        // More code than the cache may hold.
        for (let index = 0; index < 30; index++) {
            addValidatorCodeOnce(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES / 2);
            compileUntrustedSchema(schemaFor(`apify/large-input-${index}`));
            expect(compileUntrustedSchema(schemaFor('apify/playwright-scraper'))).toBe(used);
        }

        expect(compileUntrustedSchema(schemaFor('apify/camoufox-scraper'))).not.toBe(unused);
        expect(getUntrustedValidatorCacheUsage().codeBytes).toBeLessThanOrEqual(
            UNTRUSTED_VALIDATOR_CACHE_MAX_CODE_BYTES,
        );
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
        // More code than the cache may hold: the cache drops the validator.
        for (let index = 0; index < 30; index++) {
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
