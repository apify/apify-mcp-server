import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LangfuseClient } from '@langfuse/client';
import { describe, expect, it, vi } from 'vitest';

import {
    buildCoverageMatrix,
    type CoverageMatrix,
    countExercisedSpans,
    deriveArgumentGroups,
    fetchExperimentToolObservations,
    getDynamicToolIdentifiers,
    getWidgetToolIdentifiers,
    type MeasuredCoverageMatrixRow,
    type ObservedToolSpan,
    readSnapshot,
    renderCoverageMatrixMarkdown,
    renderSummaryLines,
    resolveExercisedArgumentGroups,
    resolveInScopeToolIdentifiers,
    resolveOutputPlan,
    resolveReachableToolNames,
} from '../../evals/mcp_agent/coverage_matrix.js';
import type { McpAgentTestCase } from '../../evals/mcp_agent/langfuse_dataset.js';
import { SELECTION_DENY_REASON } from '../../evals/mcp_agent/selection_mode.js';
import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../../evals/shared/config.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { readJsonFile } from '../../src/utils/generic.js';

/** Look up a row by identifier, failing loudly (not with a vague `undefined`) if it's missing. */
function requireRow(matrix: CoverageMatrix, identifier: string) {
    const row = matrix.rows.find((r) => r.identifier === identifier);
    if (row === undefined) throw new Error(`no coverage-matrix row for ${identifier}`);
    return row;
}

/** Same, narrowed to a `measured` row — throws if the tool turned out dynamic or excluded. */
function requireMeasuredRow(matrix: CoverageMatrix, identifier: string): MeasuredCoverageMatrixRow {
    const row = requireRow(matrix, identifier);
    if (row.kind !== 'measured') throw new Error(`expected a measured row for ${identifier}, got kind "${row.kind}"`);
    return row;
}

