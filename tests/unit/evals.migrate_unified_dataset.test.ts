import { describe, expect, it, vi } from 'vitest';

import {
    buildMigratedItem,
    deriveNewId,
    EXPECTED_ERRORS_BY_NEW_ID,
    getExpectedErrorsForId,
    findIdCollisions,
    parseLegacyMcpAgentItem,
    SOURCE_DATASETS,
} from '../../evals/mcp_agent/migrate_unified_dataset.js';

describe('module entrypoint guard', () => {
    it('does not run the CLI on import: no process.exit, no LangfuseClient construction', async () => {
        const langfuseCtor = vi.fn();
        vi.doMock('@langfuse/client', () => ({ LangfuseClient: langfuseCtor }));
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const originalEnv = { ...process.env };
        delete process.env.LANGFUSE_PUBLIC_KEY;
        delete process.env.LANGFUSE_SECRET_KEY;
        delete process.env.LANGFUSE_BASE_URL;

        try {
            vi.resetModules();
            await import('../../evals/mcp_agent/migrate_unified_dataset.js');
        } finally {
            process.env = originalEnv;
            vi.doUnmock('@langfuse/client');
            vi.resetModules();
            exitSpy.mockRestore();
        }

        expect(exitSpy).not.toHaveBeenCalled();
        expect(langfuseCtor).not.toHaveBeenCalled();
    });
});

describe('deriveNewId()', () => {
    it('strips the singular family-name prefix', () => {
        expect(deriveNewId('tasks', 'task-create-explicit-1')).toBe('tasks/create-explicit-1');
        expect(deriveNewId('tasks', 'task-get-not-found')).toBe('tasks/get-not-found');
        expect(deriveNewId('tasks', 'task-create-collision')).toBe('tasks/create-collision');
        expect(deriveNewId('tasks', 'task-publish-discovery')).toBe('tasks/publish-discovery');
    });

    it('strips a family-name prefix that already matches exactly (no plural/singular difference)', () => {
        expect(deriveNewId('web-fetch', 'web-fetch-unsupported-protocol')).toBe('web-fetch/unsupported-protocol');
        expect(deriveNewId('web-fetch', 'web-fetch-format-discovery')).toBe('web-fetch/format-discovery');
        expect(deriveNewId('web-selection', 'web-selection-rag-blocked')).toBe('web-selection/rag-blocked');
        expect(deriveNewId('web-selection', 'web-selection-blocked-native')).toBe('web-selection/blocked-native');
    });

    it('passes the id through unchanged when it has no redundant prefix to strip', () => {
        expect(deriveNewId('mcp-agent', 'search-actors-1')).toBe('mcp-agent/search-actors-1');
    });

    it('strips the plural family-name prefix too, if that is what the id starts with', () => {
        expect(deriveNewId('tasks', 'tasks-something')).toBe('tasks/something');
    });
});

describe('getExpectedErrorsForId()', () => {
    it('returns the hardcoded tool list for each of the 8 known error item ids', () => {
        expect(getExpectedErrorsForId('tasks/get-not-found')).toEqual(['get-actor-task']);
        expect(getExpectedErrorsForId('tasks/create-collision')).toEqual(['create-actor-task']);
        expect(getExpectedErrorsForId('tasks/publish-discovery')).toEqual(['publish-actor-task']);
        expect(getExpectedErrorsForId('web-fetch/unsupported-protocol')).toEqual(['apify--web-fetch']);
        expect(getExpectedErrorsForId('web-fetch/format-discovery')).toEqual(['apify--web-fetch']);
        expect(getExpectedErrorsForId('web-fetch/unreachable')).toEqual(['apify--web-fetch']);
        expect(getExpectedErrorsForId('web-selection/rag-blocked')).toEqual(['apify--rag-web-browser']);
        expect(getExpectedErrorsForId('web-selection/blocked-native')).toEqual(['apify--rag-web-browser']);
    });

    it('returns undefined for an id with no known expected error', () => {
        expect(getExpectedErrorsForId('tasks/create-explicit-1')).toBeUndefined();
    });

    it('has exactly 8 entries, matching the migration plan', () => {
        expect(Object.keys(EXPECTED_ERRORS_BY_NEW_ID)).toHaveLength(8);
    });
});

