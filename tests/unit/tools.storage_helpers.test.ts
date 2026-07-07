import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { buildDatasetItemsSummaryNextStep, normalizeRecordKey } from '../../src/tools/storage/storage_helpers.js';

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
            loadedToolNames: [HELPER_TOOLS.DATASET_GET],
        });
        const unloaded = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 20,
            totalItemCount: 100,
            offset: 0,
            loadedToolNames: [],
        });
        expect(loaded.nextStep).toBe(unloaded.nextStep);
        expect(loaded.nextStep).toContain(HELPER_TOOLS.DATASET_GET_ITEMS);
        expect(loaded.nextStep).toContain('offset=20');
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
