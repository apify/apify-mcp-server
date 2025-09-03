import { describe, expect, it } from 'vitest';

import { generateSchemaFromItems } from '../../src/utils/schema-generation.js';

describe('generateSchemaFromItems', () => {
    it('should generate basic schema from simple objects', () => {
        const items = [{ name: 'John', age: 30 }];
        const result = generateSchemaFromItems(items);
        expect(result).toBeDefined();
        expect(result?.type).toBe('array');
        expect(result?.items).toBeDefined();
        const props = result?.items.properties;
        expect(props).toBeDefined();
        if (props) {
            expect(props.name?.type).toBe('string');
            expect(props.age?.type).toBe('integer');
        }
    });

    it('should handle different data types', () => {
        const items = [
            { string: 'test', number: 42, boolean: true, object: { nested: 'value' }, array: [1, 2, 3] },
        ];
        const result = generateSchemaFromItems(items);
        expect(result).toBeDefined();
        expect(result?.type).toBe('array');
        if (result?.items && typeof result.items === 'object' && 'properties' in result.items) {
            const props = result.items.properties;
            expect(props).toBeDefined();
            if (props) {
                expect(props.string?.type).toBe('string');
                expect(props.number?.type).toBe('integer');
                expect(props.boolean?.type).toBe('boolean');
                expect(props.object?.type).toBe('object');
                expect(props.array?.type).toBe('array');
                expect(props.object?.properties?.nested?.type).toBe('string');
                expect(props.array?.items?.type).toBe('integer');
            }
        }
    });

    it('should respect the limit option', () => {
        const items = [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
            { id: 3, name: 'C' },
            { id: 4, extra: 'D' },
            { id: 5, extra: 'E' },
        ];
        const result = generateSchemaFromItems(items, { limit: 3 });
        expect(result).toBeDefined();
        expect(result?.type).toBe('array');
        if (result?.items && typeof result.items === 'object' && 'properties' in result.items) {
            const props = result.items.properties;
            expect(props).toBeDefined();
            if (props) {
                expect(props.id).toBeDefined();
                expect(props.name).toBeDefined();
                expect(props.extra).toBeUndefined(); // Should not include fields from items beyond limit
            }
        }
    });
});
