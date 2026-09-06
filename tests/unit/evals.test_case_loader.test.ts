import { describe, expect, it } from 'vitest';

import { filterById } from '../../evals/shared/test_case_loader.js';
import type { BaseTestCase } from '../../evals/shared/types.js';

/** Mirrors the post-migration id scheme: <category>/<slug>, one family per source dataset. */
const CASES: BaseTestCase[] = [
    { id: 'tasks/create-explicit-1', category: 'create', query: 'q' },
    { id: 'tasks/create-collision', category: 'create', query: 'q' },
    { id: 'tasks/get-explicit-1', category: 'get', query: 'q' },
    { id: 'tasks/get-not-found', category: 'get', query: 'q' },
    { id: 'tasks/update-explicit-1', category: 'update', query: 'q' },
    { id: 'tasks/publish-explicit-1', category: 'publish', query: 'q' },
    { id: 'tasks/publish-discovery', category: 'publish', query: 'q' },
    { id: 'tasks/unpublish-explicit-1', category: 'unpublish', query: 'q' },
    { id: 'tasks/chain-hard-1', category: 'chain', query: 'q' },
    { id: 'tasks/list-explicit-1', category: 'list', query: 'q' },
    { id: 'web-fetch/basic-1', category: 'fetch', query: 'q' },
    { id: 'web-fetch/unreachable', category: 'fetch', query: 'q' },
    { id: 'mcp-agent/search-actors-1', category: 'search-actors', query: 'q' },
];

describe('filterById()', () => {
    it('selects only the ids in one family by its id prefix', () => {
        const selected = filterById(CASES, '^tasks/');

        expect(selected).toHaveLength(10);
        expect(selected.every((testCase) => testCase.id.startsWith('tasks/'))).toBe(true);
    });

    it('excludes ids from other families', () => {
        const selected = filterById(CASES, '^tasks/');

        expect(selected.map((testCase) => testCase.id)).not.toContain('web-fetch/basic-1');
        expect(selected.map((testCase) => testCase.id)).not.toContain('mcp-agent/search-actors-1');
    });
});
