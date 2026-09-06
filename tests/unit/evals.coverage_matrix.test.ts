import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
    computeCoverageMatrix,
    computeDynamicToolIdentifiers,
    computeExercisedArgumentGroups,
    computeInScopeToolIdentifiers,
    computeReachableToolNames,
    computeWidgetToolIdentifiers,
    countExercisedSpans,
    deriveArgumentGroups,
    type ObservedToolSpan,
    readSnapshot,
    renderCoverageMatrixMarkdown,
    renderSummaryLines,
} from '../../evals/mcp_agent/coverage_matrix.js';
import type { McpAgentTestCase } from '../../evals/mcp_agent/langfuse_dataset.js';
import { HELPER_TOOLS } from '../../src/const.js';
import { readJsonFile } from '../../src/utils/generic.js';

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

describe('computeInScopeToolIdentifiers()', () => {
    it('returns exactly 25 identifiers, ascending, no widgets, no retired names', () => {
        const identifiers = computeInScopeToolIdentifiers();
        expect(identifiers).toHaveLength(25);
        expect(identifiers).toEqual([...identifiers].sort((a, b) => a.localeCompare(b)));
        expect(identifiers.some((name) => name.endsWith('-widget'))).toBe(false);
        expect(identifiers).toContain('apify--rag-web-browser');
        expect(identifiers).toContain('apify--web-fetch');
        expect(identifiers).toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});

describe('computeWidgetToolIdentifiers()', () => {
    it('returns exactly the 4 *-widget identifiers, ascending', () => {
        const widgets = computeWidgetToolIdentifiers();
        expect(widgets).toEqual([
            HELPER_TOOLS.ACTOR_CALL_WIDGET,
            HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET,
            HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET,
            HELPER_TOOLS.STORE_SEARCH_WIDGET,
        ]);
    });
});

describe('computeDynamicToolIdentifiers()', () => {
    it('names exactly the 2 default direct-Actor tools', () => {
        expect(computeDynamicToolIdentifiers()).toEqual(['apify--rag-web-browser', 'apify--web-fetch']);
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

describe('computeReachableToolNames()', () => {
    it('includes the default categories, report-problem, and both default direct-Actor tools when tools is undefined', () => {
        const reachable = computeReachableToolNames(undefined);
        expect(reachable.has('search-actors')).toBe(true); // actors category
        expect(reachable.has('search-apify-docs')).toBe(true); // docs category
        expect(reachable.has(HELPER_TOOLS.PROBLEM_REPORT)).toBe(true); // default-injected
        expect(reachable.has('apify--rag-web-browser')).toBe(true);
        expect(reachable.has('apify--web-fetch')).toBe(true);
        expect(reachable.has('get-actor-run')).toBe(true); // AUTO_INJECTED_TOOLS, call-actor present
        expect(reachable.has('get-actor-log')).toBe(false); // runs category not selected by default
    });

    it('serves only the selected category, and neither default direct-Actor tool, when tools is set', () => {
        const reachable = computeReachableToolNames(['runs']);
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

describe('computeCoverageMatrix()', () => {
    it('marks a tool covered from a selection case naming it, with 0 argument groups covered when expectedArgs is absent', () => {
        const matrix = computeCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })]);
        const row = matrix.rows.find((r) => r.identifier === 'search-actors');
        expect(row?.status).toBe('covered');
        expect(row?.prSelectionCaseCount).toBe(1);
        expect(row?.coveredArgumentGroups).toEqual([]);
    });

    it('covers an argument group when a selection case pins it in expectedArgs', () => {
        const matrix = computeCoverageMatrix([
            selectionCase({ id: 's1', expectedTools: ['search-actors'], expectedArgs: { keywords: 'weather' } }),
        ]);
        const row = matrix.rows.find((r) => r.identifier === 'search-actors');
        expect(row?.coveredArgumentGroups).toEqual(['keywords']);
    });

    it('a pinned parent object covers every one of its nested child groups', () => {
        const matrix = computeCoverageMatrix([
            selectionCase({
                id: 's1',
                expectedTools: ['call-actor'],
                expectedArgs: { callOptions: { memory: 256 } },
            }),
        ]);
        const row = matrix.rows.find((r) => r.identifier === 'call-actor');
        expect(row?.coveredArgumentGroups).toEqual(
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
        const matrix = computeCoverageMatrix([agentCase({ id: 'a1', tools: ['runs'], reference: 'ref' })]);
        const row = matrix.rows.find((r) => r.identifier === 'get-actor-log');
        expect(row?.status).toBe('uncovered');
        expect(row?.prSelectionCaseCount).toBe(0);
        expect(row?.fullAgentReachableCount).toBeGreaterThan(0);
    });

    it('reports the 2 default direct-Actor tools as dynamic, excluded from argument-group totals', () => {
        const matrix = computeCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['apify--web-fetch'] })]);
        const row = matrix.rows.find((r) => r.identifier === 'apify--web-fetch');
        expect(row?.argumentGroups).toBe('dynamic');
        expect(row?.status).toBe('covered');

        const summary = renderSummaryLines(matrix);
        expect(summary[1]).toContain('2 dynamic Actor tools not statically measurable');
    });

    it('never marks a widget row covered, regardless of dataset content', () => {
        const matrix = computeCoverageMatrix([
            selectionCase({ id: 's1', expectedTools: [HELPER_TOOLS.STORE_SEARCH_WIDGET] }),
        ]);
        const row = matrix.rows.find((r) => r.identifier === HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(row?.status).toBe('excluded');
    });

    it('folds in experiment-exercised argument groups alongside selection coverage', () => {
        const spans: ObservedToolSpan[] = [{ name: 'search-actors', input: JSON.stringify({ limit: 5 }) }];
        const matrix = computeCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })], {
            experimentId: 'exp1',
            spans,
        });
        const row = matrix.rows.find((r) => r.identifier === 'search-actors');
        expect(row?.coveredArgumentGroups).toEqual(['limit']);
        expect(row?.fullAgentExercisedCount).toBe(1);
    });
});

