import { describe, expect, it } from 'vitest';

import { deriveFlattenFromFields } from '../../src/tools/common/get_dataset_items.js';

describe('deriveFlattenFromFields', () => {
    it('returns empty list when no fields contain a dot', () => {
        expect(deriveFlattenFromFields(['title', 'url'])).toEqual([]);
    });

    it('extracts unique top-level prefixes from dot-notation fields', () => {
        expect(deriveFlattenFromFields(['metadata.url', 'crawl.statusCode', 'title']))
            .toEqual(['metadata', 'crawl']);
    });

    it('deduplicates repeated prefixes', () => {
        expect(deriveFlattenFromFields(['metadata.url', 'metadata.title']))
            .toEqual(['metadata']);
    });

    it('handles mixed deep and shallow paths', () => {
        expect(deriveFlattenFromFields(['a.b.c', 'a.x', 'd']))
            .toEqual(['a']);
    });

    it('returns empty list for empty input', () => {
        expect(deriveFlattenFromFields([])).toEqual([]);
    });

    it('skips fields with leading dot (no top-level prefix)', () => {
        expect(deriveFlattenFromFields(['.a', '.b.c'])).toEqual([]);
    });

    it('extracts the prefix from fields with a trailing dot', () => {
        expect(deriveFlattenFromFields(['a.', 'b.c'])).toEqual(['a', 'b']);
    });
});