describe('module entrypoint guard', () => {
    it('does not run the CLI on import: no process.exit', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const originalEnv = { ...process.env };
        delete process.env.LANGFUSE_PUBLIC_KEY;
        delete process.env.LANGFUSE_SECRET_KEY;
        delete process.env.LANGFUSE_BASE_URL;

        try {
            vi.resetModules();
            await import('../../evals/mcp_agent/coverage_matrix.js');
        } finally {
            process.env = originalEnv;
            vi.resetModules();
            exitSpy.mockRestore();
        }

        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe('resolveInScopeToolIdentifiers()', () => {
    it('returns exactly 25 identifiers, ascending, no widgets, no retired names', () => {
        const identifiers = resolveInScopeToolIdentifiers();
        expect(identifiers).toHaveLength(25);
        expect(identifiers).toEqual([...identifiers].sort());
        expect(identifiers.some((name) => name.endsWith('-widget'))).toBe(false);
        expect(identifiers).toContain('apify--rag-web-browser');
        expect(identifiers).toContain('apify--web-fetch');
        expect(identifiers).toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});

describe('getWidgetToolIdentifiers()', () => {
    it('returns exactly the 4 *-widget identifiers, ascending', () => {
        const widgets = getWidgetToolIdentifiers();
        expect(widgets).toEqual([
            HELPER_TOOLS.ACTOR_CALL_WIDGET,
            HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
            HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET,
            HELPER_TOOLS.STORE_SEARCH_WIDGET,
        ]);
    });
});

describe('getDynamicToolIdentifiers()', () => {
    it('names exactly the 2 default direct-Actor tools', () => {
        expect(getDynamicToolIdentifiers()).toEqual(['apify--rag-web-browser', 'apify--web-fetch']);
    });
});

describe('deriveArgumentGroups()', () => {
    it('returns one group per top-level property, in schema order', () => {
        expect(
            deriveArgumentGroups({
                type: 'object',
                properties: { actor: { type: 'string' }, waitSecs: { type: 'integer' } },
            }),
        ).toEqual(['actor', 'waitSecs']);
    });

    it('expands a property with non-empty nested properties into parent.child groups, dropping the parent', () => {
        expect(
            deriveArgumentGroups({
                type: 'object',
                properties: {
                    actor: { type: 'string' },
                    output: {
                        type: 'object',
                        properties: { description: { type: 'boolean' }, stats: { type: 'boolean' } },
                    },
                },
            }),
        ).toEqual(['actor', 'output.description', 'output.stats']);
    });

    it('keeps a free-form/passthrough object (empty properties) as a single group', () => {
        expect(
            deriveArgumentGroups({
                type: 'object',
                properties: { input: { type: 'object', properties: {}, additionalProperties: true } },
            }),
        ).toEqual(['input']);
    });

    it('keeps a property with no properties key at all as a single group', () => {
        expect(deriveArgumentGroups({ type: 'object', properties: { message: { type: 'string' } } })).toEqual([
            'message',
        ]);
    });

    it('returns an empty array when the schema declares no properties', () => {
        expect(deriveArgumentGroups({ type: 'object' })).toEqual([]);
    });
});

describe('resolveReachableToolNames()', () => {
    it('includes the default categories, report-problem, and both default direct-Actor tools when tools is undefined', () => {
        const reachable = resolveReachableToolNames(undefined);
        expect(reachable.has('search-actors')).toBe(true); // actors category
        expect(reachable.has('search-apify-docs')).toBe(true); // docs category
        expect(reachable.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(true); // default-injected
        expect(reachable.has('apify--rag-web-browser')).toBe(true);
        expect(reachable.has('apify--web-fetch')).toBe(true);
        expect(reachable.has('get-actor-run')).toBe(true); // AUTO_INJECTED_TOOLS, call-actor present
        expect(reachable.has('get-actor-log')).toBe(false); // runs category not selected by default
    });

    it('serves only the selected category, and neither default direct-Actor tool, when tools is set', () => {
        const reachable = resolveReachableToolNames(['runs']);
        expect(reachable.has('get-actor-run')).toBe(true);
        expect(reachable.has('get-actor-log')).toBe(true);
        expect(reachable.has('search-actors')).toBe(false);
        expect(reachable.has('apify--rag-web-browser')).toBe(false);
        expect(reachable.has('apify--web-fetch')).toBe(false);
    });
});

function selectionCase(
    overrides: Partial<McpAgentTestCase> & Pick<McpAgentTestCase, 'id' | 'expectedTools'>,
): McpAgentTestCase {
    return {
        category: 'test',
        kind: 'selection',
        tier: ['pr'],
        query: 'q',
        ...overrides,
    };
}

function agentCase(overrides: Partial<McpAgentTestCase> & Pick<McpAgentTestCase, 'id'>): McpAgentTestCase {
    return {
        category: 'test',
        kind: 'agent',
        tier: ['full'],
        query: 'q',
        ...overrides,
    };
}

describe('buildCoverageMatrix()', () => {
    it('marks a tool covered from a selection case naming it, with 0 argument groups covered when expectedArgs is absent', () => {
        const matrix = buildCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })]);
        const row = requireMeasuredRow(matrix, 'search-actors');
        expect(row.status).toBe('covered');
        expect(row.prSelectionCaseCount).toBe(1);
        expect(row.coveredArgumentGroups).toEqual([]);
    });

    it('covers an argument group when a selection case pins it in expectedArgs', () => {
        const matrix = buildCoverageMatrix([
            selectionCase({ id: 's1', expectedTools: ['search-actors'], expectedArgs: { keywords: 'weather' } }),
        ]);
        const row = requireMeasuredRow(matrix, 'search-actors');
        expect(row.coveredArgumentGroups).toEqual(['keywords']);
    });

    it('a pinned parent object covers every one of its nested child groups', () => {
        const matrix = buildCoverageMatrix([
            selectionCase({
                id: 's1',
                expectedTools: ['call-actor'],
                expectedArgs: { callOptions: { memory: 256 } },
            }),
        ]);
        const row = requireMeasuredRow(matrix, 'call-actor');
        expect(row.coveredArgumentGroups).toEqual(
            expect.arrayContaining([
                'callOptions.memory',
                'callOptions.timeout',
                'callOptions.build',
                'callOptions.maxItems',
                'callOptions.maxTotalChargeUsd',
            ]),
        );
    });

    it('leaves a tool uncovered when it is only reachable via an agent case, never named by a selection case', () => {
        const matrix = buildCoverageMatrix([agentCase({ id: 'a1', tools: ['runs'], reference: 'ref' })]);
        const row = requireMeasuredRow(matrix, 'get-actor-log');
        expect(row.status).toBe('uncovered');
        expect(row.prSelectionCaseCount).toBe(0);
        expect(row.fullAgentReachableCount).toBeGreaterThan(0);
    });

    it('reports the 2 default direct-Actor tools as dynamic, excluded from argument-group totals', () => {
        const matrix = buildCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['apify--web-fetch'] })]);
        const row = requireRow(matrix, 'apify--web-fetch');
        expect(row.kind).toBe('dynamic');
        expect(row.status).toBe('covered');

        const summary = renderSummaryLines(matrix);
        expect(summary[1]).toContain('2 dynamic Actor tools not statically measurable');
    });

    it('never marks a widget row covered, regardless of dataset content', () => {
        const matrix = buildCoverageMatrix([
            selectionCase({ id: 's1', expectedTools: [HELPER_TOOLS.STORE_SEARCH_WIDGET] }),
        ]);
        const row = requireRow(matrix, HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(row.status).toBe('excluded');
    });

    it('folds in experiment-exercised argument groups alongside selection coverage', () => {
        const spans: ObservedToolSpan[] = [{ name: 'search-actors', input: JSON.stringify({ limit: 5 }) }];
        const matrix = buildCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })], {
            experimentId: 'exp1',
            spans,
            agentItemCount: 1,
        });
        const row = requireMeasuredRow(matrix, 'search-actors');
        expect(row.coveredArgumentGroups).toEqual(['limit']);
        expect(row.fullAgentExercisedCount).toBe(1);
    });

    it('renders "n/a", not "0", when the experiment carried zero kind: agent items', () => {
        const matrix = buildCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })], {
            experimentId: 'exp1',
            spans: [],
            agentItemCount: 0,
        });
        const row = requireMeasuredRow(matrix, 'search-actors');
        expect(row.fullAgentExercisedCount).toBeUndefined();
        expect(renderCoverageMatrixMarkdown(matrix)).toContain('| n/a |');
    });
});

