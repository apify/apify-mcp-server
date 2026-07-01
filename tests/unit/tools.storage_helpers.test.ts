import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, HelperTools, KV_RECORD_MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
import {
    buildDatasetItemsSummaryNextStep,
    buildStorageNotFound,
    classifyBinaryRecord,
    normalizeRecordKey,
} from '../../src/tools/storage/storage_helpers.js';

describe('buildStorageNotFound()', () => {
    it('returns a SOFT_FAIL / INVALID_INPUT response with the supplied message', () => {
        const result = buildStorageNotFound("Dataset 'ds-1' not found.");

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: "Dataset 'ds-1' not found." }]);
        expect(result.toolTelemetry).toEqual({
            toolStatus: TOOL_STATUS.SOFT_FAIL,
            failureCategory: FAILURE_CATEGORY.INVALID_INPUT,
        });
    });
});

describe('buildDatasetItemsSummaryNextStep()', () => {
    it('suggests get-dataset on the terminal page when loaded', () => {
        const t = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 5,
            totalItemCount: 5,
            offset: 0,
            loadedToolNames: [HelperTools.DATASET_GET],
        });
        expect(t.nextStep).toContain(HelperTools.DATASET_GET);
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
        expect(t.nextStep).not.toContain(HelperTools.DATASET_GET);
        expect(t.nextStep).toContain('No more pages');
    });

    it('always points at get-dataset-items for the next page', () => {
        const loaded = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 20,
            totalItemCount: 100,
            offset: 0,
            loadedToolNames: [HelperTools.DATASET_GET],
        });
        const unloaded = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 20,
            totalItemCount: 100,
            offset: 0,
            loadedToolNames: [],
        });
        expect(loaded.nextStep).toBe(unloaded.nextStep);
        expect(loaded.nextStep).toContain(HelperTools.DATASET_GET_ITEMS);
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

describe('classifyBinaryRecord()', () => {
    it('inlines a value at or below the size limit as base64', () => {
        const value = Buffer.from('binary-data');

        const result = classifyBinaryRecord('image/png', value);

        expect(result).toEqual({ kind: 'inline', mimeType: 'image/png', base64: value.toString('base64') });
    });

    it('links out a value above the size limit, reporting its byte length', () => {
        const value = Buffer.alloc(KV_RECORD_MAX_INLINE_BYTES + 1);

        const result = classifyBinaryRecord('application/octet-stream', value);

        expect(result).toEqual({
            kind: 'linkOut',
            mimeType: 'application/octet-stream',
            bytes: KV_RECORD_MAX_INLINE_BYTES + 1,
        });
    });

    it('strips Content-Type parameters and lowercases the MIME type', () => {
        const result = classifyBinaryRecord('Image/PNG; charset=utf-8', Buffer.from('x'));

        expect(result.mimeType).toBe('image/png');
    });

    it('omits mimeType when no Content-Type is declared', () => {
        const result = classifyBinaryRecord(undefined, Buffer.from('x'));

        expect(result).not.toHaveProperty('mimeType');
    });
});
