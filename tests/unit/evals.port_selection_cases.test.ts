import { describe, expect, it, vi } from 'vitest';

import { resolveInScopeToolIdentifiers } from '../../evals/mcp_agent/coverage_matrix.js';
import { parseMcpAgentItem } from '../../evals/mcp_agent/langfuse_dataset.js';
import {
    BURNED_LIVE_IDS,
    buildPortItem,
    findDuplicateIds,
    findUnsafeCollisions,
} from '../../evals/mcp_agent/port_selection_cases.js';
import { ARCHIVED_CASES, PORT_SELECTION_CASES } from '../../evals/mcp_agent/port_selection_cases_data.js';
import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { readJsonFile } from '../../src/utils/generic.js';

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
            await import('../../evals/mcp_agent/port_selection_cases.js');
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

/**
 * The 106 old ids from `evals/test_cases.json`, read once here so a change to the source file
 * would surface as a test failure rather than a silent drift between this table and reality.
 */
const testCasesJson = readJsonFile<{ version: string; testCases: { id: string }[] }>(
    import.meta.url,
    '../../evals/test_cases.json',
);

describe('buildPortItem()', () => {
    it('builds a kind: selection, tier: [pr] item from a minimal row', () => {
        const item = buildPortItem({
            decision: 'new',
            id: 'search-actors/example',
            query: 'find me a scraper',
            category: 'search-actors',
            expectedTools: ['search-actors'],
        });
        expect(item).toEqual({
            id: 'search-actors/example',
            input: { query: 'find me a scraper' },
            metadata: {
                category: 'search-actors',
                kind: 'selection',
                tier: ['pr'],
                expectedTools: ['search-actors'],
            },
        });
    });

    it('carries expectedArgs, mcpToolsOnly, and tools through when the row sets them', () => {
        const item = buildPortItem({
            decision: 'widen',
            id: 'apify--rag-web-browser/example',
            query: 'q',
            category: 'apify--rag-web-browser',
            expectedTools: ['apify--rag-web-browser', 'search-actors'],
            mcpToolsOnly: true,
            tools: ['runs'],
            expectedArgs: { actor: 'apify/rag-web-browser' },
        });
        expect(item.metadata).toEqual({
            category: 'apify--rag-web-browser',
            kind: 'selection',
            tier: ['pr'],
            expectedTools: ['apify--rag-web-browser', 'search-actors'],
            expectedArgs: { actor: 'apify/rag-web-browser' },
            mcpToolsOnly: true,
            tools: ['runs'],
        });
    });
});

describe('findDuplicateIds()', () => {
    it('returns an empty array when every id is unique', () => {
        expect(
            findDuplicateIds([
                { decision: 'new', id: 'a/1', query: 'q', category: 'a', expectedTools: ['a'] },
                { decision: 'new', id: 'a/2', query: 'q', category: 'a', expectedTools: ['a'] },
            ]),
        ).toEqual([]);
    });

    it('names an id reused by two rows', () => {
        expect(
            findDuplicateIds([
                { decision: 'new', id: 'a/1', query: 'q', category: 'a', expectedTools: ['a'] },
                { decision: 'new', id: 'a/1', query: 'q2', category: 'a', expectedTools: ['a'] },
            ]),
        ).toEqual(['a/1']);
    });

    it('the real authoring table has no internal duplicate ids', () => {
        expect(findDuplicateIds(PORT_SELECTION_CASES)).toEqual([]);
    });
});