describe('resolveOutputPlan()', () => {
    it('rejects --check combined with --experiment', () => {
        const plan = resolveOutputPlan({ check: true, experiment: 'exp1', out: undefined });
        expect(plan.kind).toBe('error');
    });

    it('--experiment alone (no --out) prints to stdout — never writes the committed file', () => {
        expect(resolveOutputPlan({ check: false, experiment: 'exp1', out: undefined })).toEqual({ kind: 'stdout' });
    });

    it('--experiment with --out writes to the given path', () => {
        expect(resolveOutputPlan({ check: false, experiment: 'exp1', out: 'somewhere.md' })).toEqual({
            kind: 'write',
            path: 'somewhere.md',
        });
    });

    it('with no flags, writes to the default committed path', () => {
        const plan = resolveOutputPlan({ check: false, experiment: undefined, out: undefined });
        expect(plan.kind).toBe('write');
        if (plan.kind === 'write') expect(plan.path).toMatch(/coverage_matrix\.md$/);
    });

    it('--check alone compares the default committed path', () => {
        const plan = resolveOutputPlan({ check: true, experiment: undefined, out: undefined });
        expect(plan.kind).toBe('check');
        if (plan.kind === 'check') expect(plan.path).toMatch(/coverage_matrix\.md$/);
    });

    it('--check with --out compares the given path instead', () => {
        expect(resolveOutputPlan({ check: true, experiment: undefined, out: 'somewhere.md' })).toEqual({
            kind: 'check',
            path: 'somewhere.md',
        });
    });
});

describe('renderSummaryLines() — agent-kind line', () => {
    it('no --experiment: says so, and how to fill it in', () => {
        const matrix = buildCoverageMatrix([]);
        expect(renderSummaryLines(matrix)[2]).toBe(
            'Agent kind (full tier): reachable only — no --experiment given, so no observed tool spans ' +
                '(pass --experiment <id> to fill in "exercised")',
        );
    });

    it('--experiment with zero kind: agent items: warns instead of claiming exercised coverage', () => {
        const matrix = buildCoverageMatrix([], { experimentId: 'exp1', spans: [], agentItemCount: 0 });
        expect(renderSummaryLines(matrix)[2]).toBe(
            '⚠️ --experiment "exp1" contains no items with `kind: agent` metadata — the exercised column stays n/a',
        );
    });

    it('--experiment with observed agent spans: reports the experiment id and span count', () => {
        const spans: ObservedToolSpan[] = [{ name: 'search-actors', input: '{}' }];
        const matrix = buildCoverageMatrix([], { experimentId: 'exp1', spans, agentItemCount: 1 });
        expect(renderSummaryLines(matrix)[2]).toBe(
            'Agent kind (full tier): reachable + exercised — experiment "exp1", 1 observed tool span(s)',
        );
    });
});

