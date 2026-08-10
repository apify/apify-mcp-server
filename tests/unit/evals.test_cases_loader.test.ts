import fs from 'node:fs';
import os from 'node:os';
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
    it('loads the canonical file', () => {
        expect(loadTestCases(DEFAULT_TEST_CASES_PATH).length).toBeGreaterThan(0);
    });

    it('names the path when the file is missing', () => {
        const missing = path.join(process.cwd(), 'nope.json');
        expect(() => loadTestCases(missing)).toThrow(missing);
    });

    it('rejects a typoed harness knob instead of dropping it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evals-'));
        const file = path.join(dir, 'typo.json');
        const testCase = { id: 'a', category: 'search', query: 'q', reference: 'r', failTool: ['call-actor'] };
        fs.writeFileSync(file, JSON.stringify({ version: '1', testCases: [testCase] }));

        expect(() => loadTestCases(file)).toThrow(/failTool/);
    });
});