describe('findUnsafeCollisions()', () => {
    it('flags a row whose id matches one of the 4 burned live slugs', () => {
        const rows = [
            {
                decision: 'new' as const,
                id: 'search-actors/tiktok-scraper',
                query: 'q',
                category: 'search-actors',
                expectedTools: ['search-actors'],
            },
        ];
        expect(findUnsafeCollisions(rows, new Set())).toEqual(['search-actors/tiktok-scraper']);
    });

    it('flags a row whose id matches a live item that is not kind: selection', () => {
        const rows = [
            {
                decision: 'new' as const,
                id: 'tasks/create-explicit-1',
                query: 'q',
                category: 'x',
                expectedTools: ['x'],
            },
        ];
        expect(findUnsafeCollisions(rows, new Set(['tasks/create-explicit-1']))).toEqual(['tasks/create-explicit-1']);
    });

    it('passes a row whose id is new and does not match a burned slug or a live agent item', () => {
        const rows = [
            {
                decision: 'new' as const,
                id: 'search-actors/brand-new',
                query: 'q',
                category: 'search-actors',
                expectedTools: ['search-actors'],
            },
        ];
        expect(findUnsafeCollisions(rows, new Set(['tasks/create-explicit-1']))).toEqual([]);
    });

    it('the real authoring table collides with none of the 4 burned live slugs', () => {
        expect(findUnsafeCollisions(PORT_SELECTION_CASES, new Set())).toEqual([]);
    });

    it('BURNED_LIVE_IDS names exactly the 4 slugs #260 already claimed live', () => {
        expect(BURNED_LIVE_IDS).toEqual([
            'call-actor/rag-web-browser',
            'fetch-actor-details/input-schema',
            'search-actors/tiktok-scraper',
            'get-actor-run/status',
        ]);
    });
});

/**
 * Offline collision check against the real non-selection (`kind: agent`) ids, read from the
 * committed dataset snapshot rather than Langfuse, so this stays zero-network. This is the same
 * check `port_selection_cases.ts`'s CLI runs live against `liveNonSelectionIds` before any write
 * — here it runs against a fixed, checked-in set instead.
 */
describe('findUnsafeCollisions() against the committed snapshot', () => {
    const snapshotRows = readJsonFile<{ id: string; kind: string }[]>(
        import.meta.url,
        '../../evals/mcp_agent/dataset_snapshot_mcp-server-evals.json',
    );
    const agentIds = snapshotRows.filter((row) => row.kind === 'agent').map((row) => row.id);

    it('the snapshot has exactly 60 kind: agent ids', () => {
        expect(agentIds).toHaveLength(60);
    });

    it('the real authoring table collides with none of the live kind: agent ids', () => {
        expect(findUnsafeCollisions(PORT_SELECTION_CASES, new Set(agentIds))).toEqual([]);
    });

    it('flags a fabricated row whose id equals a real kind: agent id', () => {
        const rows = [
            {
                decision: 'new' as const,
                id: agentIds[0],
                query: 'q',
                category: 'x',
                expectedTools: ['x'],
            },
        ];
        expect(findUnsafeCollisions(rows, new Set(agentIds))).toEqual([agentIds[0]]);
    });
});

describe('PORT_SELECTION_CASES: id scheme', () => {
    it('every id has exactly one "/" and the prefix is a real tool family', () => {
        const requiredToolIdentifiers = new Set(resolveInScopeToolIdentifiers());
        for (const row of PORT_SELECTION_CASES) {
            const parts = row.id.split('/');
            expect(parts, `id "${row.id}" must have exactly one "/"`).toHaveLength(2);
            const [family] = parts;
            // The id's family prefix is always the row's own `category`, which for every row
            // in this table is a real tool identifier (the two non-tool old categories,
            // tool-selection/ambiguous, were re-homed onto expectedTools[0] when this table
            // was authored).
            expect(requiredToolIdentifiers.has(family), `id "${row.id}"'s family "${family}" must be a real tool`).toBe(
                true,
            );
            expect(family).toBe(row.category);
        }
    });
});

describe('PORT_SELECTION_CASES: validation', () => {
    it('every row validates through the strict dataset-item validator used at run time', () => {
        for (const row of PORT_SELECTION_CASES) {
            expect(() => parseMcpAgentItem({ ...buildPortItem(row), expectedOutput: null })).not.toThrow();
        }
    });

    it('no row carries expectedArgs unless expectedTools names exactly one tool', () => {
        for (const row of PORT_SELECTION_CASES) {
            if (row.expectedArgs !== undefined) {
                expect(row.expectedTools, `"${row.id}" pins expectedArgs`).toHaveLength(1);
            }
        }
    });

    it('no row carries reference, context, or expectedOutput', () => {
        for (const row of PORT_SELECTION_CASES) {
            expect(row).not.toHaveProperty('reference');
            expect(row).not.toHaveProperty('context');
            expect(row).not.toHaveProperty('expectedOutput');
        }
    });
});

