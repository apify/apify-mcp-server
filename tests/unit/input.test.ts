import { describe, expect, it } from 'vitest';

import { normalizeList, processInput, toBoolean } from '../../src/input.js';
import type { Input } from '../../src/types.js';

describe('toBoolean', () => {
    describe('with defaultValue true', () => {
        it('should return true for undefined value', () => {
            expect(toBoolean(undefined, true)).toBe(true);
        });

        it('should return true for boolean true', () => {
            expect(toBoolean(true, true)).toBe(true);
        });

        it('should return false for boolean false', () => {
            expect(toBoolean(false, true)).toBe(false);
        });

        it('should return true for string "true" (case insensitive), regardless of default', () => {
            // Using default=false to prove the function returns true, not the default
            expect(toBoolean('true', false)).toBe(true);
            expect(toBoolean('TRUE', false)).toBe(true);
            expect(toBoolean('True', false)).toBe(true);
            expect(toBoolean('TrUe', false)).toBe(true);
        });

        it('should return false for string "false" (case insensitive), regardless of default', () => {
            // Using default=true to prove the function returns false, not the default
            expect(toBoolean('false', true)).toBe(false);
            expect(toBoolean('FALSE', true)).toBe(false);
            expect(toBoolean('False', true)).toBe(false);
            expect(toBoolean('FaLsE', true)).toBe(false);
        });

        it('should return false for non-boolean strings (not "true"), regardless of default', () => {
            // Using default=true to prove the function returns false, not the default
            expect(toBoolean('yes', true)).toBe(false);
            expect(toBoolean('no', true)).toBe(false);
            expect(toBoolean('1', true)).toBe(false);
            expect(toBoolean('0', true)).toBe(false);
            expect(toBoolean('', true)).toBe(false);
            expect(toBoolean('random', true)).toBe(false);
        });

        it('should return default value for non-string, non-boolean types', () => {
            expect(toBoolean(1, true)).toBe(true);
            expect(toBoolean(0, true)).toBe(true);
            expect(toBoolean(null, true)).toBe(true);
            expect(toBoolean({}, true)).toBe(true);
            expect(toBoolean([], true)).toBe(true);
        });

        it('should demonstrate default value behavior with opposite defaults', () => {
            // Same input, different defaults - proves it uses the default for non-string/non-boolean
            expect(toBoolean(1, true)).toBe(true);
            expect(toBoolean(1, false)).toBe(false);
            expect(toBoolean(null, true)).toBe(true);
            expect(toBoolean(null, false)).toBe(false);
            expect(toBoolean({}, true)).toBe(true);
            expect(toBoolean({}, false)).toBe(false);
        });
    });

    describe('with defaultValue false', () => {
        it('should return false for undefined value', () => {
            expect(toBoolean(undefined, false)).toBe(false);
        });

        it('should return true for boolean true', () => {
            expect(toBoolean(true, false)).toBe(true);
        });

        it('should return false for boolean false', () => {
            expect(toBoolean(false, false)).toBe(false);
        });

        it('should return true for string "true" (case insensitive), regardless of default', () => {
            // Using default=false to prove the function returns true, not the default
            expect(toBoolean('true', false)).toBe(true);
            expect(toBoolean('TRUE', false)).toBe(true);
            expect(toBoolean('True', false)).toBe(true);
        });

        it('should return false for string "false" (case insensitive), regardless of default', () => {
            // Using default=true to prove the function returns false, not the default
            expect(toBoolean('false', true)).toBe(false);
            expect(toBoolean('FALSE', true)).toBe(false);
            expect(toBoolean('False', true)).toBe(false);
        });

        it('should return false for non-boolean strings (not "true"), regardless of default', () => {
            // Using default=true to prove the function returns false, not the default
            expect(toBoolean('yes', true)).toBe(false);
            expect(toBoolean('no', true)).toBe(false);
            expect(toBoolean('1', true)).toBe(false);
            expect(toBoolean('0', true)).toBe(false);
            expect(toBoolean('', true)).toBe(false);
            expect(toBoolean('random', true)).toBe(false);
        });

        it('should return default value for non-string, non-boolean types', () => {
            expect(toBoolean(1, false)).toBe(false);
            expect(toBoolean(0, false)).toBe(false);
            expect(toBoolean(null, false)).toBe(false);
            expect(toBoolean({}, false)).toBe(false);
            expect(toBoolean([], false)).toBe(false);
        });
    });
});

