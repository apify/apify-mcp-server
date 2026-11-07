import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import {
    buildDatasetItemsSummaryNextStep,
    buildBinaryRecordDisposition,
    buildKvsKeysSummaryNextStep,
    fetchStorageByIdOrName,
    normalizeRecordKey,
    resolveStorageId,
} from '../../src/tools/storage/storage_helpers.js';

// `buildStorageNotFound` was deleted in #937 — its six call sites call `respondUserError(text)`
// directly. The SOFT_FAIL + INVALID_INPUT contract it guarded is now covered by the `respondUserError`
// unit test in `tests/unit/utils.mcp.test.ts`.

describe('buildDatasetItemsSummaryNextStep()', () => {
    it('suggests get-dataset on the terminal page when loaded', () => {
        const t = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 5,
            totalItemCount: 5,
            offset: 0,
            fields: [],
            hasOnlyEmptyItems: false,
            loadedToolNames: [HELPER_TOOLS.DATASET_GET],
        });
        expect(t.nextStep).toContain(HELPER_TOOLS.DATASET_GET);
        expect(t.nextStep).toContain('datasetId=ds-1');
    });

    it('omits get-dataset when not loaded', () => {
        const t = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 5,
            totalItemCount: 5,
            offset: 0,
            fields: [],
            hasOnlyEmptyItems: false,
            loadedToolNames: [],
        });
        expect(t.nextStep).not.toContain(HELPER_TOOLS.DATASET_GET);
        expect(t.nextStep).toContain('No more pages');
    });

    it('always points at get-dataset-items for the next page', () => {
        const loaded = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 20,
            totalItemCount: 100,
            offset: 0,
            fields: [],
            hasOnlyEmptyItems: false,
            loadedToolNames: [HELPER_TOOLS.DATASET_GET],
        });
        const unloaded = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 20,
            totalItemCount: 100,
            offset: 0,
            fields: [],
            hasOnlyEmptyItems: false,
            loadedToolNames: [],
        });
        expect(loaded.nextStep).toBe(unloaded.nextStep);
        expect(loaded.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        expect(loaded.nextStep).toContain('offset=20');
    });
});

function summarizeDatasetItems(overrides: Partial<Parameters<typeof buildDatasetItemsSummaryNextStep>[0]>) {
    return buildDatasetItemsSummaryNextStep({
        datasetId: 'ds-1',
        itemCount: 3,
        totalItemCount: 3,
        offset: 0,
        fields: [],
        hasOnlyEmptyItems: false,
        loadedToolNames: [HELPER_TOOLS.DATASET_GET],
        ...overrides,
    });
}

describe('dataset items requested past the last item', () => {
    it.each([3, 100])('describes offset %i of a 3-item dataset as past the last item', (offset) => {
        expect(summarizeDatasetItems({ offset, itemCount: 0 })).toEqual({
            summary: `Offset ${offset} is past the last item: the dataset has 3 items (offsets 0 to 2).`,
            nextStep: `${HELPER_TOOLS.DATASET_GET_ITEMS} with offset=0 returns the first page.`,
        });
    });

    // The item count can lag new pushes, so a page that returned items is not past the end.
    it('describes a page that returned items as fetched, even when the item count is behind', () => {
        const { summary } = summarizeDatasetItems({ offset: 20, itemCount: 5, totalItemCount: 20 });

        expect(summary).not.toContain('past the last item');
    });

    it('counts a one-item dataset in the singular', () => {
        const { summary } = summarizeDatasetItems({ offset: 5, itemCount: 0, totalItemCount: 1 });

        expect(summary).toContain('the dataset has 1 item (');
    });

    it('keeps the text for an empty dataset', () => {
        const { summary } = summarizeDatasetItems({
            itemCount: 0,
            totalItemCount: 0,
            fields: ['price'],
            hasOnlyEmptyItems: true,
        });

        expect(summary).toBe('Fetched all 0 items.');
    });
});

describe('a field projection that matches nothing in the returned items', () => {
    const EMPTY_PROJECTION = { fields: ['price', 'rating'], hasOnlyEmptyItems: true };

    it('says so on the last page and points at the field list', () => {
        expect(summarizeDatasetItems(EMPTY_PROJECTION)).toEqual({
            summary: 'Fetched all 3 items. None of them has the requested fields (price, rating).',
            nextStep: `${HELPER_TOOLS.DATASET_GET} with datasetId=ds-1 lists the dataset's fields.`,
        });
    });

    it('says so on a page with more pages after it, instead of the next-page hint', () => {
        const { summary, nextStep } = summarizeDatasetItems({
            ...EMPTY_PROJECTION,
            itemCount: 20,
            totalItemCount: 100,
        });

        expect(summary).toBe(
            'Fetched 20 of 100 items (offset=0). None of them has the requested fields (price, rating).',
        );
        expect(nextStep).toContain(`${HELPER_TOOLS.DATASET_GET} with datasetId=ds-1`);
        expect(nextStep).not.toContain('offset=20');
    });

    // With clean=true the API drops the empty objects, so the page comes back empty.
    it('says so when clean=true dropped every projected item', () => {
        const { summary, nextStep } = summarizeDatasetItems({ ...EMPTY_PROJECTION, itemCount: 0 });

        expect(summary).toContain('None of them has the requested fields (price, rating).');
        expect(nextStep).not.toContain('offset=0');
    });

    it('names no tool for the field list when the session lacks get-dataset', () => {
        const { nextStep } = summarizeDatasetItems({ ...EMPTY_PROJECTION, loadedToolNames: [] });

        expect(nextStep).toBe('An item read without `fields` shows its field names.');
    });

    it('does not warn when no fields were requested', () => {
        expect(summarizeDatasetItems({ hasOnlyEmptyItems: true }).summary).toBe('Fetched all 3 items.');
    });

    it('does not warn when the returned items have content', () => {
        expect(summarizeDatasetItems({ fields: ['price'] }).summary).toBe('Fetched all 3 items.');
    });
});