/**
 * The 5 `pr`-tier selection items #260 already added, before this port. Hardcoded from a live
 * probe of the dataset taken while authoring this table, rather than fetched, so the coverage
 * test below stays zero-network; `findUnsafeCollisions`'s live-id check (network, in
 * `port_selection_cases.ts`) is the runtime guard that these stay accurate.
 */
const PRE_EXISTING_SELECTION_EXPECTED_TOOLS: string[][] = [
    ['apify--rag-web-browser', 'call-actor'], // call-actor/rag-web-browser
    ['fetch-actor-details'], // fetch-actor-details/input-schema
    ['get-actor-run'], // get-actor-run/status
    ['search-actors'], // search-actors/tiktok-scraper
    ['apify--web-fetch'], // web-fetch/example-com
];

/**
 * `report-problem` is a known, explicit gap in the coverage floor below — NOT a silent omission.
 * apify/ai-team#240 iter-2 authored and calibrated a `report-problem` selection case (mcpToolsOnly
 * + 2 further query rephrases, each verified 3x on claude-opus-5) and every attempt failed:
 * either "no tool call attempted" (the agent spends its fixed 2-turn selection budget without
 * ever calling report-problem) or an investigative call instead (e.g. `search-actors`), despite
 * queries that ruled out investigation explicitly. This is structural — no single-turn query
 * makes report-problem the first call within `SELECTION_MAX_TURNS`, not fixable by editing the
 * query further within this PR's scope (no touching `SELECTION_MAX_TURNS` or the tool
 * description). The case was upserted then archived (not deleted) in the live `mcp-server-evals`
 * Langfuse dataset, with this reason in its metadata. This tool has no `pr`-tier case, so 24 of
 * the 25 tool identifiers are covered, not 25 — accepted for now and tracked as a follow-up (a
 * later change may touch `SELECTION_MAX_TURNS` or the tool description), tracked here explicitly
 * rather than hidden by shrinking the required-identifier count.
 */
const KNOWN_UNCOVERED_TOOL_IDENTIFIERS: readonly string[] = [HELPER_TOOLS.PROBLEM_REPORT];

describe('PORT_SELECTION_CASES: coverage', () => {
    it('every one of the 25 tool identifiers, derived from the registry, has >= 1 case, except the documented report-problem gap', () => {
        const requiredToolIdentifiers = resolveInScopeToolIdentifiers();
        expect(requiredToolIdentifiers).toHaveLength(25);

        const coveredTools = new Set([
            ...PORT_SELECTION_CASES.flatMap((row) => row.expectedTools),
            ...PRE_EXISTING_SELECTION_EXPECTED_TOOLS.flat(),
        ]);
        const missing = requiredToolIdentifiers.filter((tool) => !coveredTools.has(tool));
        // The only tolerated gap is the documented, structural report-problem one above — any
        // other missing tool still fails this test.
        expect(missing, `tool(s) with zero pr-tier selection coverage: ${missing.join(', ')}`).toEqual(
            KNOWN_UNCOVERED_TOOL_IDENTIFIERS,
        );
    });

    it('every non-default-served tool in the table carries the matching tools metadata', () => {
        // Default-served (no `tools` metadata needed): actors + docs categories, report-problem,
        // and everything AUTO_INJECTED_TOOLS adds once call-actor is present.
        const defaultServedTools = new Set<string>([
            HELPER_TOOLS.ACTOR_CALL,
            HELPER_TOOLS.ACTOR_GET_DETAILS,
            HELPER_TOOLS.STORE_SEARCH,
            HELPER_TOOLS.DOCS_SEARCH,
            HELPER_TOOLS.DOCS_FETCH,
            HELPER_TOOLS.PROBLEM_REPORT,
            HELPER_TOOLS.ACTOR_RUNS_GET,
            HELPER_TOOLS.DATASET_GET_ITEMS,
            HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
            HELPER_TOOLS.ACTOR_RUNS_ABORT,
            actorNameToToolName(RAG_WEB_BROWSER),
            actorNameToToolName(WEB_FETCH),
        ]);
        const toolsCategoryFor: Record<string, string> = {
            [HELPER_TOOLS.ACTOR_RUNS_LOG]: 'runs',
            [HELPER_TOOLS.ACTOR_RUN_LIST_GET]: 'runs',
            [HELPER_TOOLS.DATASET_GET]: 'storage',
            [HELPER_TOOLS.DATASET_LIST_GET]: 'storage',
            [HELPER_TOOLS.DATASET_SCHEMA_GET]: 'storage',
            [HELPER_TOOLS.KEY_VALUE_STORE_GET]: 'storage',
            [HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET]: 'storage',
            [HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET]: 'storage',
            [HELPER_TOOLS.ACTOR_TASK_GET]: 'tasks',
            [HELPER_TOOLS.ACTOR_TASK_CREATE]: 'tasks',
            [HELPER_TOOLS.ACTOR_TASK_UPDATE]: 'tasks',
            [HELPER_TOOLS.ACTOR_TASK_PUBLISH]: 'tasks',
            [HELPER_TOOLS.ACTOR_TASK_UNPUBLISH]: 'tasks',
        };

        for (const row of PORT_SELECTION_CASES) {
            const needsTools = row.expectedTools.filter((tool) => !defaultServedTools.has(tool));
            if (needsTools.length === 0) continue;
            for (const tool of needsTools) {
                const requiredCategory = toolsCategoryFor[tool];
                expect(requiredCategory, `no known "tools" category for "${tool}" (used by "${row.id}")`).toBeDefined();
                expect(row.tools, `"${row.id}" needs tools: ["${requiredCategory}"]`).toContain(requiredCategory);
            }
        }
    });
});

