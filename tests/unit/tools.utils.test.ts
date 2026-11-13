import { describe, expect, it } from 'vitest';

import {
    ACTOR_ENUM_MAX_LENGTH,
    ACTOR_MAX_DESCRIPTION_LENGTH,
    RESOURCE_ID_OR_NAME_MAX_LENGTH,
} from '../../src/const.js';
import { SchemaTooLargeError } from '../../src/errors.js';
import {
    buildActorInputSchema,
    buildApifySpecificProperties,
    decodeDotPropertyNames,
    encodeDotPropertyNames,
    compileUntrustedSchema,
    inferArrayItemsTypeIfMissing,
    inferArrayItemType,
    MAX_UNTRUSTED_ENUM_VALUES,
    MAX_UNTRUSTED_SAME_VALUE_SCHEMAS,
    MAX_UNTRUSTED_SCHEMA_BYTES,
    MAX_UNTRUSTED_SUBSCHEMA_DEPTH,
    MAX_UNTRUSTED_VALIDATOR_NESTING,
    markInputPropertiesAsRequired,
    shortenProperties,
    transformActorInputSchemaProperties,
} from '../../src/tools/actor_input_schema.js';
import { isActorBlockedUnderPaymentProvider } from '../../src/tools/actor_tool_naming.js';
import { callActor } from '../../src/tools/actors/call_actor.js';
import { callActorMcpTool } from '../../src/tools/actors/call_actor_mcp_tool.js';
import { fetchActorDetails } from '../../src/tools/actors/fetch_actor_details.js';
import { fetchActorMcpToolList } from '../../src/tools/actors/fetch_actor_mcp_tool_list.js';
import { sendServerActorRequest } from '../../src/tools/actors/send_server_actor_request.js';
import type { ActorInputSchema, SchemaProperties, ToolBase, ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import {
    extractActorInterface,
    extractActorName,
    getToolFullName,
    getToolPublicFieldOnly,
} from '../../src/utils/tools.js';

describe('compileUntrustedSchema', () => {
    /** The limit a schema is refused for, read from the message of its SchemaTooLargeError. */
    const getRefusedLimit = (schema: object): string | undefined => {
        try {
            compileUntrustedSchema(schema);
        } catch (error) {
            if (error instanceof SchemaTooLargeError) return error.message.replace(/^.* \d+ /, '');
            throw error;
        }
        return undefined;
    };

    it('applies the server validation policy: strips unknown properties and ignores `pattern`', () => {
        const { validate } = compileUntrustedSchema({
            type: 'object',
            properties: { url: { type: 'string', pattern: '^(a+)+$' } },
            additionalProperties: false,
        });
        const input = { url: 'https://example.com', extra: 1 };
        expect(validate(input)).toBe(true);
        expect(input).toEqual({ url: 'https://example.com' });
    });

    it('caches validator for identical schemas', () => {
        const schema = () => ({ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] });
        const first = compileUntrustedSchema(schema());
        expect(compileUntrustedSchema(schema())).toBe(first);
        expect(compileUntrustedSchema({ ...schema(), required: [] })).not.toBe(first);
    });

    it('generates identical validator source for equivalent rules on separate cache misses', () => {
        const schema = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };
        const { validate: first } = compileUntrustedSchema({ ...schema, description: 'First Actor input' });
        const { validate: second } = compileUntrustedSchema({ ...schema, description: 'Second Actor input' });

        expect(second).not.toBe(first);
        // V8 retains distinct generated source; a reused Ajv changes its scope names on every compile.
        expect(second.toString()).toBe(first.toString());
    });

    it('throws SchemaTooLargeError on an oversized schema before AJV codegen runs (DoS guard)', () => {
        const properties: Record<string, unknown> = {};
        for (let i = 0; i < 16000; i++) properties[`p${i}`] = { type: 'string' };
        const huge = { type: 'object', properties };
        expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_UNTRUSTED_SCHEMA_BYTES);
        expect(getRefusedLimit(huge)).toBe('bytes');
    });

    const schemaWithProperties = (count: number, property: unknown = { type: 'string' }) => ({
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, property])),
    });
    const schemaWithGroups = (groups: number, propertiesInGroup: number, property?: unknown) => ({
        type: 'object',
        properties: Object.fromEntries(
            Array.from({ length: groups }, (_, index) => [
                `group${index}`,
                schemaWithProperties(propertiesInGroup, property),
            ]),
        ),
    });

    describe('the nesting of the validator code', () => {
        // The nesting of an object with N typed properties is estimated at N blocks and a few more around them.
        const NESTING_AROUND_PROPERTIES = 10;

        it('compiles a schema with more properties than any public Actor has, and its validator runs', () => {
            const { validate } = compileUntrustedSchema(schemaWithProperties(600));
            expect(validate({ field0: 'https://example.com', field599: 'https://example.com' })).toBe(true);
            expect(validate({ field599: {} })).toBe(false);
        });

        it('compiles a validator that nests as deep as the limit, and throws SchemaTooLargeError one deeper', () => {
            const widest = MAX_UNTRUSTED_VALIDATOR_NESTING - NESTING_AROUND_PROPERTIES;
            const { validate } = compileUntrustedSchema(schemaWithProperties(widest));
            expect(validate({ [`field${widest - 1}`]: 'https://example.com' })).toBe(true);
            expect(validate({ [`field${widest - 1}`]: {} })).toBe(false);
            expect(getRefusedLimit(schemaWithProperties(widest + 1))).toBe('nested blocks of validator code');
        });

        it('applies the limit to the validator of a referenced schema', () => {
            // A schema that refers to itself gets a validator function of its own.
            const category = {
                ...schemaWithProperties(MAX_UNTRUSTED_VALIDATOR_NESTING),
                additionalProperties: { $ref: '#/$defs/category' },
            };
            const schema = {
                type: 'object',
                properties: { category: { $ref: '#/$defs/category' } },
                $defs: { category },
            };
            expect(getRefusedLimit(schema)).toBe('nested blocks of validator code');
        });

        it('does not read a bracket inside a property name as nesting', () => {
            const schema = schemaWithProperties(600);
            const { validate } = compileUntrustedSchema({
                ...schema,
                properties: { ...schema.properties, [`${'{(['.repeat(300)}"\\`]: { type: 'string' } },
            });
            expect(validate({ field0: 1 })).toBe(true);
        });
    });

    const schemaWithNestedLevels = (levels: number) => {
        let schema: object = { type: 'string' };
        for (let level = 0; level < levels; level++) schema = { type: 'object', properties: { child: schema } };
        return schema;
    };

    it('compiles a schema nested as deep as the limit, and throws SchemaTooLargeError one level deeper', () => {
        const { validate } = compileUntrustedSchema(schemaWithNestedLevels(MAX_UNTRUSTED_SUBSCHEMA_DEPTH));
        expect(validate({ child: { child: {} } })).toBe(true);
        expect(getRefusedLimit(schemaWithNestedLevels(MAX_UNTRUSTED_SUBSCHEMA_DEPTH + 1))).toBe('nested levels');
    });

    describe('the estimate of the validator code', () => {
        const TOO_LARGE = 'bytes of validator code';

        it('compiles a schema twice the size of the largest public Actor input schema', () => {
            const { validate } = compileUntrustedSchema(schemaWithGroups(4, 400));
            expect(validate({ group0: { field0: 'https://example.com' } })).toBe(true);
            expect(validate({ group3: { field399: {} } })).toBe(false);
        });

        it('throws SchemaTooLargeError on a schema with too many keywords to check', () => {
            expect(getRefusedLimit(schemaWithGroups(12, 700))).toBe(TOO_LARGE);
        });

        it('counts every keyword of a subschema', () => {
            const limits = {
                minLength: 1,
                maxLength: 9,
                minimum: 0,
                maximum: 9,
                multipleOf: 1,
                minItems: 1,
                maxItems: 2,
            };
            expect(getRefusedLimit(schemaWithGroups(4, 500))).toBeUndefined();
            expect(getRefusedLimit(schemaWithGroups(4, 500, { type: 'string', ...limits }))).toBe(TOO_LARGE);
        });

        it('counts the names of a property list and the types of a type list', () => {
            const names = Array.from({ length: 110 }, (_, index) => `n${index}`);
            expect(getRefusedLimit(schemaWithProperties(300, { required: names.slice(0, 10) }))).toBeUndefined();
            expect(getRefusedLimit(schemaWithProperties(300, { required: names }))).toBe(TOO_LARGE);
            expect(getRefusedLimit(schemaWithProperties(300, { dependencies: { n0: names } }))).toBe(TOO_LARGE);
            const types = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];
            expect(getRefusedLimit(schemaWithGroups(4, 700, { type: types.slice(0, 2) }))).toBeUndefined();
            expect(getRefusedLimit(schemaWithGroups(4, 700, { type: types }))).toBe(TOO_LARGE);
        });

        it('counts a long list of names for more than its length', () => {
            const dependentOn = (count: number) => ({
                dependencies: { url: Array.from({ length: count }, (_, index) => `n${index}`) },
            });
            // The same 5,600 names in all.
            expect(getRefusedLimit(schemaWithProperties(56, dependentOn(100)))).toBeUndefined();
            expect(getRefusedLimit(schemaWithProperties(8, dependentOn(700)))).toBe(TOO_LARGE);
        });

        it('counts the pairs of values Ajv compares in every enum', () => {
            const countries = (prefix: string) =>
                Array.from({ length: MAX_UNTRUSTED_ENUM_VALUES }, (_, index) => `${prefix}${index}`);
            const schema = {
                type: 'object',
                properties: { from: { enum: countries('F') }, to: { enum: countries('T') } },
            };
            expect(getRefusedLimit(schema)).toBe(TOO_LARGE);
        });

        it('counts the names on the way to a subschema for each of its keywords', () => {
            const groupName = (length: number) => 'group'.padEnd(length, 'x');
            const schema = (length: number) => ({
                type: 'object',
                properties: { [groupName(length)]: schemaWithProperties(700, false) },
            });
            const { validate } = compileUntrustedSchema(schema(60));
            expect(validate({ [groupName(60)]: {} })).toBe(true);
            expect(validate({ [groupName(60)]: { field0: 1 } })).toBe(false);
            expect(getRefusedLimit(schema(20_000))).toBe(TOO_LARGE);
        });

        it('counts a name as long as Ajv writes it', () => {
            // A control character takes six characters in the generated code.
            const schema = (name: string) => ({
                type: 'object',
                properties: { [name]: schemaWithProperties(700, false) },
            });
            expect(getRefusedLimit(schema('x'.repeat(2500)))).toBeUndefined();
            expect(getRefusedLimit(schema('\u0001'.repeat(2500)))).toBe(TOO_LARGE);
        });

        it('counts the reference a copied schema is reported under', () => {
            const definitionName = 'address'.padEnd(20_000, 'x');
            const schema = {
                type: 'object',
                properties: { home: { $ref: `#/$defs/${definitionName}` } },
                $defs: { [definitionName]: schemaWithProperties(700, false) },
            };
            expect(getRefusedLimit(schema)).toBe(TOO_LARGE);
        });

        it.each(['items', 'anyOf'])('counts the members of an `%s` list', (keyword) => {
            const codes = Array.from({ length: 30 }, (_, index) => `code${index}`);
            const members = (count: number) =>
                Array.from({ length: count }, () => ({ type: 'string', minLength: 1, maxLength: 9, enum: codes }));
            expect(compileUntrustedSchema({ [keyword]: members(100) })).toBeDefined();
            expect(getRefusedLimit({ [keyword]: members(700) })).toBe(TOO_LARGE);
        });

        it('does not count objects inside default, prefill, enum, examples and const values', () => {
            const records = Array.from({ length: 1300 }, (_, index) => ({
                type: 'string',
                minLength: 1,
                maxLength: 9,
                id: index,
            }));
            // Keyed records: an object under a keyword that is not a data keyword would be read as a subschema.
            const recordsById = Object.fromEntries(records.map((record) => [`r${record.id}`, record]));
            const { validate } = compileUntrustedSchema({
                type: 'object',
                properties: {
                    startUrls: { type: 'array', default: recordsById, prefill: recordsById },
                    mode: { enum: records.slice(0, 50), const: recordsById, example: recordsById.r0, examples: [] },
                },
            });
            expect(validate({ startUrls: [] })).toBe(true);
        });

        it('counts the schema of a property that is named like a data keyword', () => {
            const schema = { type: 'object', properties: { default: schemaWithGroups(12, 700) } };
            expect(getRefusedLimit(schema)).toBe(TOO_LARGE);
        });

        it('does not count a keyword that Ajv generates no code for', () => {
            const described = {
                title: 'F',
                description: 'D',
                editor: 'e',
                sectionCaption: 'S',
                isSecret: false,
                unit: 'u',
            };
            const { validate } = compileUntrustedSchema(schemaWithGroups(4, 600, described));
            expect(validate({ group0: { field0: 1 } })).toBe(true);
        });
    });

    describe('schemas with `$ref`', () => {
        const TOO_LARGE = 'bytes of validator code';
        const address = schemaWithProperties(100);
        const schemaWithReferences = (count: number, reference: string, definitions: Record<string, unknown>) => ({
            type: 'object',
            properties: Object.fromEntries(
                Array.from({ length: count }, (_, index) => [`address${index}`, { $ref: reference }]),
            ),
            $defs: definitions,
        });

        it('counts a referenced schema at every reference it is copied into', () => {
            const { validate } = compileUntrustedSchema(schemaWithReferences(10, '#/$defs/address', { address }));
            expect(validate({ address9: { field0: 'Prague' } })).toBe(true);
            expect(validate({ address9: { field0: {} } })).toBe(false);
            expect(getRefusedLimit(schemaWithReferences(70, '#/$defs/address', { address }))).toBe(TOO_LARGE);
        });

        it('counts the bytes of a referenced schema at every reference it is copied into', () => {
            const country = { type: 'string', description: 'x'.repeat(MAX_UNTRUSTED_SCHEMA_BYTES / 20) };
            expect(compileUntrustedSchema(schemaWithReferences(10, '#/$defs/country', { country }))).toBeDefined();
            expect(getRefusedLimit(schemaWithReferences(30, '#/$defs/country', { country }))).toBe('bytes');
        });

        it('counts a schema that refers to itself once, however often it is referenced', () => {
            const category = { ...schemaWithProperties(500), additionalProperties: { $ref: '#/$defs/category' } };
            const { validate } = compileUntrustedSchema(schemaWithReferences(30, '#/$defs/category', { category }));
            expect(validate({ address0: { field0: 'Books', sub: { field0: 'Novels' } } })).toBe(true);
            expect(validate({ address0: { sub: { field0: {} } } })).toBe(false);
        });

        it('counts a schema that refers to itself again for another spelling of the reference', () => {
            const category = { ...schemaWithProperties(700), additionalProperties: { $ref: '#/$defs/category' } };
            const schema = schemaWithReferences(30, '#/$defs/category', { category });
            expect(compileUntrustedSchema(schema)).toBeDefined();
            // `category` with one of its letters written as a percent escape.
            const references = Array.from('category', (letter, index) => {
                const escaped = `%${letter.charCodeAt(0).toString(16)}`;
                return `#/$defs/${'category'.slice(0, index)}${escaped}${'category'.slice(index + 1)}`;
            });
            expect(getRefusedLimit({ ...schema, anyOf: references.map((reference) => ({ $ref: reference })) })).toBe(
                TOO_LARGE,
            );
        });

        it('does not count a definition that nothing refers to', () => {
            const { validate } = compileUntrustedSchema({
                type: 'object',
                properties: { url: { type: 'string' } },
                $defs: schemaWithProperties(8000).properties,
            });
            expect(validate({ url: 'https://example.com' })).toBe(true);
        });

        it('follows a reference to a schema that is only a reference', () => {
            const definitions = { address, alias: { $ref: '#/$defs/address' } };
            expect(getRefusedLimit(schemaWithReferences(70, '#/$defs/alias', definitions))).toBe(TOO_LARGE);
        });

        it('counts a schema that refers to itself again for each schema that is only a reference to it', () => {
            const category = { ...schemaWithProperties(700), additionalProperties: { $ref: '#/$defs/category' } };
            const aliases = Object.fromEntries(
                Array.from({ length: 9 }, (_, index) => [`alias${index}`, { $ref: '#/$defs/category' }]),
            );
            const schema = schemaWithReferences(1, '#/$defs/alias0', { category, ...aliases });
            expect(compileUntrustedSchema(schema)).toBeDefined();
            const others = Object.keys(aliases).map((alias) => ({
                properties: { other: { $ref: `#/$defs/${alias}` } },
            }));
            expect(getRefusedLimit({ ...schema, anyOf: others })).toBe(TOO_LARGE);
        });

        it('reads the escaped characters of a reference', () => {
            const definitions = { 'postal/address list': address };
            expect(getRefusedLimit(schemaWithReferences(70, '#/$defs/postal~1address%20list', definitions))).toBe(
                TOO_LARGE,
            );
        });

        it('leaves a reference that is not a valid URI fragment to Ajv', () => {
            const schema = schemaWithReferences(1, '#/$defs/100%', { '100%': address });
            // The message is Ajv's own.
            expect(() => compileUntrustedSchema(schema)).toThrow(/percent-encoding/);
        });

        it('applies the worst case to a reference with a second number sign', () => {
            // Ajv drops the trailing sign and compiles `address`.
            const definitions = { 'address#': { type: 'string' }, address };
            expect(getRefusedLimit(schemaWithReferences(30, '#/$defs/address#', definitions))).toBe(TOO_LARGE);
        });

        it('does not count the whole schema for a reference to it', () => {
            const schema = schemaWithReferences(30, '#', {});
            const { validate } = compileUntrustedSchema({
                ...schema,
                properties: { ...schema.properties, ...schemaWithProperties(600).properties },
            });
            expect(validate({ address0: { address1: { field0: 'Prague' } } })).toBe(true);
            expect(validate({ address0: { address1: { field0: {} } } })).toBe(false);
        });

        it('applies the worst case when it cannot tell where a reference points', () => {
            // A nested `$id` can change what any reference points to.
            const definitions = (properties: number) => ({
                address: { $id: 'address', ...schemaWithProperties(properties) },
            });
            const { validate } = compileUntrustedSchema(schemaWithReferences(2, 'address', definitions(3)));
            expect(validate({ address0: { field0: 'Prague' } })).toBe(true);
            expect(validate({ address0: { field0: {} } })).toBe(false);
            expect(getRefusedLimit(schemaWithReferences(10, '#/$defs/address', definitions(100)))).toBe(TOO_LARGE);
            // Not a `#/...` pointer.
            const anchored = { address: { $anchor: 'address', ...address } };
            expect(getRefusedLimit(schemaWithReferences(10, '#address', anchored))).toBe(TOO_LARGE);
            // Few bytes and many subschemas.
            const flagged = { address: { $id: 'address', ...schemaWithProperties(600, false) } };
            expect(getRefusedLimit(schemaWithReferences(3, 'address', flagged))).toBe(TOO_LARGE);
            // Many bytes and few subschemas: every reference can copy the schema in again.
            const described = (bytes: number) => ({
                address: { $id: 'address', type: 'string', description: 'x'.repeat(bytes) },
            });
            expect(compileUntrustedSchema(schemaWithReferences(1, 'address', described(1000)))).toBeDefined();
            expect(getRefusedLimit(schemaWithReferences(1, 'address', described(MAX_UNTRUSTED_SCHEMA_BYTES / 3)))).toBe(
                'bytes',
            );
        });

        it('leaves the references of a schema with a nested `$id` to Ajv', () => {
            // Inside `address` the reference points to its own definition, not to the one of the whole schema.
            const { validate } = compileUntrustedSchema({
                type: 'object',
                properties: {
                    address: {
                        $id: 'https://example.com/address.json',
                        allOf: [{ $ref: '#/definitions/city' }],
                        definitions: { city: { type: 'object', properties: { name: { type: 'string' } } } },
                    },
                },
                definitions: { city: { allOf: [{ $ref: '#/definitions/city' }] } },
            });
            expect(validate({ address: { name: 'Prague' } })).toBe(true);
            expect(validate({ address: { name: {} } })).toBe(false);
        });

        it('ignores references inside data values', () => {
            const apiDescription = {
                $id: 'https://example.com/api.json',
                paths: Array.from({ length: 50 }, () => ({ schema: { $ref: 'components.json#/schemas/User' } })),
            };
            const { validate } = compileUntrustedSchema({
                type: 'object',
                properties: { specification: { type: 'object', prefill: apiDescription, default: apiDescription } },
            });
            expect(validate({ specification: {} })).toBe(true);
        });

        describe('that are applied to one and the same value', () => {
            const LOOP = /leads back to itself/;

            it('compiles a schema that refers to itself for a property or for the items of an array', () => {
                const category = {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        parent: { $ref: '#/$defs/category' },
                        children: { type: 'array', items: { anyOf: [{ $ref: '#/$defs/category' }, { type: 'null' }] } },
                    },
                    additionalProperties: { allOf: [{ $ref: '#' }] },
                };
                const { validate } = compileUntrustedSchema({ $ref: '#/$defs/category', $defs: { category } });
                expect(
                    validate({ name: 'Books', children: [{ name: 'Novels', parent: { name: 'Books' } }, null] }),
                ).toBe(true);
                expect(validate({ children: [{ children: [{ name: {} }] }] })).toBe(false);
                expect(validate({ other: { name: {} } })).toBe(false);
            });

            it('throws on a definition that is a combination of itself', () => {
                const loop = { allOf: [{ type: 'object' }, { $ref: '#/$defs/loop' }] };
                const schema = { type: 'object', properties: { value: { $ref: '#/$defs/loop' } }, $defs: { loop } };
                expect(() => compileUntrustedSchema(schema)).toThrow(LOOP);
                expect(() => compileUntrustedSchema(schema)).not.toThrow(SchemaTooLargeError);
            });

            it.each([
                ['anyOf', { anyOf: [{ type: 'null' }, { $ref: '#/$defs/second' }] }],
                ['oneOf', { oneOf: [{ $ref: '#/$defs/second' }] }],
                ['not', { not: { $ref: '#/$defs/second' } }],
                ['if', { if: { $ref: '#/$defs/second' } }],
                ['then', { if: { type: 'object' }, then: { $ref: '#/$defs/second' } }],
                ['else', { if: { type: 'object' }, else: { $ref: '#/$defs/second' } }],
                ['dependencies', { dependencies: { name: { $ref: '#/$defs/second' } } }],
                ['a reference with other keywords', { type: 'object', $ref: '#/$defs/second' }],
            ])('throws on two definitions that lead to each other through %s', (_keyword, first) => {
                const definitions = { first, second: { allOf: [{ $ref: '#/$defs/first' }] } };
                const schema = { type: 'object', properties: { value: { $ref: '#/$defs/first' } }, $defs: definitions };
                expect(() => compileUntrustedSchema(schema)).toThrow(LOOP);
            });

            it('throws on a schema that is a combination of itself', () => {
                expect(() => compileUntrustedSchema({ type: 'object', allOf: [{ $ref: '#' }] })).toThrow(LOOP);
            });

            it('compiles a value checked against as many referenced schemas as the limit, and throws on more', () => {
                // Each level checks its value against the level below it `width` times.
                const levels = (width: number, count: number) => {
                    const definitions: Record<string, unknown> = {
                        level0: { type: 'object', additionalProperties: { $ref: '#' } },
                    };
                    for (let level = 1; level <= count; level++) {
                        const below = { $ref: `#/$defs/level${level - 1}` };
                        definitions[`level${level}`] = { allOf: Array.from({ length: width }, () => below) };
                    }
                    return { $ref: `#/$defs/level${count}`, $defs: definitions };
                };
                // 1 + 10 + 100 + 1000 referenced schemas, less the first one, is over the limit by 110.
                expect(MAX_UNTRUSTED_SAME_VALUE_SCHEMAS).toBe(1000);
                const { validate } = compileUntrustedSchema(levels(9, 3));
                expect(validate({ other: {} })).toBe(true);
                expect(validate([])).toBe(false);
                expect(getRefusedLimit(levels(10, 3))).toBe('referenced schemas for one value');
                expect(getRefusedLimit(levels(2, 12))).toBe('referenced schemas for one value');
            });
        });
    });

    const schemaWithEnumValues = (count: number) => ({
        type: 'object',
        properties: { country: { type: 'string', enum: Array.from({ length: count }, (_, index) => `C${index}`) } },
    });

    it('compiles an enum with as many values as the limit', () => {
        const { validate } = compileUntrustedSchema(schemaWithEnumValues(MAX_UNTRUSTED_ENUM_VALUES));
        expect(validate({ country: 'C0' })).toBe(true);
        expect(validate({ country: 'unknown' })).toBe(false);
    });

    it('throws SchemaTooLargeError on an enum with more values than the limit', () => {
        expect(getRefusedLimit(schemaWithEnumValues(MAX_UNTRUSTED_ENUM_VALUES + 1))).toBe('enum values');
    });

    it('applies the enum limit inside a definition that nothing refers to', () => {
        const { country } = schemaWithEnumValues(MAX_UNTRUSTED_ENUM_VALUES + 1).properties;
        expect(getRefusedLimit({ type: 'object', definitions: { country } })).toBe('enum values');
    });

    it('remembers a schema that fails to compile', () => {
        const schema = () => ({ type: 'object', properties: { url: { $ref: '#/definitions/missing' } } });
        const compileError = () => {
            try {
                compileUntrustedSchema(schema());
            } catch (error) {
                return error;
            }
            return undefined;
        };

        const firstError = compileError();
        expect(firstError).toBeInstanceOf(Error);
        // The same error object means the second call did not compile again.
        expect(compileError()).toBe(firstError);
    });
});