describe('buildMigratedItem()', () => {
    const legacyItem = {
        id: 'task-create-explicit-1',
        input: { query: 'Create a task named eval-sum-hourly for actor X' },
        expectedOutput: 'PASS if create-actor-task was called with name "eval-sum-hourly".',
        metadata: { category: 'create' },
    };

    it('maps a proper item to kind: agent, tier: [full], with the derived id', () => {
        expect(buildMigratedItem('tasks-evals', 'tasks', legacyItem)).toEqual({
            id: 'tasks/create-explicit-1',
            sourceDataset: 'tasks-evals',
            sourceId: 'task-create-explicit-1',
            input: legacyItem.input,
            expectedOutput: legacyItem.expectedOutput,
            metadata: { category: 'create', kind: 'agent', tier: ['full'] },
        });
    });

    it('attaches expectedErrors for one of the 8 known error items', () => {
        const errorItem = { ...legacyItem, id: 'task-get-not-found', metadata: { category: 'get' } };
        const migrated = buildMigratedItem('tasks-evals-errors', 'tasks', errorItem);
        expect(migrated.id).toBe('tasks/get-not-found');
        expect(migrated.metadata).toEqual({
            category: 'get',
            kind: 'agent',
            tier: ['full'],
            expectedErrors: ['get-actor-task'],
        });
    });

    it('carries the optional knobs (maxTurns, tools, failTools) through unchanged', () => {
        const withKnobs = {
            ...legacyItem,
            metadata: { category: 'create', maxTurns: 12, tools: ['tasks'], failTools: ['create-actor-task'] },
        };
        expect(buildMigratedItem('tasks-evals', 'tasks', withKnobs).metadata).toEqual({
            category: 'create',
            kind: 'agent',
            tier: ['full'],
            maxTurns: 12,
            tools: ['tasks'],
            failTools: ['create-actor-task'],
        });
    });
});

describe('findIdCollisions()', () => {
    it('reports no collisions when every new id is unique', () => {
        const plans = [
            buildMigratedItem('tasks-evals', 'tasks', {
                id: 'task-a',
                input: { query: 'q' },
                expectedOutput: 'r',
                metadata: { category: 'a' },
            }),
            buildMigratedItem('tasks-evals', 'tasks', {
                id: 'task-b',
                input: { query: 'q' },
                expectedOutput: 'r',
                metadata: { category: 'b' },
            }),
        ];
        expect(findIdCollisions(plans)).toEqual([]);
    });

    it('names both sources when two source ids strip to the same new id', () => {
        const plans = [
            buildMigratedItem('tasks-evals', 'tasks', {
                id: 'task-x',
                input: { query: 'q' },
                expectedOutput: 'r',
                metadata: { category: 'x' },
            }),
            buildMigratedItem('tasks-evals-errors', 'tasks', {
                id: 'tasks-x',
                input: { query: 'q' },
                expectedOutput: 'r',
                metadata: { category: 'x' },
            }),
        ];
        expect(findIdCollisions(plans)).toEqual([
            {
                id: 'tasks/x',
                sources: [
                    { dataset: 'tasks-evals', id: 'task-x' },
                    { dataset: 'tasks-evals-errors', id: 'tasks-x' },
                ],
            },
        ]);
    });
});

describe('parseLegacyMcpAgentItem()', () => {
    const item = { id: 'a', input: { query: 'q' }, expectedOutput: 'r', metadata: { category: 'search' } };

    it('accepts a pre-extension item shape (no kind/tier)', () => {
        expect(parseLegacyMcpAgentItem('mcp-agent-evals', item)).toEqual(item);
    });

    it('rejects an item carrying the new kind/tier fields, naming the source dataset and item', () => {
        const withNewFields = { ...item, metadata: { category: 'search', kind: 'agent', tier: ['full'] } };
        expect(() => parseLegacyMcpAgentItem('mcp-agent-evals', withNewFields)).toThrow(
            /Dataset "mcp-agent-evals" item "a"/,
        );
    });

    it('rejects a malformed item, naming the source dataset', () => {
        expect(() => parseLegacyMcpAgentItem('tasks-evals', { ...item, metadata: {} })).toThrow(
            /Dataset "tasks-evals"/,
        );
    });
});

describe('SOURCE_DATASETS', () => {
    it('covers the 4 proper suites and the 3 error suites, one family per pair', () => {
        expect(SOURCE_DATASETS).toEqual([
            { name: 'mcp-agent-evals', family: 'mcp-agent' },
            { name: 'tasks-evals', family: 'tasks' },
            { name: 'web-fetch-evals', family: 'web-fetch' },
            { name: 'web-selection-evals', family: 'web-selection' },
            { name: 'tasks-evals-errors', family: 'tasks' },
            { name: 'web-fetch-evals-errors', family: 'web-fetch' },
            { name: 'web-selection-evals-errors', family: 'web-selection' },
        ]);
    });
});
