import { describe, expect, it } from 'vitest';

import { searchApifyDocs } from '../../src/tools/docs/search_apify_docs.js';

describe('search-apify-docs query length', () => {
    it('accepts a query of 150 characters', () => {
        expect(searchApifyDocs.ajvValidate({ query: 'a'.repeat(150) })).toBe(true);
    });

    it('rejects a query of 151 characters', () => {
        expect(searchApifyDocs.ajvValidate({ query: 'a'.repeat(151) })).toBe(false);
    });

    // Algolia answers 400 to a query of 512 bytes or more.
    it('keeps the longest accepted query of three-byte characters under 512 bytes', () => {
        const query = 'あ'.repeat(150);

        expect(searchApifyDocs.ajvValidate({ query })).toBe(true);
        expect(Buffer.byteLength(query)).toBeLessThan(512);
    });
});