describe('--experiment env precondition', () => {
    it('findMissingEnvVars(LANGFUSE_ENV_VARS) lists all three when unset, the check main() runs only for --experiment', () => {
        const originalEnv = { ...process.env };
        delete process.env.LANGFUSE_PUBLIC_KEY;
        delete process.env.LANGFUSE_SECRET_KEY;
        delete process.env.LANGFUSE_BASE_URL;

        try {
            expect(findMissingEnvVars(LANGFUSE_ENV_VARS)).toEqual([...LANGFUSE_ENV_VARS]);
        } finally {
            process.env = originalEnv;
        }
    });

    it('reports nothing missing once all three are set', () => {
        const originalEnv = { ...process.env };
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
        process.env.LANGFUSE_BASE_URL = 'https://langfuse.example.com';

        try {
            expect(findMissingEnvVars(LANGFUSE_ENV_VARS)).toEqual([]);
        } finally {
            process.env = originalEnv;
        }
    });
});

describe('fetchExperimentToolObservations()', () => {
    /** Minimal fake Langfuse client: only the two `.api.*` methods this reader calls. */
    function fakeLangfuseClient(overrides: {
        listItems: (args: { cursor?: string; fromStartTime?: string; fields?: string }) => Promise<{
            data: { traceId: string; experimentItemMetadata?: Record<string, unknown> | null }[];
            meta: { cursor?: string };
        }>;
        getMany: (args: {
            traceId: string;
            cursor?: string;
        }) => Promise<{ data: { name?: string; input?: unknown; output?: unknown }[]; meta: { cursor?: string } }>;
    }) {
        return {
            api: {
                experiments: { listItems: overrides.listItems },
                observations: { getMany: overrides.getMany },
            },
        } as unknown as LangfuseClient;
    }

    it('propagates a rejection from the Langfuse client instead of swallowing it', async () => {
        const client = fakeLangfuseClient({
            listItems: () => Promise.reject(new Error('experiment not found')),
            getMany: () => Promise.resolve({ data: [], meta: {} }),
        });

        await expect(fetchExperimentToolObservations(client, 'bad-experiment-id')).rejects.toThrow(
            'experiment not found',
        );
    });

    it("paginates one trace's observations across multiple pages instead of dropping the rest", async () => {
        let getManyCallCount = 0;
        const client = fakeLangfuseClient({
            listItems: () =>
                Promise.resolve({
                    data: [{ traceId: 't1', experimentItemMetadata: { kind: 'agent' } }],
                    meta: {},
                }),
            getMany: ({ cursor }) => {
                getManyCallCount += 1;
                if (cursor === undefined) {
                    return Promise.resolve({
                        data: [{ name: 'search-actors', input: '{}' }],
                        meta: { cursor: 'page-2' },
                    });
                }
                return Promise.resolve({ data: [{ name: 'call-actor', input: '{}' }], meta: {} });
            },
        });

        const { spans } = await fetchExperimentToolObservations(client, 'exp1');

        expect(getManyCallCount).toBe(2);
        expect(spans.map((span) => span.name)).toEqual(['search-actors', 'call-actor']);
    });

    it('paginates the experiment-items listing across multiple pages', async () => {
        let listItemsCallCount = 0;
        const listItemsCalls: { cursor?: string; fromStartTime?: string; fields?: string }[] = [];
        const client = fakeLangfuseClient({
            listItems: ({ cursor, fromStartTime, fields }) => {
                listItemsCallCount += 1;
                listItemsCalls.push({ cursor, fromStartTime, fields });
                if (cursor === undefined) {
                    return Promise.resolve({
                        data: [{ traceId: 't1', experimentItemMetadata: { kind: 'agent' } }],
                        meta: { cursor: 'items-page-2' },
                    });
                }
                return Promise.resolve({
                    data: [{ traceId: 't2', experimentItemMetadata: { kind: 'agent' } }],
                    meta: {},
                });
            },
            getMany: ({ traceId }) =>
                Promise.resolve({ data: [{ name: `tool-for-${traceId}`, input: '{}' }], meta: {} }),
        });

        const { spans } = await fetchExperimentToolObservations(client, 'exp1');

        expect(listItemsCallCount).toBe(2);
        expect(spans.map((span) => span.name)).toEqual(['tool-for-t1', 'tool-for-t2']);
        // Regression guard: the API 500s (or silently returns 0 items) for a `fromStartTime` too close to the
        // epoch — see coverage_matrix.ts's EXPERIMENT_ITEMS_FROM_START_TIME comment. Assert every page requests
        // the same fixed lower bound and the item-metadata field group, not just the first.
        for (const call of listItemsCalls) {
            expect(call.fromStartTime).toBe('2000-01-01T00:00:00Z');
            expect(call.fields).toBe('core,itemMetadata');
        }
    });

    it('skips a TOOL observation whose output is the selection-mode denial text', async () => {
        const client = fakeLangfuseClient({
            listItems: () =>
                Promise.resolve({ data: [{ traceId: 't1', experimentItemMetadata: { kind: 'agent' } }], meta: {} }),
            getMany: () =>
                Promise.resolve({
                    data: [{ name: 'search-actors', input: '{}', output: SELECTION_DENY_REASON }],
                    meta: {},
                }),
        });

        const { spans, agentItemCount } = await fetchExperimentToolObservations(client, 'exp1');

        expect(spans).toEqual([]);
        expect(agentItemCount).toBe(1);
    });

    it('skips a kind: "selection" item entirely — no observations are even fetched for it', async () => {
        let getManyCallCount = 0;
        const client = fakeLangfuseClient({
            listItems: () =>
                Promise.resolve({
                    data: [{ traceId: 't1', experimentItemMetadata: { kind: 'selection' } }],
                    meta: {},
                }),
            getMany: () => {
                getManyCallCount += 1;
                return Promise.resolve({ data: [{ name: 'search-actors', input: '{}' }], meta: {} });
            },
        });

        const { spans, agentItemCount } = await fetchExperimentToolObservations(client, 'exp1');

        expect(getManyCallCount).toBe(0);
        expect(spans).toEqual([]);
        expect(agentItemCount).toBe(0);
    });

    it('counts agentItemCount as 0 when every item is kind: "selection" (a pr-tier experiment)', async () => {
        const client = fakeLangfuseClient({
            listItems: () =>
                Promise.resolve({
                    data: [
                        { traceId: 't1', experimentItemMetadata: { kind: 'selection' } },
                        { traceId: 't2', experimentItemMetadata: { kind: 'selection' } },
                    ],
                    meta: {},
                }),
            getMany: () => Promise.resolve({ data: [], meta: {} }),
        });

        const { agentItemCount } = await fetchExperimentToolObservations(client, 'exp1');

        expect(agentItemCount).toBe(0);
    });

    it('skips an item with no experimentItemMetadata at all — unknown is not agent, yields zero spans', async () => {
        let getManyCallCount = 0;
        const client = fakeLangfuseClient({
            listItems: () => Promise.resolve({ data: [{ traceId: 't1' }], meta: {} }),
            getMany: () => {
                getManyCallCount += 1;
                return Promise.resolve({ data: [{ name: 'search-actors', input: '{}' }], meta: {} });
            },
        });

        const { spans, agentItemCount } = await fetchExperimentToolObservations(client, 'exp1');

        expect(getManyCallCount).toBe(0);
        expect(spans).toEqual([]);
        expect(agentItemCount).toBe(0);
    });

    it('fetches observations for a kind: "agent" item', async () => {
        const client = fakeLangfuseClient({
            listItems: () =>
                Promise.resolve({
                    data: [{ traceId: 't1', experimentItemMetadata: { kind: 'agent' } }],
                    meta: {},
                }),
            getMany: () => Promise.resolve({ data: [{ name: 'search-actors', input: '{}' }], meta: {} }),
        });

        const { spans, agentItemCount } = await fetchExperimentToolObservations(client, 'exp1');

        expect(spans.map((span) => span.name)).toEqual(['search-actors']);
        expect(agentItemCount).toBe(1);
    });
});