describe('countExercisedSpans() / computeExercisedArgumentGroups()', () => {
    const fixture = readJsonFile<ObservedToolSpan[]>(import.meta.url, './fixtures/evals_coverage_observations.json');

    it('counts observed spans by tool name from the captured fixture', () => {
        expect(countExercisedSpans(fixture, 'apify--web-fetch')).toBe(1);
        expect(countExercisedSpans(fixture, 'fetch-actor-details')).toBe(1);
        expect(countExercisedSpans(fixture, 'get-actor-run')).toBe(0);
    });

    it('derives exercised top-level and nested argument groups from a real captured span', () => {
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
        const exercised = computeExercisedArgumentGroups(fixture, 'fetch-actor-details', groups);
        expect(exercised).toEqual(new Set(['actor', 'output.description', 'output.pricing']));
    });

    it('returns no exercised groups when no span matches the tool (empty result, not a crash)', () => {
        expect(countExercisedSpans([], 'search-actors')).toBe(0);
        expect(computeExercisedArgumentGroups([], 'search-actors', ['keywords', 'limit'])).toEqual(new Set());
    });

    it('ignores a non-MCP tool span (e.g. ToolSearch) rather than crashing on it', () => {
        expect(countExercisedSpans(fixture, 'ToolSearch')).toBe(1);
        expect(countExercisedSpans(fixture, 'nonexistent-tool')).toBe(0);
    });
});

describe('renderCoverageMatrixMarkdown()', () => {
    it('is deterministic: the same input renders the same string twice', () => {
        const matrix = computeCoverageMatrix([selectionCase({ id: 's1', expectedTools: ['search-actors'] })]);
        expect(renderCoverageMatrixMarkdown(matrix)).toBe(renderCoverageMatrixMarkdown(matrix));
    });

    it('embeds a report-problem footnote and flags it uncovered when no case names it', () => {
        const rendered = renderCoverageMatrixMarkdown(computeCoverageMatrix([]));
        expect(rendered).toContain('`report-problem` is `uncovered` on purpose');
        expect(rendered).toMatch(/`report-problem`.*uncovered/);
    });
});

describe('freshness: the committed coverage_matrix.md matches a fresh regeneration', () => {
    it('byte-equals a matrix regenerated from the committed snapshot and the live registry', () => {
        const matrix = computeCoverageMatrix(readSnapshot());
        const regenerated = renderCoverageMatrixMarkdown(matrix);

        const committedPath = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../evals/mcp_agent/coverage_matrix.md',
        );
        const committed = fs.readFileSync(committedPath, 'utf-8');

        expect(regenerated).toBe(committed);
    });

    it('flags call-actor callOptions.* as uncovered and fetch-actor-details actor as covered (acceptance check)', () => {
        const matrix = computeCoverageMatrix(readSnapshot());
        const callActor = matrix.rows.find((r) => r.identifier === 'call-actor');
        const fetchDetails = matrix.rows.find((r) => r.identifier === 'fetch-actor-details');

        expect(callActor?.argumentGroups).not.toBe('dynamic');
        if (callActor?.argumentGroups !== 'dynamic') {
            const uncoveredCallActor = (callActor?.argumentGroups ?? []).filter(
                (group) => !(callActor?.coveredArgumentGroups ?? []).includes(group),
            );
            expect(uncoveredCallActor).toEqual(expect.arrayContaining(['callOptions.memory', 'callOptions.timeout']));
        }
        expect(fetchDetails?.coveredArgumentGroups).toContain('actor');
    });

    it('the only uncovered non-widget, non-dynamic tool is the documented report-problem gap', () => {
        const matrix = computeCoverageMatrix(readSnapshot());
        const uncovered = matrix.rows.filter((r) => r.status === 'uncovered').map((r) => r.identifier);
        expect(uncovered).toEqual([HELPER_TOOLS.PROBLEM_REPORT]);
    });
});
