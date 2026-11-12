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

function summarizeDatasetItems(overrides: Partial<Parameters<typeof buildDatasetItemsSummaryNextStep>[0]>) {
    return buildDatasetItemsSummaryNextStep({
        datasetId: 'ds-1',
        itemCount: 3,
        totalItemCount: 3,
        offset: 0,
        limit: 20,
        loadedToolNames: [HELPER_TOOLS.DATASET_GET],
        ...overrides,
    });
}

const LAST_PAGE = summarizeDatasetItems({});
const MORE_PAGES = summarizeDatasetItems({ itemCount: 20, totalItemCount: 100 });
const PAST_THE_END = summarizeDatasetItems({ offset: 100, itemCount: 0 });

describe('dataset items paging guidance', () => {
    it('gives each outcome its own guidance', () => {
        const outcomes = [LAST_PAGE, MORE_PAGES, PAST_THE_END];

        expect(new Set(outcomes.map((o) => o.summary)).size).toBe(outcomes.length);
    });

    it('points at the next page while items remain', () => {
        expect(MORE_PAGES.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        expect(MORE_PAGES.nextStep).toContain('limit');
    });

    // With clean=true the API pages before it drops empty items, so the next page starts at offset + limit.
    it('treats a short page as the last when offset plus limit reaches the total', () => {
        expect(summarizeDatasetItems({ itemCount: 5, totalItemCount: 20 })).toEqual(LAST_PAGE);
    });

    it('points at get-dataset on the last page when the session has it', () => {
        expect(LAST_PAGE.nextStep).toContain(`${HELPER_TOOLS.DATASET_GET} with datasetId=ds-1`);
    });

    it('names no get-dataset on the last page when the session lacks it', () => {
        expect(summarizeDatasetItems({ loadedToolNames: [] }).nextStep).not.toContain(HELPER_TOOLS.DATASET_GET);
    });

    it('treats an empty dataset as the last page', () => {
        expect(summarizeDatasetItems({ itemCount: 0, totalItemCount: 0 })).toEqual(LAST_PAGE);
    });
});

describe('dataset items requested past the last item', () => {
    it('points back at get-dataset-items', () => {
        expect(PAST_THE_END.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
    });

    // The item count lags new pushes, so a page that returned items is not past the end.
    it('treats a page that returned items as fetched when the item count is behind', () => {
        expect(summarizeDatasetItems({ offset: 20, itemCount: 5, totalItemCount: 20 })).toEqual(LAST_PAGE);
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

    // Linear time takes well under a millisecond here; the bound only catches time that grows faster than the length.
    it('normalizes a 100,000-character key with a quote run inside it within a second', () => {
        const key = `a${'"'.repeat(100_000)}a`;

        const startedAt = performance.now();
        expect(normalizeRecordKey(key)).toBe(key);
        expect(performance.now() - startedAt).toBeLessThan(1000);
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