describe('countExercisedSpans() / resolveExercisedArgumentGroups()', () => {
    const fixture = readJsonFile<ObservedToolSpan[]>(import.meta.url, './fixtures/evals_coverage_observations.json');

    it('counts observed spans by tool name from the captured fixture', () => {
        expect(countExercisedSpans(fixture, 'apify--web-fetch')).toBe(1);
        expect(countExercisedSpans(fixture, 'fetch-actor-details')).toBe(1);
        expect(countExercisedSpans(fixture, 'get-actor-run')).toBe(0);
    });

    it("derives exercised top-level and nested argument groups from a real captured span (a selection run's denial span, same name/input shape as an agent span)", () => {
        const groups = deriveArgumentGroups({
            type: 'object',
            properties: {
                actor: { type: 'string' },
                output: {
                    type: 'object',
                    properties: {
                        description: { type: 'boolean' },
                        pricing: { type: 'boolean' },
                        readme: { type: 'boolean' },
                    },
                },
            },
        });
        const exercised = resolveExercisedArgumentGroups(fixture, 'fetch-actor-details', groups);
        expect(exercised).toEqual(new Set(['actor', 'output.description', 'output.pricing']));
    });

    it('returns no exercised groups when no span matches the tool (empty result, not a crash)', () => {
        expect(countExercisedSpans([], 'search-actors')).toBe(0);
        expect(resolveExercisedArgumentGroups([], 'search-actors', ['keywords', 'limit'])).toEqual(new Set());
    });

    it('ignores a non-MCP tool span (e.g. ToolSearch) rather than crashing on it', () => {
        expect(countExercisedSpans(fixture, 'ToolSearch')).toBe(1);
        expect(countExercisedSpans(fixture, 'nonexistent-tool')).toBe(0);
    });

    it('treats a non-string input as unparseable — nothing exercised, no crash', () => {
        const spans: ObservedToolSpan[] = [{ name: 'search-actors', input: 123 }];
        expect(resolveExercisedArgumentGroups(spans, 'search-actors', ['keywords'])).toEqual(new Set());
    });

    it('treats malformed JSON as unparseable', () => {
        const spans: ObservedToolSpan[] = [{ name: 'search-actors', input: 'not json' }];
        expect(resolveExercisedArgumentGroups(spans, 'search-actors', ['keywords'])).toEqual(new Set());
    });

    it('treats valid JSON that is not an object (e.g. an array) as unparseable', () => {
        const spans: ObservedToolSpan[] = [{ name: 'search-actors', input: '[]' }];
        expect(resolveExercisedArgumentGroups(spans, 'search-actors', ['keywords'])).toEqual(new Set());
    });

    it('does not mark a nested group exercised when the parent key holds a scalar, not an object', () => {
        const spans: ObservedToolSpan[] = [{ name: 'call-actor', input: JSON.stringify({ callOptions: 'nope' }) }];
        expect(resolveExercisedArgumentGroups(spans, 'call-actor', ['callOptions.memory'])).toEqual(new Set());
    });
});

