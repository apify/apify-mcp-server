import { describe, expect, it } from 'vitest';

import { FAILURE_CATEGORY, TOOL_STATUS } from '../../src/const.js';
import {
    buildStorageNotFound,
    normalizeStorageId,
    wrapJsonText,
} from '../../src/tools/common/storage_helpers.js';

describe('wrapJsonText()', () => {
    it('emits a ```json … ``` fenced block', () => {
        expect(wrapJsonText({ a: 1 })).toBe('```json\n{"a":1}\n```');
    });

    it('serializes arrays', () => {
        expect(wrapJsonText([1, 2])).toBe('```json\n[1,2]\n```');
    });

    it('serializes primitives', () => {
        expect(wrapJsonText('x')).toBe('```json\n"x"\n```');
    });
});

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

describe('normalizeStorageId()', () => {
    // Wrapper-stripping behavior is pinned via `stripQuoteWrappers` in utils.generic.test.ts.
    it('delegates to stripQuoteWrappers — typical wrapped id is returned canonical', () => {
        expect(normalizeStorageId('`user~my-store`')).toBe('user~my-store');
    });
});
