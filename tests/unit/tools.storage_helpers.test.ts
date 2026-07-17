import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import {
    buildDatasetItemsSummaryNextStep,
    buildBinaryRecordDisposition,
    normalizeRecordKey,
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