describe('normalizeList', () => {
    describe('undefined input', () => {
        it('should return undefined for undefined input', () => {
            expect(normalizeList(undefined)).toBeUndefined();
        });
    });

    describe('array input', () => {
        it('should return trimmed array for string array', () => {
            expect(normalizeList(['item1', 'item2', 'item3'])).toEqual(['item1', 'item2', 'item3']);
        });

        it('should trim whitespace from array items', () => {
            expect(normalizeList([' item1 ', '  item2  ', 'item3\t'])).toEqual(['item1', 'item2', 'item3']);
        });

        it('should filter out empty strings from array', () => {
            expect(normalizeList(['item1', '', 'item2', '   ', 'item3'])).toEqual(['item1', 'item2', 'item3']);
        });

        it('should convert non-string array items to strings', () => {
            expect(normalizeList([1, 2, 'item3'] as (string | number)[])).toEqual(['1', '2', 'item3']);
        });

        it('should handle empty array', () => {
            expect(normalizeList([])).toEqual([]);
        });

        it('should handle array with only empty/whitespace strings', () => {
            expect(normalizeList(['', '   ', '\t', '\n'])).toEqual([]);
        });
    });

    describe('string input', () => {
        it('should split comma-separated string', () => {
            expect(normalizeList('item1,item2,item3')).toEqual(['item1', 'item2', 'item3']);
        });

        it('should trim whitespace around commas', () => {
            expect(normalizeList('item1, item2 , item3')).toEqual(['item1', 'item2', 'item3']);
        });

        it('should handle extra whitespace and commas', () => {
            expect(normalizeList(' item1 , , item2 ,  item3  ')).toEqual(['item1', 'item2', 'item3']);
        });

        it('should return empty array for empty string', () => {
            expect(normalizeList('')).toEqual([]);
        });

        it('should return empty array for whitespace-only string', () => {
            expect(normalizeList('   ')).toEqual([]);
            expect(normalizeList('\t\n')).toEqual([]);
        });

        it('should handle single item without commas', () => {
            expect(normalizeList('single-item')).toEqual(['single-item']);
        });

        it('should handle string with only commas', () => {
            expect(normalizeList(',,,,')).toEqual([]);
        });

        it('should handle mixed empty and valid items', () => {
            expect(normalizeList('item1,,item2, ,item3')).toEqual(['item1', 'item2', 'item3']);
        });

        it('should handle trailing and leading commas', () => {
            expect(normalizeList(',item1,item2,item3,')).toEqual(['item1', 'item2', 'item3']);
        });
    });

    describe('edge cases', () => {
        it('should handle numeric string input', () => {
            expect(normalizeList('1,2,3')).toEqual(['1', '2', '3']);
        });

        it('should handle special characters in items', () => {
            expect(normalizeList('item@1,item#2,item$3')).toEqual(['item@1', 'item#2', 'item$3']);
        });

        it('should handle items with internal spaces', () => {
            expect(normalizeList('item one,item two,item three')).toEqual(['item one', 'item two', 'item three']);
        });
    });
});

describe('processInput', () => {
    it('should handle string actors input and convert to tools', async () => {
        const input: Partial<Input> = {
            actors: 'actor1, actor2,actor3',
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['actor1', 'actor2', 'actor3']);
        expect(processed.actors).toBeUndefined();
    });

    it('should move array actors input into tools', async () => {
        const input: Partial<Input> = {
            actors: ['actor1', 'actor2', 'actor3'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['actor1', 'actor2', 'actor3']);
        expect(processed.actors).toBeUndefined();
    });

    it('should handle enableActorAutoLoading to set enableAddingActors', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            enableActorAutoLoading: true,
        };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(true);
    });

    it('should not override existing enableAddingActors with enableActorAutoLoading', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
            enableActorAutoLoading: true,
            enableAddingActors: false,
        };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(false);
    });

    it('should default enableAddingActors to false when not provided', async () => {
        const input: Partial<Input> = { };
        const processed = processInput(input);
        expect(processed.enableAddingActors).toBe(false);
    });

    it('should keep tools as array of valid featureTools keys', async () => {
        const input: Partial<Input> = {
            tools: ['docs', 'runs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs', 'runs']);
    });

    it('should handle empty tools array', async () => {
        const input: Partial<Input> = {
            tools: [],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([]);
    });

    it('should handle missing tools field (undefined) by moving actors into tools', async () => {
        const input: Partial<Input> = {
            actors: ['actor1'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['actor1']);
        expect(processed.actors).toBeUndefined();
    });

    it('should include all keys, even invalid ones', async () => {
        const input: Partial<Input> = {
            tools: ['docs', 'invalidKey', 'storage'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs', 'invalidKey', 'storage']);
    });

    it('should merge actors into tools for backward compatibility', async () => {
        const input: Partial<Input> = {
            actors: ['apify/website-content-crawler', 'apify/instagram-scraper'],
            tools: ['docs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([
            'docs',
            'apify/website-content-crawler',
            'apify/instagram-scraper',
        ]);
    });

    it('should merge actors into tools when tools is a string', async () => {
        const input: Partial<Input> = {
            actors: ['apify/instagram-scraper'],
            tools: 'runs',
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual([
            'runs',
            'apify/instagram-scraper',
        ]);
    });

    it('should not modify tools if actors is empty array', async () => {
        const input: Partial<Input> = {
            actors: [],
            tools: ['docs'],
        };
        const processed = processInput(input);
        expect(processed.tools).toEqual(['docs']);
    });
});
