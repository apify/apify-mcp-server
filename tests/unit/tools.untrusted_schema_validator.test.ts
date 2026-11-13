import { describe, expect, it, vi } from 'vitest';

import { SchemaTooLargeError } from '../../src/errors.js';
import { compileUntrustedSchema, MAX_UNTRUSTED_VALIDATOR_CODE_BYTES } from '../../src/tools/actor_input_schema.js';
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

    it.each([
        [
            'a long property name',
            { type: 'object', properties: { ['settings'.padEnd(20_000, 'x')]: { properties: groupOfFlags } } },
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

    it('throws SchemaTooLargeError when the generated code is over the limit', () => {
        addValidatorCodeOnce(MAX_UNTRUSTED_VALIDATOR_CODE_BYTES);

        expect(() => compileUntrustedSchema(schemaFor('apify/web-scraper'))).toThrow(SchemaTooLargeError);
    });

    it('checks that the validator runs from a deeper call stack than its own', () => {
        const countStackFrames = (): number => {
            const holder: { stack?: string } = {};
            const { stackTraceLimit } = Error;
            Error.stackTraceLimit = Infinity;
            Error.captureStackTrace(holder);
            Error.stackTraceLimit = stackTraceLimit;
            return holder.stack?.split('\n').length ?? 0;
        };
        const framesAtValidation: number[] = [];
        vi.mocked(createAjv).mockImplementationOnce((checkCode) =>
            createRealAjv(checkCode).addKeyword({
                keyword: 'stackFrames',
                validate: () => framesAtValidation.push(countStackFrames()) > 0,
            }),
        );

        const { validate } = compileUntrustedSchema({ ...schemaFor('apify/cheerio-scraper'), stackFrames: true });
        validate({});

        const [framesAtCheck, framesAtCall] = framesAtValidation;
        // Room for the engine to compile the validator again later, from a call deeper than this one.
        expect(framesAtCheck - framesAtCall).toBeGreaterThanOrEqual(200);
    });

    it('does not remember that a validator could not run: the answer depends on the engine and the call stack', () => {
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
});
