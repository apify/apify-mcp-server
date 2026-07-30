import { describe, expect, it } from 'vitest';

import { normalizeList, processInput } from '../../src/input.js';
import type { Input } from '../../src/types.js';

describe('normalizeList', () => {
    it('returns undefined for undefined', () => {
        expect(normalizeList(undefined)).toBeUndefined();
    });

    describe('array input', () => {
        it('trims items, filters empty strings, and stringifies non-strings', () => {
            expect(normalizeList(['item1', 'item2', 'item3'])).toEqual(['item1', 'item2', 'item3']);
            expect(normalizeList([' item1 ', '  item2  ', 'item3\t'])).toEqual(['item1', 'item2', 'item3']);
            expect(normalizeList(['item1', '', 'item2', '   ', 'item3'])).toEqual(['item1', 'item2', 'item3']);
            expect(normalizeList([1, 2, 'item3'] as (string | number)[])).toEqual(['1', '2', 'item3']);
            expect(normalizeList([])).toEqual([]);
            expect(normalizeList(['', '   ', '\t', '\n'])).toEqual([]);
        });
    });

    describe('string input', () => {
        it('splits on commas, trims items, and filters empty segments', () => {
            expect(normalizeList('item1,item2,item3')).toEqual(['item1', 'item2', 'item3']);
            expect(normalizeList('item1, item2 , item3')).toEqual(['item1', 'item2', 'item3']);
            expect(normalizeList(' item1 , , item2 ,  item3  ')).toEqual(['item1', 'item2', 'item3']);
            expect(normalizeList(',item1,,item2,item3,')).toEqual(['item1', 'item2', 'item3']);
        });

        it('returns empty array for empty, whitespace-only, or comma-only input', () => {
            expect(normalizeList('')).toEqual([]);
            expect(normalizeList('   ')).toEqual([]);
            expect(normalizeList('\t\n')).toEqual([]);
            expect(normalizeList(',,,,')).toEqual([]);
        });

        it('handles single items and preserves internal spaces', () => {
            expect(normalizeList('single-item')).toEqual(['single-item']);
            expect(normalizeList('item one,item two,item three')).toEqual(['item one', 'item two', 'item three']);
        });
    });
});

describe('processInput', () => {
    it('moves actors string into tools', () => {
        const processed = processInput({ actors: 'actor1, actor2,actor3' });
        expect(processed.tools).toEqual(['actor1', 'actor2', 'actor3']);
        expect(processed.actors).toBeUndefined();
    });

    it('moves actors array into tools when tools is absent', () => {
        const processed = processInput({ actors: ['actor1', 'actor2', 'actor3'] });
        expect(processed.tools).toEqual(['actor1', 'actor2', 'actor3']);
        expect(processed.actors).toBeUndefined();
    });

    it('appends actors to existing tools array', () => {
        const processed = processInput({
            actors: ['apify/website-content-crawler', 'apify/instagram-scraper'],
            tools: ['docs'],
        });
        expect(processed.tools).toEqual(['docs', 'apify/website-content-crawler', 'apify/instagram-scraper']);
    });

    it('appends actors to existing tools string', () => {
        const processed = processInput({ actors: ['apify/instagram-scraper'], tools: 'runs' });
        expect(processed.tools).toEqual(['runs', 'apify/instagram-scraper']);
    });

    it('leaves tools unchanged when actors is empty, keeping actors as []', () => {
        const processed = processInput({ actors: [], tools: ['docs'] });
        expect(processed.tools).toEqual(['docs']);
        expect(processed.actors).toEqual([]);
    });

    it('passes tools through as-is, including invalid keys', () => {
        expect(processInput({ tools: ['docs', 'runs'] }).tools).toEqual(['docs', 'runs']);
        expect(processInput({ tools: ['docs', 'invalidKey', 'storage'] as Input['tools'] }).tools).toEqual([
            'docs',
            'invalidKey',
            'storage',
        ]);
        expect(processInput({ tools: [] }).tools).toEqual([]);
    });

    it('leaves tools and actors undefined for empty input', () => {
        const processed = processInput({});
        expect(processed.tools).toBeUndefined();
        expect(processed.actors).toBeUndefined();
    });
});
