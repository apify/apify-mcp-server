import { describe, expect, it } from 'vitest';

import { getActorDefinitionStorageFieldNames } from '../../src/utils/actor.js';

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
