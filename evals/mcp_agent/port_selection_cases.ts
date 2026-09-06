#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * One-off port: `evals/test_cases.json` (106 v1.11 next-tool-prediction cases, the old Phoenix
 * runner's suite) into `mcp-server-evals` as `kind: "selection", tier: ["pr"]` items, plus a
 * coverage wave and a lazy-user wave (apify/ai-team#240).
 *
 * The authoring table (every decision, and the 3 archived source ids) lives in
 * `port_selection_cases_data.ts`, reviewable as a diff. This script only builds each row's
 * `kind: "selection", tier: ["pr"]` metadata, validates it through the same strict validator the
 * runner uses, guards against id collisions, and upserts by id — mirroring
 * `migrate_unified_dataset.ts`'s shape, not a generic importer.
 *
 * Idempotent: upserting is by id, so a re-run replays the same content, never duplicates.
 *
 * Usage:
 *   pnpm run evals:mcp-agent:port-selection-cases -- --dry-run
 *   pnpm run evals:mcp-agent:port-selection-cases
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import { fileURLToPath } from 'node:url';

import { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';
import { fetchMcpAgentCases, MCP_AGENT_DATASET_NAME, parseMcpAgentItem } from './langfuse_dataset.js';
import { PORT_SELECTION_CASES, type PortCaseSpec } from './port_selection_cases_data.js';

// Before any client is constructed below: the Langfuse SDK reads process.env itself and
// passes it to node:http, which throws ERR_INVALID_CHAR on a CI secret with a newline.
sanitizeProcessEnv();

/**
 * The 4 live selection-item slugs a careless new id must not reuse: `#260`'s original 5-item
 * `pr`-tier set already holds `call-actor/rag-web-browser`, `fetch-actor-details/input-schema`,
 * `search-actors/tiktok-scraper`, and `get-actor-run/status` (the 5th, `web-fetch/example-com`,
 * doesn't collide with anything this port authors).
 */
export const BURNED_LIVE_IDS: readonly string[] = [
    'call-actor/rag-web-browser',
    'fetch-actor-details/input-schema',
    'search-actors/tiktok-scraper',
    'get-actor-run/status',
];

/** One row's item content, ready to upsert. */
export type PortItemPlan = {
    id: string;
    input: { query: string };
    metadata: {
        category: string;
        kind: 'selection';
        tier: ['pr'];
        expectedTools: string[];
        expectedArgs?: Record<string, unknown>;
        mcpToolsOnly?: boolean;
        tools?: string[];
    };
};

/** Map one authoring row onto its `kind: "selection", tier: ["pr"]` dataset item. */
export function buildPortItem(row: PortCaseSpec): PortItemPlan {
    return {
        id: row.id,
        input: { query: row.query },
        metadata: {
            category: row.category,
            kind: 'selection',
            tier: ['pr'],
            expectedTools: row.expectedTools,
            ...(row.expectedArgs !== undefined && { expectedArgs: row.expectedArgs }),
            ...(row.mcpToolsOnly !== undefined && { mcpToolsOnly: row.mcpToolsOnly }),
            ...(row.tools !== undefined && { tools: row.tools }),
        },
    };
}

/** Duplicate ids within the authoring table itself — a hard abort, before any write. */
export function findDuplicateIds(rows: PortCaseSpec[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const row of rows) {
        if (seen.has(row.id)) duplicates.add(row.id);
        seen.add(row.id);
    }
    return [...duplicates];
}

/**
 * Ids that collide with the burned-slug list or (once `liveNonSelectionIds` is supplied, on an
 * actual write) with a live item that is not itself `kind: "selection"` — overwriting either
 * would silently destroy pre-existing coverage. `liveNonSelectionIds` is the live dataset's ids
 * for every item whose `kind` is not `"selection"`; omit it for the zero-network, burned-slug-
 * only check `--dry-run` runs.
 */
export function findUnsafeCollisions(rows: PortCaseSpec[], liveNonSelectionIds?: ReadonlySet<string>): string[] {
    const unsafe = new Set<string>();
    for (const row of rows) {
        if (BURNED_LIVE_IDS.includes(row.id)) unsafe.add(row.id);
        if (liveNonSelectionIds?.has(row.id)) unsafe.add(row.id);
    }
    return [...unsafe];
}

/** Validate every row's built item through the same strict validator the runner uses. */
function validateRows(rows: PortCaseSpec[]): void {
    for (const row of rows) {
        // parseMcpAgentItem requires `expectedOutput` to be present-but-nullish, matching what
        // the dataset-items API actually returns for an item that never set it.
        parseMcpAgentItem({ ...buildPortItem(row), expectedOutput: null });
    }
}

async function upsertItems(langfuse: LangfuseClient, plans: PortItemPlan[]): Promise<void> {
    for (const plan of plans) {
        await langfuse.dataset.createItem({
            datasetName: MCP_AGENT_DATASET_NAME,
            id: plan.id,
            input: plan.input,
            metadata: plan.metadata,
        });
    }
}

function printPlanTable(rows: PortCaseSpec[]): void {
    console.table(
        rows.map((row) => ({
            decision: row.decision,
            sourceId: row.sourceId ?? '(new)',
            id: row.id,
            expectedTools: row.expectedTools.join(', '),
        })),
    );

    const countsByCategory = new Map<string, number>();
    for (const row of rows) {
        countsByCategory.set(row.category, (countsByCategory.get(row.category) ?? 0) + 1);
    }
    const summary = [...countsByCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, count]) => `${category}=${count}`)
        .join(', ');
    console.log(`📊 ${rows.length} item(s) planned (${summary}).`);
}

