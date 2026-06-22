import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../src/const.js';
import {
    buildDatasetItemsSummaryNextStep,
    buildStorageNotFound,
    normalizeRecordKey,
} from '../../src/tools/common/storage_helpers.js';

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
    it('suggests get-dataset-schema on the terminal page when loaded', () => {
        const t = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 5,
            totalItemCount: 5,
            offset: 0,
            loadedToolNames: [HelperTools.DATASET_SCHEMA_GET],
        });
        expect(t.nextStep).toContain(HelperTools.DATASET_SCHEMA_GET);
        expect(t.nextStep).toContain('datasetId=ds-1');
    });

    it('omits get-dataset-schema when not loaded', () => {
        const t = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 5,
            totalItemCount: 5,
            offset: 0,
            loadedToolNames: [],
        });
        expect(t.nextStep).not.toContain(HelperTools.DATASET_SCHEMA_GET);
        expect(t.nextStep).toContain('No more pages');
    });

    it('always points at get-dataset-items for the next page', () => {
        const loaded = buildDatasetItemsSummaryNextStep({
            datasetId: 'ds-1',
            itemCount: 20,
            totalItemCount: 100,
            offset: 0,
            loadedToolNames: [HelperTools.DATASET_SCHEMA_GET],
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
