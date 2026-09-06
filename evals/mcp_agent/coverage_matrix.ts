#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * `evals:coverage` — apify/ai-team#265.
 *
 * Measures, and prints/commits as `coverage_matrix.md`, which tools and which argument groups
 * the `mcp-server-evals` dataset actually exercises. Two offline inputs only: the live tool
 * registry (`src/tools/**`) and the committed dataset snapshot
 * (`dataset_snapshot_mcp-server-evals.json`). No network, no env vars, no timestamps — the same
 * inputs always produce the same file, byte for byte.
 *
 * Three coverage dimensions, kept separate rather than folded into one number:
 * - **`pr` selection cases** — how many `kind: "selection"` items name this tool in
 *   `expectedTools`. This is what "covered" / "uncovered" means for the Status column.
 * - **`full` agent reachable** — across `kind: "agent"` items, how many would even serve this
 *   tool (via `metadata.tools` selectors, or the default categories when absent), computed with
 *   the server's own `getToolsForServerMode` resolver. Informational only — a tool being
 *   *reachable* is not the same as it being *called*, so this never counts as coverage.
 * - **`full` agent exercised** — how many observed tool spans of a real full-tier experiment
 *   actually called this tool. Reads `n/a` by default (no full-tier experiment has ever run
 *   against this dataset); filled in only when `--experiment <id>` points at one.
 *
 * Argument groups come mechanically from each tool's `inputSchema` (already JSON Schema): one
 * group per top-level property, expanded one level into `parent.child` groups when a property's
 * own schema carries a non-empty `properties` object (e.g. `call-actor`'s `callOptions` becomes
 * `callOptions.memory`, `callOptions.timeout`, ...). A free-form/passthrough object (e.g.
 * `call-actor`'s `input`) has no declared `properties`, so it stays one group, by construction.
 * The two default direct-Actor tools (`apify--rag-web-browser`, `apify--web-fetch`) build their
 * schema at runtime from the live Actor definition — nothing to read offline — so their argument
 * cell reads `dynamic` and they are excluded from the argument-group totals.
 *
 * An argument group is `covered` when some `pr`-tier selection case's `expectedArgs` pins that
 * key (a pinned parent object counts as covering every `parent.*` child, since the runner's
 * check deep-equals the whole object) — or, with `--experiment <id>`, when an observed tool span
 * actually sent that key (nested groups: the child key was present inside the parent's own sent
 * value).
 *
 * Usage:
 *   pnpm run evals:coverage                    # regenerate and write coverage_matrix.md
 *   pnpm run evals:coverage -- --check         # compare in memory; exit 1 if stale, no write
 *   pnpm run evals:coverage -- --experiment <id>   # also fill in "exercised" from observed spans
 */

// Must be the first import: config modules read process.env at load time. Loading dotenv here
// only populates process.env from a `.env` file if one exists — it does not read any variable
// itself, so the default (no `--experiment`) run's behavior is unchanged.
import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';

import { defaults, HELPER_TOOLS, RAG_WEB_BROWSER, RETIRED_SELECTOR_NAMES, WEB_FETCH } from '../../src/const.js';
import { actorNameToToolName } from '../../src/tools/actor_tool_naming.js';
import { CATEGORY_NAMES, getCategoryTools } from '../../src/tools/index.js';
import type { ActorTool, Input, ToolCategory, ToolEntry, ToolInputSchema } from '../../src/types.js';
import { SERVER_MODE, TOOL_TYPE } from '../../src/types.js';
import { compileSchema } from '../../src/utils/ajv.js';
import { readJsonFile } from '../../src/utils/generic.js';
import { getToolsForServerMode } from '../../src/utils/tools_loader.js';
import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';
import type { McpAgentTestCase } from './langfuse_dataset.js';

/** Name of the committed dataset snapshot this script reads (mirrors `MCP_AGENT_DATASET_NAME`). */
const SNAPSHOT_FILE_NAME = 'dataset_snapshot_mcp-server-evals.json';

/** Resolved from this module so cwd cannot change it. */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_PATH = path.join(SCRIPT_DIR, 'coverage_matrix.md');

/** Pseudo-category label for the two default direct-Actor tools, which aren't in `toolCategories`. */
const ACTOR_CATEGORY_LABEL = 'actor';
/** Category label for the 4 `*-widget` rows. */
const WIDGET_CATEGORY_LABEL = 'widgets';

// ---------------------------------------------------------------------------------------------
// Tool identifier enumeration
// ---------------------------------------------------------------------------------------------

/** The 25 in-scope tool identifiers: non-widget, non-retired `HELPER_TOOLS` plus the 2 default direct-Actor tools. */
export function resolveInScopeToolIdentifiers(): string[] {
    const helperToolNames = Object.values(HELPER_TOOLS).filter(
        (name) => !name.endsWith('-widget') && !RETIRED_SELECTOR_NAMES.has(name),
    );
    const defaultActorToolNames = defaults.actors.map((actorName) => actorNameToToolName(actorName));
    return [...helperToolNames, ...defaultActorToolNames].sort((a, b) => a.localeCompare(b));
}

/** The 4 `*-widget` tool identifiers — excluded rows, never counted as covered. */
export function getWidgetToolIdentifiers(): string[] {
    return Object.values(HELPER_TOOLS)
        .filter((name) => name.endsWith('-widget'))
        .sort((a, b) => a.localeCompare(b));
}

/** Identifiers of the 2 tools whose schema is built at runtime from a live Actor definition. */
export function getDynamicToolIdentifiers(): string[] {
    return defaults.actors.map((actorName) => actorNameToToolName(actorName)).sort((a, b) => a.localeCompare(b));
}

/** Map every non-widget `HELPER_TOOLS` identifier to the `toolCategories` key it lives in. */
function buildCategoryByHelperToolName(): Map<string, ToolCategory> {
    const categories = getCategoryTools(SERVER_MODE.DEFAULT);
    const map = new Map<string, ToolCategory>();
    for (const categoryName of CATEGORY_NAMES) {
        for (const tool of categories[categoryName]) {
            map.set(tool.name, categoryName);
        }
    }
    return map;
}

/** Category label for an in-scope tool identifier: its `toolCategories` key, or the actor pseudo-category. */
function categoryForToolIdentifier(
    identifier: string,
    categoryByHelperToolName: ReadonlyMap<string, ToolCategory>,
): string {
    return categoryByHelperToolName.get(identifier) ?? ACTOR_CATEGORY_LABEL;
}

// ---------------------------------------------------------------------------------------------
// Argument-group derivation
// ---------------------------------------------------------------------------------------------

/** The only shape read off a JSON Schema property node: does it declare its own nested properties? */
const objectSchemaNodeSchema = z.object({ properties: z.record(z.string(), z.unknown()).optional() });

/**
 * Argument groups for one tool's input schema: one per top-level property, expanded one level
 * into `parent.child` when the property's own schema carries a non-empty `properties` object.
 * A free-form/passthrough object (empty or absent `properties`) stays a single group. Order
 * follows the schema's own declared property order (stable across runs, since it's the same
 * schema every time) — not re-sorted, so it reads in the tool's own field order.
 */
export function deriveArgumentGroups(inputSchema: ToolInputSchema): string[] {
    const groups: string[] = [];
    const topLevelProperties = inputSchema.properties ?? {};
    for (const [name, node] of Object.entries(topLevelProperties)) {
        const parsed = objectSchemaNodeSchema.safeParse(node);
        const nestedProperties = parsed.success ? parsed.data.properties : undefined;
        if (nestedProperties !== undefined && Object.keys(nestedProperties).length > 0) {
            for (const childName of Object.keys(nestedProperties)) {
                groups.push(`${name}.${childName}`);
            }
        } else {
            groups.push(name);
        }
    }
    return groups;
}

// ---------------------------------------------------------------------------------------------
// Agent reachability (informational — never coverage)
// ---------------------------------------------------------------------------------------------

/**
 * Minimal, fully-typed `ActorTool` stand-in for the 2 default direct-Actor tools, used only to
 * make them appear in `getToolsForServerMode`'s output when they'd be loaded by default. Their
 * real `inputSchema` is built at runtime from the live Actor definition (see module docstring) —
 * irrelevant here since reachability only reads `.name`.
 */
function buildDefaultActorToolStub(actorFullName: string): ActorTool {
    const inputSchema: ToolInputSchema = { type: 'object', properties: {} };
    return {
        name: actorNameToToolName(actorFullName),
        inputSchema,
        ajvValidate: compileSchema(inputSchema),
        type: TOOL_TYPE.ACTOR,
        actorId: actorFullName,
        actorFullName,
    };
}

/**
 * The 2 default direct-Actor tools are loaded whenever a case doesn't set `tools` at all — see
 * `resolveActorsToLoad` in `tools_loader.ts` (not exported): with no selectors, the defaults
 * apply; with selectors set, only selectors that are themselves Actor names load Actor tools, and
 * no case in this dataset ever selects one by name. That one condition — `tools === undefined` —
 * is therefore the whole rule for this dataset; it is not a general reimplementation of
 * `resolveActorsToLoad`.
 */
function actorStubsForReachability(tools: readonly string[] | undefined): ToolEntry[] {
    if (tools !== undefined) return [];
    return [buildDefaultActorToolStub(RAG_WEB_BROWSER), buildDefaultActorToolStub(WEB_FETCH)];
}

/** Tool names served to one `kind: "agent"` case, per the server's own tool-loading resolver. */
export function resolveReachableToolNames(tools: readonly string[] | undefined): Set<string> {
    const input: Input = tools === undefined ? {} : { tools: [...tools] };
    const resolved = getToolsForServerMode(input, actorStubsForReachability(tools), SERVER_MODE.DEFAULT);
    return new Set(resolved.map((tool) => tool.name));
}

/** How many `kind: "agent"` cases would serve each tool name, across the whole snapshot. */
function resolveReachableCounts(agentCases: readonly McpAgentTestCase[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const testCase of agentCases) {
        for (const name of resolveReachableToolNames(testCase.tools)) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    return counts;
}

// ---------------------------------------------------------------------------------------------
// `--experiment <id>` observed-span reader
// ---------------------------------------------------------------------------------------------

/** One `type: "TOOL"` observation, reduced to what coverage attribution needs. */
export type ObservedToolSpan = {
    name: string;
    /** Raw `input` field as the API returns it — a JSON string, or absent/malformed. */
    input: unknown;
};

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** Parse an observation's `input` (a JSON string) into a plain object, or `undefined` if it isn't one. */
function parseObservedInput(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== 'string') return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    const result = jsonObjectSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
}

/** How many observed spans named this tool, across the fetched experiment. */
export function countExercisedSpans(spans: readonly ObservedToolSpan[], toolIdentifier: string): number {
    return spans.filter((span) => span.name === toolIdentifier).length;
}

/**
 * Which of a tool's argument groups an observed span actually sent: a plain group is exercised if
 * present as a top-level key on any matching span's input; a nested `parent.child` group is
 * exercised if `parent` was sent and its own value carried `child`.
 */
export function resolveExercisedArgumentGroups(
    spans: readonly ObservedToolSpan[],
    toolIdentifier: string,
    argumentGroups: readonly string[],
): Set<string> {
    const inputs = spans
        .filter((span) => span.name === toolIdentifier)
        .map((span) => parseObservedInput(span.input))
        .filter((input): input is Record<string, unknown> => input !== undefined);

    const exercised = new Set<string>();
    for (const group of argumentGroups) {
        const dotIndex = group.indexOf('.');
        const parentKey = dotIndex === -1 ? group : group.slice(0, dotIndex);
        const childKey = dotIndex === -1 ? undefined : group.slice(dotIndex + 1);
        for (const input of inputs) {
            if (childKey === undefined) {
                if (parentKey in input) {
                    exercised.add(group);
                    break;
                }
            } else {
                const parentValue = input[parentKey];
                if (typeof parentValue === 'object' && parentValue !== null && childKey in parentValue) {
                    exercised.add(group);
                    break;
                }
            }
        }
    }
    return exercised;
}

/**
 * Network glue for `--experiment <id>`: list the experiment's dataset-item traces, then fetch
 * each trace's `TOOL`-type observations, paginating both the experiment-items listing and each
 * trace's own observations page the same way (loop on `meta.cursor` until absent). Exercised in
 * tests against fake `LangfuseClient` objects (rejection propagation, multi-page observations) —
 * not against a real experiment, since no full-tier run has ever happened against
 * `mcp-server-evals`; `countExercisedSpans` and `resolveExercisedArgumentGroups` above are the
 * pure half of this feature, tested against a captured fixture.
 */
export async function fetchExperimentToolObservations(
    langfuse: LangfuseClient,
    experimentId: string,
): Promise<ObservedToolSpan[]> {
    const spans: ObservedToolSpan[] = [];
    let itemsCursor: string | undefined;
    do {
        const page = await langfuse.api.experiments.listItems({
            experimentId,
            fromStartTime: '1970-01-01T00:00:00Z',
            cursor: itemsCursor,
        });
        for (const item of page.data) {
            let observationsCursor: string | undefined;
            do {
                const observations = await langfuse.api.observations.getMany({
                    traceId: item.traceId,
                    type: 'TOOL',
                    fields: 'basic,io',
                    cursor: observationsCursor,
                });
                for (const observation of observations.data) {
                    if (observation.name) spans.push({ name: observation.name, input: observation.input });
                }
                observationsCursor = observations.meta.cursor ?? undefined;
            } while (observationsCursor !== undefined);
        }
        itemsCursor = page.meta.cursor ?? undefined;
    } while (itemsCursor !== undefined);
    return spans;
}

// ---------------------------------------------------------------------------------------------
// Coverage attribution + matrix model
// ---------------------------------------------------------------------------------------------

type ToolStatus = 'covered' | 'uncovered' | 'excluded';

export type CoverageMatrixRow = {
    identifier: string;
    category: string;
    /** `undefined` for excluded (widget) rows: nothing to count. */
    prSelectionCaseCount?: number;
    fullAgentReachableCount?: number;
    /** `undefined` when no `--experiment` was given; otherwise the observed-span count. */
    fullAgentExercisedCount?: number;
    /** `'dynamic'` for the 2 default direct-Actor tools; `undefined` for excluded rows. */
    argumentGroups?: readonly string[] | 'dynamic';
    coveredArgumentGroups?: readonly string[];
    status: ToolStatus;
};

export type CoverageMatrix = {
    rows: readonly CoverageMatrixRow[];
    selectionCaseCount: number;
    agentCaseCount: number;
    experimentId?: string;
    experimentSpanCount?: number;
};

/** A `pr`-tier selection case whose `expectedTools` includes `identifier`. */
function selectionCasesFor(identifier: string, selectionCases: readonly McpAgentTestCase[]): McpAgentTestCase[] {
    return selectionCases.filter((testCase) => (testCase.expectedTools ?? []).includes(identifier));
}

/** Whether some selection case naming `identifier` pins `argumentGroup` (or its dotted parent) in `expectedArgs`. */
function isArgumentGroupCoveredBySelection(
    argumentGroup: string,
    matchingSelectionCases: readonly McpAgentTestCase[],
): boolean {
    const dotIndex = argumentGroup.indexOf('.');
    const parentKey = dotIndex === -1 ? argumentGroup : argumentGroup.slice(0, dotIndex);
    return matchingSelectionCases.some(
        (testCase) =>
            testCase.expectedArgs !== undefined &&
            Object.prototype.hasOwnProperty.call(testCase.expectedArgs, parentKey),
    );
}

/** Build the full coverage matrix from the dataset snapshot and (optionally) observed experiment spans. */
export function buildCoverageMatrix(
    snapshot: readonly McpAgentTestCase[],
    experiment?: { experimentId: string; spans: readonly ObservedToolSpan[] },
): CoverageMatrix {
    const selectionCases = snapshot.filter((testCase) => testCase.kind === 'selection');
    const agentCases = snapshot.filter((testCase) => testCase.kind === 'agent');
    const reachableCounts = resolveReachableCounts(agentCases);
    const categoryByHelperToolName = buildCategoryByHelperToolName();
    const dynamicToolIdentifiers = new Set(getDynamicToolIdentifiers());
    const categories = getCategoryTools(SERVER_MODE.DEFAULT);
    const toolByName = new Map<string, ToolEntry>();
    for (const categoryName of CATEGORY_NAMES) {
        for (const tool of categories[categoryName]) toolByName.set(tool.name, tool);
    }

    const rows: CoverageMatrixRow[] = [];

    for (const identifier of resolveInScopeToolIdentifiers()) {
        const matchingSelectionCases = selectionCasesFor(identifier, selectionCases);
        const isCovered = matchingSelectionCases.length > 0;
        const isDynamic = dynamicToolIdentifiers.has(identifier);

        let argumentGroups: readonly string[] | 'dynamic' = 'dynamic';
        let coveredArgumentGroups: string[] = [];
        if (!isDynamic) {
            const tool = toolByName.get(identifier);
            const groups = tool === undefined ? [] : deriveArgumentGroups(tool.inputSchema);
            argumentGroups = groups;
            const exercisedGroups = experiment
                ? resolveExercisedArgumentGroups(experiment.spans, identifier, groups)
                : new Set<string>();
            coveredArgumentGroups = groups.filter(
                (group) =>
                    isArgumentGroupCoveredBySelection(group, matchingSelectionCases) || exercisedGroups.has(group),
            );
        }

        rows.push({
            identifier,
            category: categoryForToolIdentifier(identifier, categoryByHelperToolName),
            prSelectionCaseCount: matchingSelectionCases.length,
            fullAgentReachableCount: reachableCounts.get(identifier) ?? 0,
            fullAgentExercisedCount: experiment ? countExercisedSpans(experiment.spans, identifier) : undefined,
            argumentGroups,
            coveredArgumentGroups,
            status: isCovered ? 'covered' : 'uncovered',
        });
    }

    for (const identifier of getWidgetToolIdentifiers()) {
        rows.push({
            identifier,
            category: WIDGET_CATEGORY_LABEL,
            status: 'excluded',
        });
    }

    return {
        rows,
        selectionCaseCount: selectionCases.length,
        agentCaseCount: agentCases.length,
        experimentId: experiment?.experimentId,
        experimentSpanCount: experiment?.spans.length,
    };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const REPORT_PROBLEM_FOOTNOTE =
    '`report-problem` is `uncovered` on purpose, not by omission: apify/ai-team#240 authored and calibrated a ' +
    '`report-problem` selection case and 3 separate query rewrites, each verified 3x on `claude-opus-5` — every ' +
    'attempt either spent the fixed 2-turn selection budget without calling any tool, or investigated instead ' +
    '(e.g. called `search-actors`). This is structural: no single-turn query makes `report-problem` the first call ' +
    'within `SELECTION_MAX_TURNS`, and fixing it means touching that constant or the tool description — both out ' +
    "of scope here. See `tests/unit/evals.port_selection_cases.test.ts`'s `KNOWN_UNCOVERED_TOOL_IDENTIFIERS`.";

const DYNAMIC_TOOLS_FOOTNOTE =
    '`apify--rag-web-browser` and `apify--web-fetch` argument groups read `dynamic`: their `inputSchema` is built ' +
    "at runtime from the live Actor's own input schema (`actor_tools_factory.ts`), not from a schema in this " +
    'repo, so they cannot be measured offline. They are excluded from the argument-group totals below, not ' +
    'silently scored zero.';

function padLabel(label: string): string {
    return label.padEnd(17);
}

function formatArgumentGroupsCell(row: CoverageMatrixRow): string {
    if (row.status === 'excluded') return '—';
    if (row.argumentGroups === 'dynamic') return 'dynamic';
    const total = row.argumentGroups?.length ?? 0;
    const covered = row.coveredArgumentGroups?.length ?? 0;
    return `${covered}/${total}`;
}

function formatUncoveredArgumentGroupsCell(row: CoverageMatrixRow): string {
    if (row.status === 'excluded' || row.argumentGroups === 'dynamic' || row.argumentGroups === undefined) return '—';
    const covered = new Set(row.coveredArgumentGroups ?? []);
    const uncovered = row.argumentGroups.filter((group) => !covered.has(group));
    return uncovered.length > 0 ? uncovered.join(', ') : '—';
}

function formatCountCell(count: number | undefined): string {
    return count === undefined ? '—' : String(count);
}

function formatExercisedCell(row: CoverageMatrixRow): string {
    if (row.status === 'excluded') return '—';
    return row.fullAgentExercisedCount === undefined ? 'n/a' : String(row.fullAgentExercisedCount);
}

/** Summary lines: printed to the console every run, and embedded verbatim at the top of the committed file. */
export function renderSummaryLines(matrix: CoverageMatrix): string[] {
    const nonWidgetRows = matrix.rows.filter((row) => row.status !== 'excluded');
    const coveredTools = nonWidgetRows.filter((row) => row.status === 'covered');
    const uncoveredTools = nonWidgetRows.filter((row) => row.status === 'uncovered');
    const excludedTools = matrix.rows.filter((row) => row.status === 'excluded');

    const measurableRows = nonWidgetRows.filter((row) => row.argumentGroups !== 'dynamic');
    const totalGroups = measurableRows.reduce((sum, row) => sum + (row.argumentGroups?.length ?? 0), 0);
    const coveredGroups = measurableRows.reduce((sum, row) => sum + (row.coveredArgumentGroups?.length ?? 0), 0);
    const dynamicToolCount = nonWidgetRows.length - measurableRows.length;

    const agentKindLine =
        matrix.experimentId === undefined
            ? 'Agent kind (full tier): reachable only — no full-tier experiment has run, so no observed tool spans'
            : matrix.experimentSpanCount === 0
              ? `Agent kind (full tier): reachable only — experiment "${matrix.experimentId}" returned no observed tool spans`
              : `Agent kind (full tier): reachable + exercised — experiment "${matrix.experimentId}", ${matrix.experimentSpanCount} observed tool span(s)`;

    return [
        `${padLabel('Tools:')}${coveredTools.length} covered, ${uncoveredTools.length} uncovered, ${excludedTools.length} excluded (widgets) — ${nonWidgetRows.length} in scope`,
        `${padLabel('Argument groups:')}${coveredGroups} covered, ${totalGroups - coveredGroups} uncovered — ${totalGroups} in scope (${dynamicToolCount} dynamic Actor tool${dynamicToolCount === 1 ? '' : 's'} not statically measurable)`,
        agentKindLine,
        `Uncovered tools: ${uncoveredTools.length > 0 ? uncoveredTools.map((row) => row.identifier).join(', ') : 'none'}`,
        `Source: ${matrix.selectionCaseCount} selection + ${matrix.agentCaseCount} agent cases in ${SNAPSHOT_FILE_NAME}`,
    ];
}

function renderTable(matrix: CoverageMatrix): string {
    const header =
        '| Tool | Category | pr selection cases | full agent reachable | full agent exercised | Arg groups | Uncovered argument groups | Status |';
    const divider = '|---|---|---|---|---|---|---|---|';
    const rows = matrix.rows.map((row) => {
        const cells = [
            `\`${row.identifier}\``,
            row.category,
            formatCountCell(row.prSelectionCaseCount),
            formatCountCell(row.fullAgentReachableCount),
            formatExercisedCell(row),
            formatArgumentGroupsCell(row),
            formatUncoveredArgumentGroupsCell(row),
            row.status,
        ];
        return `| ${cells.join(' | ')} |`;
    });
    return [header, divider, ...rows].join('\n');
}

/** Deterministic Markdown for the committed file: no timestamps, stable row order (tool name ascending, widgets last). */
export function renderCoverageMatrixMarkdown(matrix: CoverageMatrix): string {
    const lines = [
        '# MCP tool + argument coverage matrix',
        '',
        `Generated by \`pnpm run evals:coverage\` from \`${SNAPSHOT_FILE_NAME}\` and the live tool registry — see ` +
            '`evals/mcp_agent/coverage_matrix.ts`. Do not edit by hand; regenerate and commit.',
        '',
        '```',
        ...renderSummaryLines(matrix),
        '```',
        '',
        renderTable(matrix),
        '',
        '## Notes',
        '',
        `- ${REPORT_PROBLEM_FOOTNOTE}`,
        `- ${DYNAMIC_TOOLS_FOOTNOTE}`,
        '',
    ];
    return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

/** The committed dataset snapshot this script measures coverage against. */
export function readSnapshot(): McpAgentTestCase[] {
    return readJsonFile<McpAgentTestCase[]>(import.meta.url, SNAPSHOT_FILE_NAME);
}

async function main() {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores
    // every flag behind it. Drop it so both call styles work.
    const args = hideBin(process.argv).filter((arg) => arg !== '--');
    const argv = (await yargs(args)
        .options({
            check: {
                type: 'boolean',
                default: false,
                description:
                    "Compare the regenerated matrix to the committed file; exit 1 if it's stale. Never writes.",
            },
            experiment: {
                type: 'string',
                description:
                    'Fill in "exercised" tool/argument coverage from this Langfuse experiment id\'s observed tool spans.',
            },
            out: {
                type: 'string',
                default: DEFAULT_OUT_PATH,
                description: 'Path to write (or, with --check, compare against) the coverage matrix.',
            },
        })
        .help().argv) as { check: boolean; experiment: string | undefined; out: string };

    let experiment: { experimentId: string; spans: ObservedToolSpan[] } | undefined;
    if (argv.experiment !== undefined) {
        // Only the --experiment path needs Langfuse credentials — the default run stays env-free.
        const missing = findMissingEnvVars(LANGFUSE_ENV_VARS);
        if (missing.length > 0) {
            console.error(
                `❌ --experiment needs Langfuse credentials; missing environment variable(s): ${missing.join(', ')}`,
            );
            process.exit(1);
            return;
        }
        // The Langfuse SDK reads process.env itself and passes it to node:http, which throws
        // ERR_INVALID_CHAR on a CI secret with a newline. Must run before the client is built.
        sanitizeProcessEnv();
        const { LangfuseClient } = await import('@langfuse/client');
        try {
            const spans = await fetchExperimentToolObservations(new LangfuseClient(), argv.experiment);
            experiment = { experimentId: argv.experiment, spans };
        } catch (error) {
            console.error(`❌ --experiment failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
            return;
        }
    }

    const matrix = buildCoverageMatrix(readSnapshot(), experiment);
    const rendered = renderCoverageMatrixMarkdown(matrix);
    const outPath = path.resolve(argv.out);
    const relativeOutPath = path.relative(process.cwd(), outPath);

    if (argv.check) {
        const committed = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : undefined;
        if (committed !== rendered) {
            console.error(`❌ ${relativeOutPath} is stale — run 'pnpm run evals:coverage' and commit the result.`);
            process.exit(1);
            return;
        }
        console.log(renderSummaryLines(matrix).join('\n'));
        console.log(`✅ ${relativeOutPath} is up to date.`);
        return;
    }

    fs.writeFileSync(outPath, rendered);
    console.log(renderSummaryLines(matrix).join('\n'));
    console.log(`Wrote ${relativeOutPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    void main();
}