async function main() {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores every
    // flag behind it. Drop it so both call styles work.
    const args = hideBin(process.argv).filter((arg) => arg !== '--');
    const argv = (await yargs(args)
        .options({
            'dry-run': {
                type: 'boolean',
                description: 'Print the plan and abort before any write',
                default: false,
            },
        })
        .help().argv) as { dryRun: boolean };

    const duplicateIds = findDuplicateIds(PORT_SELECTION_CASES);
    if (duplicateIds.length > 0) {
        console.error(
            `❌ Duplicate id(s) within the authoring table — aborting before any write: ${duplicateIds.join(', ')}`,
        );
        process.exit(1);
    }

    try {
        validateRows(PORT_SELECTION_CASES);
    } catch (error) {
        console.error(`❌ Row validation failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    // The burned-slug check alone needs no network — enough for --dry-run to be a fully
    // reproducible, offline preview (no Langfuse reachability required).
    const burnedSlugCollisions = findUnsafeCollisions(PORT_SELECTION_CASES);
    if (burnedSlugCollisions.length > 0) {
        console.error(
            `❌ Id collision(s) with a burned live slug — aborting before any write: ${burnedSlugCollisions.join(', ')}`,
        );
        process.exit(1);
    }

    if (argv.dryRun) {
        printPlanTable(PORT_SELECTION_CASES);
        console.log('✅ Dry run: nothing written.');
        return;
    }

    // Fail before touching Langfuse, listing every missing variable at once.
    const missing = findMissingEnvVars(LANGFUSE_ENV_VARS);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    const langfuse = new LangfuseClient();

    try {
        console.log(`📋 Reading live "${MCP_AGENT_DATASET_NAME}" ids to guard against unsafe collisions...`);
        // ACTIVE items only (fetchMcpAgentCases skips archived ones), so this guards against
        // overwriting a live agent item, not against reusing an archived id — which Langfuse
        // rejects on its own, since ids are project-unique forever.
        const liveCases = await fetchMcpAgentCases(langfuse, MCP_AGENT_DATASET_NAME);
        const liveNonSelectionIds = new Set(liveCases.filter((c) => c.kind !== 'selection').map((c) => c.id));

        const unsafeCollisions = findUnsafeCollisions(PORT_SELECTION_CASES, liveNonSelectionIds);
        if (unsafeCollisions.length > 0) {
            console.error(`❌ Unsafe id collision(s) — aborting before any write: ${unsafeCollisions.join(', ')}`);
            process.exit(1);
        }

        printPlanTable(PORT_SELECTION_CASES);

        const plans = PORT_SELECTION_CASES.map(buildPortItem);
        console.log(`📥 Upserting ${plans.length} item(s) into "${MCP_AGENT_DATASET_NAME}"...`);
        await upsertItems(langfuse, plans);
        console.log('✅ Port complete.');
    } catch (error) {
        console.error(`❌ Port failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    } finally {
        await langfuse.flush();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    void main();
}
