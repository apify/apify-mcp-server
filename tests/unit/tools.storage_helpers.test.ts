import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import { buildStorageNotFound, normalizeRecordKey } from '../../src/tools/common/storage_helpers.js';

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
