import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TEST_CASES_PATH,
    loadTestCases,
    resolveTestCasesPath,
} from '../../evals/workflows/test_cases_loader.js';

describe('resolveTestCasesPath()', () => {
    it('defaults to the canonical file next to the loader, independent of cwd', () => {
        expect(resolveTestCasesPath()).toBe(DEFAULT_TEST_CASES_PATH);
        expect(path.isAbsolute(DEFAULT_TEST_CASES_PATH)).toBe(true);
    });

    it('resolves a relative path against cwd, so the check and the read see one file', () => {
        expect(resolveTestCasesPath('evals/workflows/test_cases.json')).toBe(
            path.join(process.cwd(), 'evals/workflows/test_cases.json'),
        );
    });

    it('leaves an absolute path alone', () => {
        expect(resolveTestCasesPath('/tmp/scratch.json')).toBe('/tmp/scratch.json');
    });
});

describe('loadTestCases()', () => {
    it('loads the canonical file when no path is given', () => {
        expect(loadTestCases().length).toBeGreaterThan(0);
    });

    it('names the resolved path when the file is missing', () => {
        expect(() => loadTestCases('nope.json')).toThrow(
            `Test cases file not found: ${path.join(process.cwd(), 'nope.json')}`,
        );
    });
});