describe('renderCoverageMatrixMarkdown()', () => {
    it('is deterministic: the same input renders the same string twice', () => {
        const matrix = buildCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })]);
        expect(renderCoverageMatrixMarkdown(matrix)).toBe(renderCoverageMatrixMarkdown(matrix));
    });

    it('embeds a report-problem footnote and flags it uncovered when no case names it', () => {
        const rendered = renderCoverageMatrixMarkdown(buildCoverageMatrix([]));
        expect(rendered).toContain('`report-problem` is `uncovered` on purpose');
        expect(rendered).toMatch(/`report-problem`.*uncovered/);
    });
});

describe('freshness: the committed coverage_matrix.md matches a fresh regeneration', () => {
    it('byte-equals a matrix regenerated from the committed snapshot and the live registry', () => {
        const matrix = buildCoverageMatrix(readSnapshot());
        const regenerated = renderCoverageMatrixMarkdown(matrix);

        const committedPath = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../evals/mcp_agent/coverage_matrix.md',
        );
        const committed = fs.readFileSync(committedPath, 'utf-8');

        expect(regenerated, "coverage_matrix.md is stale — run 'pnpm run evals:coverage' and commit the result").toBe(
            committed,
        );
    });

    it('flags call-actor callOptions.* as uncovered and fetch-actor-details actor as covered (acceptance check)', () => {
        const matrix = buildCoverageMatrix(readSnapshot());
        const callActor = requireMeasuredRow(matrix, 'call-actor');
        const fetchDetails = requireMeasuredRow(matrix, 'fetch-actor-details');

        const uncoveredCallActor = callActor.argumentGroups.filter(
            (group) => !callActor.coveredArgumentGroups.includes(group),
        );
        expect(uncoveredCallActor).toEqual(expect.arrayContaining(['callOptions.memory', 'callOptions.timeout']));
        expect(fetchDetails.coveredArgumentGroups).toContain('actor');
    });

    it('the only uncovered non-widget, non-dynamic tool is the documented report-problem gap', () => {
        const matrix = buildCoverageMatrix(readSnapshot());
        const uncovered = matrix.rows.filter((r) => r.status === 'uncovered').map((r) => r.identifier);
        expect(uncovered).toEqual([HELPER_TOOLS.PROBLEM_REPORT]);
    });
});
