import { describe, expect, it } from 'vitest';

import { deriveFlattenFromFields, getDatasetItems } from '../../src/tools/common/get_dataset_items.js';
import { getKeyValueStoreRecord } from '../../src/tools/common/get_key_value_store_record.js';

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

describe('getDatasetItems published JSON schema enforces runId/datasetId XOR', () => {
    const validate = getDatasetItems.ajvValidate;

    it('rejects empty input (neither runId nor datasetId)', () => {
        expect(validate({})).toBe(false);
    });

    it('rejects input with both runId and datasetId', () => {
        expect(validate({ runId: 'r1', datasetId: 'd1' })).toBe(false);
    });

    it('accepts runId alone', () => {
        expect(validate({ runId: 'r1' })).toBe(true);
    });

    it('accepts datasetId alone', () => {
        expect(validate({ datasetId: 'd1' })).toBe(true);
    });
});

describe('getKeyValueStoreRecord published JSON schema enforces runId/storeId XOR', () => {
    const validate = getKeyValueStoreRecord.ajvValidate;

    it('rejects input missing both runId and storeId', () => {
        expect(validate({ recordKey: 'INPUT' })).toBe(false);
    });

    it('rejects input with both runId and storeId', () => {
        expect(validate({ runId: 'r1', storeId: 's1', recordKey: 'INPUT' })).toBe(false);
    });

    it('accepts runId alone with recordKey', () => {
        expect(validate({ runId: 'r1', recordKey: 'INPUT' })).toBe(true);
    });

    it('accepts storeId alone with recordKey', () => {
        expect(validate({ storeId: 's1', recordKey: 'INPUT' })).toBe(true);
    });
});