describe('buildApifySpecificProperties', () => {
    it('adds resource picker structure to array items with editor resourcePicker', () => {
        const properties: Record<string, SchemaProperties> = {
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

        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('adds key and value structure to array items with editor keyValue', () => {
        const properties: Record<string, SchemaProperties> = {
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

        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('adds globs structure to array items with editor globs', () => {
        const properties: Record<string, SchemaProperties> = {
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

        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('adds pseudoUrls structure to array items with items.editor pseudoUrls', () => {
        const properties: Record<string, SchemaProperties> = {
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

        expect(result.otherProp).toEqual(properties.otherProp);
    });
    it('adds useApifyProxy, apifyProxyGroups, and proxyUrls properties to proxy objects', () => {
        const properties: Record<string, SchemaProperties> = {
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
        expect(result.proxy.properties?.apifyProxyGroups.items?.enum).toEqual(['RESIDENTIAL', 'DATACENTER']);

        // Check that proxy object has proxyUrls property
        expect(result.proxy.properties?.proxyUrls).toBeDefined();
        expect(result.proxy.properties?.proxyUrls.type).toBe('array');
        expect(result.proxy.properties?.proxyUrls.items).toBeDefined();
        expect(result.proxy.properties?.proxyUrls.items?.type).toBe('string');

        expect(result.otherProp).toEqual(properties.otherProp);
    });

    it('adds URL structure to requestListSources array items', () => {
        const properties: Record<string, SchemaProperties> = {
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

        expect(result.otherProp).toEqual(properties.otherProp);
    });

    it("does not modify properties that don't match special cases", () => {
        const properties: Record<string, SchemaProperties> = {
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

    it('handles empty properties object', () => {
        const properties: Record<string, SchemaProperties> = {};
        const result = buildApifySpecificProperties(properties);
        expect(result).toEqual({});
    });
});

describe('markInputPropertiesAsRequired', () => {
    it('adds REQUIRED prefix to required properties', () => {
        const input: ActorInputSchema = {
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

    it('handles input without required fields', () => {
        const input: ActorInputSchema = {
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

    it('handles empty required array', () => {
        const input: ActorInputSchema = {
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
    it('truncates long descriptions', () => {
        const longDescription = 'a'.repeat(ACTOR_MAX_DESCRIPTION_LENGTH + 100);
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: longDescription,
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1.description.endsWith('…\n\n[Description truncated]')).toBe(true);
    });

    it('keeps the last complete sentence before a partial URL', () => {
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: `Complete sentence. ${'https://example.com/path?query=value'.repeat(20)}`,
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1.description).toBe('Complete sentence.\n\n[Description truncated]');
    });

    it('keeps a complete last word when the overflow is the next word', () => {
        const description = `${'x'.repeat(494)} hello more`;
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description,
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1.description).toContain('hello');
        expect(result.prop1.description).not.toContain('more');
        expect(result.prop1.description.endsWith('…\n\n[Description truncated]')).toBe(true);
    });

    it('keeps a sentence that ends at the exact cap', () => {
        const description = `${'x'.repeat(ACTOR_MAX_DESCRIPTION_LENGTH - 1)}. more text that exceeds the cap`;
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description,
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1.description).toBe(
            `${'x'.repeat(ACTOR_MAX_DESCRIPTION_LENGTH - 1)}.\n\n[Description truncated]`,
        );
    });

    it('does not modify descriptions that are within limits', () => {
        const description = 'This is a normal description';
        const properties: Record<string, SchemaProperties> = {
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

    it('keeps the enum in full, with no note, when every value fits under the cap', () => {
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: 'Property with enum',
                enum: ['a', '', 'b', 'c'],
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1.enum).toEqual(['a', 'b', 'c']);
        expect(result.prop1.description).toBe('Property with enum');
    });

    it('deletes an all-blank enum without adding a dropped-enum note', () => {
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: 'Property with blank enum',
                enum: ['', ''],
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1).not.toHaveProperty('enum');
        expect(result.prop1.description).toBe('Property with blank enum');
    });

    it('drops the enum entirely (not partially) when the values don\u2019t fit the cap as a whole, noting a few examples', () => {
        // Create an enum with many values to exceed the character limit
        const value = 'enum-value-';
        const description =
            'You can limit the places that are scraped based on the Category filter; you can choose as many categories ' +
            'for one flat fee for the whole field. ⚠️ Using categories can sometimes lead to false negatives, as many ' +
            "places do not properly categorize themselves, and there are over <a href='https://api.apify.com/v2/" +
            "key-value-stores/epxZwNRgmnzzBpNJd/records/categories'> 4,000</a> available categories which Google Maps " +
            'has. Using categories might filter out places that you’d like to scrape. To avoid this problem, use categories carefully.';
        const enumValues = Array.from(
            { length: Math.ceil(ACTOR_ENUM_MAX_LENGTH / value.length) + 1 },
            (_, i) => `${value}${i}`,
        );
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description,
                enum: enumValues,
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1).not.toHaveProperty('enum');
        expect(result.prop1.description).toContain(
            `scrape.\n\n[Description truncated]\n\nThe complete list of accepted values is too long to include. Examples: ${enumValues[0]}`,
        );
        expect(result.prop1.description).toContain(`Examples: ${enumValues.slice(0, 10).join(', ')}.`);
        expect(result.prop1.description).not.toContain(enumValues[10]);
        expect(result.prop1.description).not.toContain('To avoid');
    });

    it('only shows complete accepted values as examples when dropping an enum', () => {
        const longValue = 'a'.repeat(61);
        const enumValues = Array.from({ length: 40 }, (_, i) => `${longValue}${i}`);
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'string',
                title: 'Property 1',
                description: 'Property with enum',
                enum: enumValues,
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1).not.toHaveProperty('enum');
        expect(result.prop1.description).toContain('The complete list of accepted values is too long to include.');
        expect(result.prop1.description).not.toContain('Examples:');
    });

    it('keeps items.enum in full, with no note, when every value fits under the cap', () => {
        const properties: Record<string, SchemaProperties> = {
            prop1: {
                type: 'array',
                title: 'Property 1',
                description: 'Property with items.enum',
                items: {
                    type: 'string',
                    title: 'Item',
                    description: 'Item description',
                    enum: ['a', 'b', 'c'],
                },
            },
        };

        const result = shortenProperties(properties);

        expect(result.prop1.items?.enum).toEqual(['a', 'b', 'c']);
        expect(result.prop1.description).toBe('Property with items.enum');
    });

    it('drops items.enum entirely (not partially) when the values don\u2019t fit the cap as a whole, noting a few examples', () => {
        // Create an enum with many values to exceed the character limit
        const value = 'enum-value-';
        const enumValues = Array.from(
            { length: Math.ceil(ACTOR_ENUM_MAX_LENGTH / value.length) + 1 },
            (_, i) => `${value}${i}`,
        );
        const properties: Record<string, SchemaProperties> = {
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

        expect(result.prop1.items).not.toHaveProperty('enum');
        expect(result.prop1.description).toContain('The complete list of accepted values is too long to include.');
        expect(result.prop1.description).toContain(enumValues[0]);
    });

    it('handles properties without enum or items.enum', () => {
        const properties: Record<string, SchemaProperties> = {
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

    it('handles empty enum arrays', () => {
        const properties: Record<string, SchemaProperties> = {
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
    it('replaces dots in property names with -dot-', () => {
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

    it('does not modify property names without dots', () => {
        const input = {
            foo: { type: 'string', title: 'Foo', description: 'desc' },
            bar: { type: 'number', title: 'Bar', description: 'desc2' },
        };
        const result = encodeDotPropertyNames(input);
        expect(result).toEqual(input);
    });
});

describe('decodeDotPropertyNames', () => {
    it('replaces -dot- in property names with dots', () => {
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

    it('does not modify property names without -dot-', () => {
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
    it('correctly transforms a schema with all Apify-specific types and features', () => {
        const input: ActorInputSchema = {
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

        // Enum String — kept in full (fits the cap); no "Possible values" duplication with `enum`.
        expect(result.enumString).toBeDefined();
        expect(result.enumString.enum).toEqual(['A', 'B', 'C']);
        expect(result.enumString.description).not.toContain('Possible values:');
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
    it('applies all transformations in the correct order', () => {
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
        // 'foo.bar' upstream only declares title/description/type — no default, prefill, enum, etc.
        expect(Object.keys(result['foo-dot-bar']).sort()).toEqual(['description', 'title', 'type']);
        // 4. shortenProperties: longDesc is truncated and the fitting enum stays whole.
        expect(result.longDesc.description.endsWith('…\n\n[Description truncated]')).toBe(true);
        expect(result.enumProp.enum).toEqual(input.properties.enumProp.enum);
        // 5. Enum fits the cap (30 short values) — kept in full, no "Possible values" duplication.
        expect(result.enumProp.description).not.toMatch(/Possible values:/);
        // 6. encodeDotPropertyNames: foo.bar becomes foo-dot-bar
        expect(result['foo-dot-bar']).toBeDefined();
        expect(result['foo.bar']).toBeUndefined();
    });

    it('handles input with no required, no enums, no dots', () => {
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

    it('encodes all dotted property names', () => {
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

    it('does not mutate the input object', () => {
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

    it('builds array items property correctly for stringList editor with place IDs', () => {
        const input: ActorInputSchema = {
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
        const property: SchemaProperties = {
            title: 'Place IDs',
            type: 'array',
            description: 'List of place IDs.',
            editor: 'stringList',
        };

        expect(inferArrayItemType(property)).toBe('string');
    });
});

describe('inferArrayItemsTypeIfMissing', () => {
    it('infers and sets items type for array property with stringList editor', () => {
        const properties: { [key: string]: SchemaProperties } = {
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

    it('does not modify array properties that already have items.type defined', () => {
        const properties: { [key: string]: SchemaProperties } = {
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

describe('getToolFullName', () => {
    it('returns actorFullName for actor tools', () => {
        const tool = {
            type: TOOL_TYPE.ACTOR,
            name: 'actor-web-scraper-by-apify',
            actorFullName: 'apify/web-scraper',
        } as unknown as ToolEntry;
        expect(getToolFullName(tool)).toBe('apify/web-scraper');
    });

    it('returns name for internal tools', () => {
        const tool = { type: TOOL_TYPE.INTERNAL, name: 'store-search' } as unknown as ToolEntry;
        expect(getToolFullName(tool)).toBe('store-search');
    });

    it('returns name for actor-mcp tools', () => {
        const tool = {
            type: TOOL_TYPE.ACTOR_MCP,
            name: 'mcp-tool-search',
            actorId: 'apify/example-mcp-server',
        } as unknown as ToolEntry;
        expect(getToolFullName(tool)).toBe('mcp-tool-search');
    });
});

describe('extractActorName', () => {
    it('returns actorFullName for actor tools', () => {
        const tool = { type: TOOL_TYPE.ACTOR, actorFullName: 'apify/web-scraper' } as unknown as ToolEntry;
        expect(extractActorName(tool)).toBe('apify/web-scraper');
    });

    it('returns actorFullName for actor-mcp tools', () => {
        const tool = {
            type: TOOL_TYPE.ACTOR_MCP,
            actorId: 'Iei3c51WbI7eKwgSg',
            actorFullName: 'apify/example-mcp-server',
        } as unknown as ToolEntry;
        expect(extractActorName(tool)).toBe('apify/example-mcp-server');
    });

    it('parses actor name from call-actor args', () => {
        const tool = { type: TOOL_TYPE.INTERNAL, name: 'call-actor' } as unknown as ToolEntry;
        expect(extractActorName(tool, { actor: 'apify/web-scraper' })).toBe('apify/web-scraper');
    });

    it('strips :toolName suffix from call-actor args', () => {
        const tool = { type: TOOL_TYPE.INTERNAL, name: 'call-actor' } as unknown as ToolEntry;
        expect(extractActorName(tool, { actor: 'apify/example-mcp-server:add' })).toBe('apify/example-mcp-server');
    });

    // The args are read before validation.
    it('returns undefined for an actor arg longer than the argument limit', () => {
        const tool = { type: TOOL_TYPE.INTERNAL, name: 'call-actor' } as unknown as ToolEntry;
        expect(extractActorName(tool, { actor: 'a'.repeat(RESOURCE_ID_OR_NAME_MAX_LENGTH + 1) })).toBeUndefined();
    });

    it('returns undefined for internal tools without actor arg', () => {
        const tool = { type: TOOL_TYPE.INTERNAL, name: 'store-search' } as unknown as ToolEntry;
        expect(extractActorName(tool)).toBeUndefined();
    });
});

describe('the Actor interface a tool call goes through', () => {
    it.each([
        ['an Actor run tool', { type: TOOL_TYPE.ACTOR } as unknown as ToolEntry, {}, 'input'],
        ['a proxied MCP tool', { type: TOOL_TYPE.ACTOR_MCP } as unknown as ToolEntry, {}, 'mcp'],
        ["a Server Actor's own tool", { type: TOOL_TYPE.ACTOR_SERVER } as unknown as ToolEntry, {}, 'server'],
        ['call-actor with an Actor', callActor, { actor: 'apify/rag-web-browser' }, 'input'],
        ['call-actor with an MCP tool of an Actor', callActor, { actor: 'apify/example-mcp-server:add' }, 'mcp'],
        ['send-server-actor-request', sendServerActorRequest, { actor: 'apify/web-fetch' }, 'server'],
        ['call-actor-mcp-tool', callActorMcpTool, { actor: 'apify/example-mcp-server' }, 'mcp'],
        ['fetch-actor-mcp-tool-list', fetchActorMcpToolList, { actor: 'apify/example-mcp-server' }, 'mcp'],
        ['a tool that calls no Actor', fetchActorDetails, { actor: 'apify/web-fetch' }, undefined],
    ] as const)('is read for %s', (_label, tool, args, expected) => {
        expect(extractActorInterface(tool, args)).toBe(expected);
    });
});

describe('buildActorInputSchema + getToolPublicFieldOnly pipeline', () => {
    // Regression: #637 — end-to-end check that required fields survive the full pipeline.
    it('keeps `query` in required across the full tools/list pipeline for a rag-web-browser-shaped schema', () => {
        const upstream: ActorInputSchema = {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    title: 'Search term or URL',
                    description: 'Enter Google Search keywords or a URL.',
                    prefill: 'web browser for RAG pipelines',
                },
                maxResults: {
                    type: 'integer',
                    title: 'Maximum results',
                    description: 'Max organic results to return.',
                    default: 3,
                },
            },
            required: ['query'],
        };

        const { inputSchema } = buildActorInputSchema('apify/rag-web-browser', upstream);

        const tool = {
            name: 'apify--rag-web-browser',
            description: 'RAG web browser',
            inputSchema,
        } as ToolBase;

        const pub = getToolPublicFieldOnly(tool);
        const schema = pub.inputSchema as {
            required?: string[];
            properties?: Record<string, { description?: string; prefill?: unknown }>;
        };

        expect(schema.required).toEqual(['query']);
        expect(schema.properties?.query?.description).toMatch(/^\*\*REQUIRED\*\*/);
        expect(schema.properties?.maxResults?.description).not.toMatch(/^\*\*REQUIRED\*\*/);
        expect(schema.properties?.query?.prefill).toBe('web browser for RAG pipelines');
    });

    // Regression: #1513 — a required property with a default was still required by the Actor tool's validator.
    describe('required properties with a default', () => {
        const upstream: ActorInputSchema = {
            type: 'object',
            properties: {
                url: { type: 'string', title: 'URL', description: 'Page URL.' },
                zeroDefault: { type: 'integer', title: 'Delay', description: 'Delay.', default: 0 },
                falseDefault: { type: 'boolean', title: 'Flag', description: 'Flag.', default: false },
                nullDefault: { type: 'string', title: 'Null', description: 'Null.', default: null },
                emptyDefault: { type: 'string', title: 'Empty', description: 'Empty.', default: '' },
                proxy: {
                    type: 'object',
                    title: 'Proxy',
                    description: 'Proxy.',
                    editor: 'proxy',
                    default: { useApifyProxy: true },
                },
                mode: { type: 'string', title: 'Mode', description: 'Mode.', enum: ['a', 'b'], default: 'a' },
                prefillOnly: { type: 'string', title: 'Prefill', description: 'Prefill.', prefill: 'x' },
                undefinedDefault: { type: 'string', title: 'Undef', description: 'Undef.', default: undefined },
                optional: { type: 'string', title: 'Optional', description: 'Optional.' },
                'dotted.default': { type: 'string', title: 'Dotted', description: 'Dotted.', default: 'z' },
            },
            required: [
                'url',
                'zeroDefault',
                'falseDefault',
                'nullDefault',
                'emptyDefault',
                'proxy',
                'mode',
                'prefillOnly',
                'undefinedDefault',
                'dotted.default',
            ],
        };
        const genuinelyRequired = ['url', 'prefillOnly', 'undefinedDefault'];

        it('keeps only properties without a defined default in required and REQUIRED marking', () => {
            const { inputSchema } = buildActorInputSchema('someone/some-actor', upstream);
            const properties = inputSchema.properties as Record<string, SchemaProperties>;

            expect(inputSchema.required).toEqual(genuinelyRequired);
            for (const [name, property] of Object.entries(properties)) {
                expect(property.description.startsWith('**REQUIRED**')).toBe(genuinelyRequired.includes(name));
            }
        });

        it('keeps the RAG Web Browser query required through the builder, tools/list and validator', () => {
            const ragUpstream: ActorInputSchema = {
                type: 'object',
                properties: {
                    query: { type: 'string', title: 'Query', description: 'Search term or URL.', prefill: 'apify' },
                    maxResults: { type: 'integer', title: 'Max', description: 'Max results.', default: 3 },
                    outputFormats: {
                        type: 'array',
                        title: 'Formats',
                        description: 'Formats.',
                        default: ['markdown'],
                    },
                },
                required: ['query', 'maxResults', 'outputFormats'],
            };
            const { inputSchema } = buildActorInputSchema('apify/rag-web-browser', ragUpstream);
            const pub = getToolPublicFieldOnly({
                name: 'apify--rag-web-browser',
                description: '',
                inputSchema,
            } as ToolBase);
            const { validate } = compileUntrustedSchema(inputSchema);

            expect(inputSchema.required).toEqual(['query']);
            expect((pub.inputSchema as { required?: string[] }).required).toEqual(['query']);
            expect(validate({})).toBe(false);
            expect(validate({ query: 'apify' })).toBe(true);
        });
    });

    // An oversized enum is dropped entirely (not partially truncated), one schema for both display and AJV.
    it('drops an oversized enum from the displayed schema entirely, noting examples, and AJV accepts any value it would have cut', () => {
        const droppedValue = 'dropped-value-cut-by-truncation';
        const rawEnum = [
            'kept-0',
            ...Array.from({ length: 300 }, (_, i) => `kept-padding-${i}-${'x'.repeat(20)}`),
            droppedValue,
        ];
        const upstream: ActorInputSchema = {
            type: 'object',
            properties: {
                categoryFilterWords: {
                    type: 'array',
                    title: 'Category',
                    description: 'Category filter words.',
                    items: {
                        type: 'string',
                        title: 'Category',
                        description: 'Category filter word.',
                        enum: rawEnum,
                    },
                },
            },
            required: [],
        };

        const { inputSchema } = buildActorInputSchema('compass/crawler-google-places', upstream);
        const displayProperties = inputSchema.properties as Record<string, SchemaProperties>;

        // No partial/incomplete list shown as if exhaustive.
        expect(displayProperties.categoryFilterWords.items).not.toHaveProperty('enum');
        expect(displayProperties.categoryFilterWords.description).toContain(
            'The complete list of accepted values is too long to include.',
        );
        expect(displayProperties.categoryFilterWords.description).toContain('kept-0');

        // A value that a partial enum would have cut is now accepted; only `type` is enforced.
        const { validate } = compileUntrustedSchema(inputSchema);
        expect(validate({ categoryFilterWords: [droppedValue] })).toBe(true);
    });
});

describe('isActorBlockedUnderPaymentProvider', () => {
    const actor = (standby: boolean) => ({
        actorStandby: standby ? { isEnabled: true } : undefined,
    });

    it('blocks standby Actors', () => {
        expect(isActorBlockedUnderPaymentProvider(actor(true))).toBe(true);
    });

    it('does not block normal Actors', () => {
        expect(isActorBlockedUnderPaymentProvider(actor(false))).toBe(false);
    });
});