describe('accounting for all 106 source ids', () => {
    it('the source dataset is still 106 v1.11 cases (a change here means this table is stale)', () => {
        expect(testCasesJson.version).toBe('1.11');
        expect(testCasesJson.testCases).toHaveLength(106);
    });

    it('every source id is ported exactly once or archived exactly once, never both, never neither', () => {
        const sourceIds = testCasesJson.testCases.map((c) => c.id);
        const portedSourceIds = PORT_SELECTION_CASES.map((row) => row.sourceId).filter(
            (id): id is string => id !== undefined,
        );
        const archivedSourceIds = ARCHIVED_CASES.map((entry) => entry.sourceId);

        expect(new Set(portedSourceIds).size).toBe(portedSourceIds.length); // no source id ported twice
        expect(new Set(archivedSourceIds).size).toBe(archivedSourceIds.length); // no source id archived twice

        const accountedFor = new Set([...portedSourceIds, ...archivedSourceIds]);
        const missing = sourceIds.filter((id) => !accountedFor.has(id));
        expect(missing, `source id(s) neither ported nor archived: ${missing.join(', ')}`).toEqual([]);

        const overlap = portedSourceIds.filter((id) => archivedSourceIds.includes(id));
        expect(overlap, `source id(s) both ported and archived: ${overlap.join(', ')}`).toEqual([]);

        expect(portedSourceIds.length + archivedSourceIds.length).toBe(106);
    });

    it('every archived id has a stated, non-empty reason', () => {
        for (const entry of ARCHIVED_CASES) {
            expect(entry.reason.length).toBeGreaterThan(10);
        }
    });
});

describe('lazy-user wave', () => {
    it('covers all 4 named failure modes: typo, vague goal, missing parameter, wrong Actor name', () => {
        const lazyUserIds = [
            'fetch-actor-details/typo-actor-name',
            'search-actors/vague-scraping-need',
            'get-actor-log/missing-line-count',
            'fetch-actor-details/nonexistent-actor',
        ];
        const ids = new Set(PORT_SELECTION_CASES.map((row) => row.id));
        for (const id of lazyUserIds) {
            expect(ids.has(id), `expected lazy-user case "${id}" in the table`).toBe(true);
        }
        expect(lazyUserIds.length).toBeGreaterThanOrEqual(4);
    });
});
