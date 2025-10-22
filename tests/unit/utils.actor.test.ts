import { describe, expect, it } from 'vitest';

import { ensureOutputWithinCharLimit, getActorDefinitionStorageFieldNames } from '../../src/utils/actor.js';

describe('getActorDefinitionStorageFieldNames', () => {
    it('should return an array of field names from a single view (display.properties and transformation.fields)', () => {
        const storage = {
            views: {
                view1: {
                    display: {
                        properties: {
                            foo: {},
                            bar: {},
                            baz: {},
                        },
                    },
                    transformation: {
                        fields: ['baz', 'qux', 'extra'],
                    },
                },
            },
        };
        const result = getActorDefinitionStorageFieldNames(storage);
        expect(result.sort()).toEqual(['bar', 'baz', 'extra', 'foo', 'qux']);
    });

    it('should return unique field names from multiple views (display.properties and transformation.fields)', () => {
        const storage = {
            views: {
                view1: {
                    display: {
                        properties: {
                            foo: {},
                            bar: {},
                        },
                    },
                    transformation: {
                        fields: ['foo', 'alpha'],
                    },
                },
                view2: {
                    display: {
                        properties: {
                            bar: {},
                            baz: {},
                        },
                    },
                    transformation: {
                        fields: ['baz', 'beta', 'alpha'],
                    },
                },
            },
        };
        const result = getActorDefinitionStorageFieldNames(storage);
        expect(result.sort()).toEqual(['alpha', 'bar', 'baz', 'beta', 'foo']);
    });

    it('should return an empty array if no properties or fields are present', () => {
        const storage = {
            views: {
                view1: {
                    display: {
                        properties: {},
                    },
                    transformation: {
                        fields: [],
                    },
                },
            },
        };
        const result = getActorDefinitionStorageFieldNames(storage);
        expect(result).toEqual([]);
    });

    it('should handle empty views object', () => {
        const storage = { views: {} };
        const result = getActorDefinitionStorageFieldNames(storage);
        expect(result).toEqual([]);
    });

    it('should handle missing transformation or display', () => {
        const storage = {
            views: {
                view1: {
                    display: {
                        properties: { foo: {} },
                    },
                },
                view2: {
                    transformation: {
                        fields: ['bar', 'baz'],
                    },
                },
                view3: {},
            },
        };
        const result = getActorDefinitionStorageFieldNames(storage);
        expect(result.sort()).toEqual(['bar', 'baz', 'foo']);
    });
});

describe('ensureOutputWithinCharLimit', () => {
    it('should return all items when limit is high', () => {
        const items = [
            { id: 1, name: 'Item 1', value: 'test' },
            { id: 2, name: 'Item 2', value: 'test' },
        ];
        const charLimit = JSON.stringify(items).length;
        const result = ensureOutputWithinCharLimit(items, [], charLimit);
        expect(result).toEqual(items);
    });

    it('should use important fields when all items exceed limit', () => {
        const items = [
            { id: 1, name: 'Item 1', description: 'Very long description that makes this item exceed the limit', extra: 'unnecessary data' },
            { id: 2, name: 'Item 2', description: 'Another long description', extra: 'more unnecessary data' },
        ];
        const importantFields = ['id', 'name'];
        const charLimit = 100; // Very small limit
        const result = ensureOutputWithinCharLimit(items, importantFields, charLimit);
        expect(result).toEqual([
            { id: 1, name: 'Item 1' },
            { id: 2, name: 'Item 2' },
        ]);
    });

    it('should remove all items when limit is extremely small', () => {
        const items = [
            { id: 1, name: 'Item 1' },
            { id: 2, name: 'Item 2' },
        ];
        const charLimit = 10; // Extremely small limit - even empty array JSON "[]" is 2 chars
        const result = ensureOutputWithinCharLimit(items, [], charLimit);
        expect(result).toEqual([]);
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(charLimit);
    });
});
