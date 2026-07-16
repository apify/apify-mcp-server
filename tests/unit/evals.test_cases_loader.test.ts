import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadTestCases } from '../../evals/workflows/test_cases_loader.js';

const temporaryDirectories: string[] = [];

function writeTestCases(testCases: unknown[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-evals-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'test_cases.json');
    writeFileSync(filePath, JSON.stringify({ version: '1.0', testCases }));
    return filePath;
}

function createTestCase(overrides: Record<string, unknown> = {}) {
    return {
        id: 'test',
        category: 'code-mode',
        query: 'Do the task',
        reference: 'Complete the task',
        ...overrides,
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('loadTestCases()', () => {
    it('rejects a tool that is both enabled and disallowed', () => {
        const path = writeTestCases([createTestCase({ tools: ['call-actor'], disallowedTools: ['call-actor'] })]);

        expect(() => loadTestCases(path)).toThrow("Tool 'call-actor' is both enabled and disallowed");
    });

    it('rejects paired arms with different user queries', () => {
        const path = writeTestCases([
            createTestCase({ id: 'standard', pairId: 'pair', query: 'First query' }),
            createTestCase({ id: 'runtime', pairId: 'pair', query: 'Second query' }),
        ]);

        expect(() => loadTestCases(path)).toThrow("pair 'pair' must use the same query");
    });
});