// Regression: #1296 — the terminal nextStep named record/store tools the session was not served.
describe('buildKvsKeysSummaryNextStep()', () => {
    it.each([
        ['a nonempty listing', { count: 1, firstKey: 'INPUT' }, HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET],
        ['an empty listing', { count: 0 }, HELPER_TOOLS.KEY_VALUE_STORE_GET],
    ])('falls back on %s when %s is not loaded', (_, extra, sibling) => {
        const { nextStep } = buildKvsKeysSummaryNextStep({
            keyValueStoreId: 'kv-1',
            isTruncated: false,
            ...extra,
            loadedToolNames: [HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET],
        });

        expect(nextStep).toBe('No follow-up step.');
        expect(nextStep).not.toContain(sibling);
    });
});

describe('normalizeRecordKey()', () => {
    it('strips backticks and double / smart quotes', () => {
        expect(normalizeRecordKey('`INPUT`')).toBe('INPUT');
        expect(normalizeRecordKey('"data.json"')).toBe('data.json');
        expect(normalizeRecordKey('“data.json”')).toBe('data.json');
    });

    it("preserves apostrophes — `'` is a valid record-key character", () => {
        expect(normalizeRecordKey("o'reilly.json")).toBe("o'reilly.json");
        expect(normalizeRecordKey("'apostrophe-key'")).toBe("'apostrophe-key'");
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeRecordKey('  INPUT  ')).toBe('INPUT');
    });
});

describe('buildBinaryRecordDisposition()', () => {
    it('inlines a value at or below the size limit as base64', () => {
        const value = Buffer.from('binary-data');

        const result = buildBinaryRecordDisposition('image/png', value);

        expect(result).toEqual({ kind: 'inline', mimeType: 'image/png', base64: value.toString('base64') });
    });

    it('links out a value above the size limit, reporting its byte length', () => {
        const value = Buffer.alloc(MAX_INLINE_BYTES + 1);

        const result = buildBinaryRecordDisposition('application/octet-stream', value);

        expect(result).toEqual({
            kind: 'linkOut',
            mimeType: 'application/octet-stream',
            bytes: MAX_INLINE_BYTES + 1,
        });
    });

    it('inlines a value of exactly MAX_INLINE_BYTES (strict > threshold)', () => {
        const result = buildBinaryRecordDisposition('application/octet-stream', Buffer.alloc(MAX_INLINE_BYTES));

        expect(result.kind).toBe('inline');
    });

    it('strips Content-Type parameters and lowercases the MIME type', () => {
        const result = buildBinaryRecordDisposition('Image/PNG; charset=utf-8', Buffer.from('x'));

        expect(result.mimeType).toBe('image/png');
    });

    it('omits mimeType when no Content-Type is declared', () => {
        const result = buildBinaryRecordDisposition(undefined, Buffer.from('x'));

        expect(result).not.toHaveProperty('mimeType');
    });
});

describe('fetchStorageByIdOrName()', () => {
    it('returns the result with the safe id it was found under', async () => {
        const items = { items: [], total: 0 };
        const fetch = vi.fn().mockResolvedValue(items);

        expect(await fetchStorageByIdOrName('eval-ai-items', fetch)).toEqual({
            result: items,
            safeId: '~eval-ai-items',
        });
    });

    // List calls throw on a missing storage, so an ID-shaped name is only retried if the 404 reads as a miss.
    it("retries an ID-shaped value that 404s as the caller's own name", async () => {
        const notFound = Object.assign(new Error('Dataset was not found'), { statusCode: 404 });
        const fetch = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce({ items: [], total: 0 });

        const found = await fetchStorageByIdOrName('evalAiItems202610', fetch);

        expect(fetch).toHaveBeenNthCalledWith(1, 'evalAiItems202610');
        expect(found?.safeId).toBe('~evalAiItems202610');
    });

    it('returns undefined when the storage does not exist', async () => {
        expect(await fetchStorageByIdOrName('missing', async () => undefined)).toBeUndefined();
    });
});

describe('resolveStorageId()', () => {
    it('returns an ID without reading the storage', async () => {
        const get = vi.fn();

        expect(await resolveStorageId('WkzbQMuFYuamGv3YF', get)).toBe('WkzbQMuFYuamGv3YF');
        expect(get).not.toHaveBeenCalled();
    });

    it('reads the ID of a storage found by name', async () => {
        const get = vi.fn().mockResolvedValue({ id: 'WkzbQMuFYuamGv3YF' });

        expect(await resolveStorageId('~eval-ai-items', get)).toBe('WkzbQMuFYuamGv3YF');
        expect(get).toHaveBeenCalledWith('~eval-ai-items');
    });
});
