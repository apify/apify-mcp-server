#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * One-off migration: re-create every case from the 7 legacy mcp-agent-evals datasets as
 * `kind: agent, tier: ["full"]` items in the unified `mcp-server-evals` dataset, archive the
 * legacy datasets (and two unrelated leftovers) in place, and best-effort delete the spike's
 * throwaway experiment runs.
 *
 * Langfuse item ids are project-unique forever and cannot move between datasets (see
 * evals/mcp_agent/README.md), so this is a re-create, not a rename: every migrated item gets
 * a new id, `<category>/<slug>`, where `<category>` is the source dataset's family name and
 * `<slug>` is the old id with a redundant family-name prefix (singular or plural) stripped.
 *
 * Reads the source datasets with a small local schema mirroring their pre-extension shape
 * (`category` + optional `maxTurns`/`tools`/`failTools`) — never through the extended
 * validator in `langfuse_dataset.ts`, which would reject every legacy item for lacking
 * `kind`/`tier`. Archiving is raw passthrough with no schema at all, because
 * `workflow-evals-rubric`'s items carry an unrelated `expectedTools` field that predates #236.
 *
 * Idempotent while it is still creating items: upserting is by id, so re-running after a
 * failure before the archive step only re-applies the same content, never duplicates.
 * NOT resumable once archiving has begun: the plan is rebuilt from the ACTIVE source items,
 * so already-archived sources drop out of it and post-migration validation then rejects the
 * items they produced as unexpected. Recovering a half-archived run means un-archiving the
 * source items in the Langfuse UI (or migrating the remainder by hand), not re-running this.
 *
 * Already run (2026-09-05): the legacy datasets are archived. `validateMigration`'s checks
 * assert the whole `mcp-server-evals` dataset equals the migration plan, which predates the
 * `kind: "selection", tier: ["pr"]` items #260 added afterward - a re-run today stops at
 * validation by design, not by regression.
 *
 * Usage:
 *   pnpm run evals:mcp-agent:migrate-unified-dataset -- --dry-run
 *   pnpm run evals:mcp-agent:migrate-unified-dataset
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import { fileURLToPath } from 'node:url';

import { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';

import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';
import { fetchMcpAgentCases, MCP_AGENT_DATASET_NAME, type McpAgentTestCase } from './langfuse_dataset.js';

// Before any client is constructed below: the Langfuse SDK reads process.env itself and
// passes it to node:http, which throws ERR_INVALID_CHAR on a CI secret with a newline.
sanitizeProcessEnv();

/** One legacy source dataset and the family name its ids fall under. */
export type SourceDatasetSpec = { name: string; family: string };

/** The 4 proper suites and their 3 `*-errors` twins, one family per pair. */
export const SOURCE_DATASETS: SourceDatasetSpec[] = [
    { name: 'mcp-agent-evals', family: 'mcp-agent' },
    { name: 'tasks-evals', family: 'tasks' },
    { name: 'web-fetch-evals', family: 'web-fetch' },
    { name: 'web-selection-evals', family: 'web-selection' },
    { name: 'tasks-evals-errors', family: 'tasks' },
    { name: 'web-fetch-evals-errors', family: 'web-fetch' },
    { name: 'web-selection-evals-errors', family: 'web-selection' },
];

/** Datasets archived in place but not migrated: no items of theirs move to mcp-server-evals. */
export const LEFTOVER_DATASETS_TO_ARCHIVE = ['workflow-evals-rubric', 'zz-spike-selection-poc'];

/** Where the spike's throwaway experiment runs live, and how to recognize them. */
const SPIKE_DATASET_NAME = 'zz-spike-selection-poc';
const SPIKE_RUN_NAME_PREFIX = 'spike-iter-probe-';

const TARGET_DATASET_DESCRIPTION =
    'Unified MCP server eval dataset (#236/#259): every case self-describes kind (selection/agent), ' +
    'tier (pr/full), and expectedErrors, replacing the old per-family and *-errors datasets.';

/**
 * Tools allowed to fail on each of the 8 error items, hardcoded from the fact-check's live
 * probe of the source items (none of them set the `failTools` knob, so this cannot be derived
 * from the source item itself). Keyed by the new `<category>/<slug>` id.
 *
 * `web-selection/blocked-native` names only `apify--rag-web-browser`: the client's own
 * built-in fetch may also fail on that item, but built-in tool failures are already exempt
 * from the zero-tool-error gate (see langfuse_experiment.ts), so there is nothing for this
 * server-side-only list to name for it.
 */
export const EXPECTED_ERRORS_BY_NEW_ID: Readonly<Record<string, readonly string[]>> = {
    'tasks/get-not-found': ['get-actor-task'],
    'tasks/create-collision': ['create-actor-task'],
    'tasks/publish-discovery': ['publish-actor-task'],
    'web-fetch/unsupported-protocol': ['apify--web-fetch'],
    'web-fetch/format-discovery': ['apify--web-fetch'],
    'web-fetch/unreachable': ['apify--web-fetch'],
    'web-selection/rag-blocked': ['apify--rag-web-browser'],
    'web-selection/blocked-native': ['apify--rag-web-browser'],
};

/** Tool names this item's zero-tool-error gate must exempt, or undefined for a clean item. */
export function getExpectedErrorsForId(newId: string): string[] | undefined {
    const errors = EXPECTED_ERRORS_BY_NEW_ID[newId];
    return errors ? [...errors] : undefined;
}

/**
 * `<category>/<slug>`: strip a redundant family-name prefix (singular or plural) from the
 * source id, if it starts with one, then namespace it under the family.
 */
export function deriveNewId(family: string, sourceId: string): string {
    const singularFamily = family.endsWith('s') ? family.slice(0, -1) : family;
    for (const prefix of [`${family}-`, `${singularFamily}-`]) {
        if (sourceId.startsWith(prefix)) {
            return `${family}/${sourceId.slice(prefix.length)}`;
        }
    }
    return `${family}/${sourceId}`;
}

/** The pre-extension item shape, as it exists today in the 7 source datasets. */
const LegacyMcpAgentMetadataValidator = z.strictObject({
    category: z.string().min(1),
    maxTurns: z.number().int().positive().optional(),
    tools: z.array(z.string()).optional(),
    failTools: z.array(z.string()).optional(),
});

const LegacyMcpAgentItemValidator = z.object({
    id: z.string().min(1),
    input: z.object({ query: z.string().min(1) }),
    expectedOutput: z.string().min(1),
    metadata: LegacyMcpAgentMetadataValidator,
});

export type LegacyMcpAgentItem = z.infer<typeof LegacyMcpAgentItemValidator>;

/**
 * Validate a source item against the pre-extension shape. Deliberately not the extended
 * validator in langfuse_dataset.ts: none of the 7 source datasets have `kind`/`tier` yet, so
 * that validator would reject every item here.
 */
export function parseLegacyMcpAgentItem(datasetName: string, item: unknown): LegacyMcpAgentItem {
    const parsed = LegacyMcpAgentItemValidator.safeParse(item);
    if (!parsed.success) {
        const id = (item as { id?: string } | null)?.id ?? '(unknown)';
        throw new Error(
            `Dataset "${datasetName}" item "${id}" is not a usable legacy MCP agent item: ${parsed.error.message}`,
        );
    }
    return parsed.data;
}

/** One item's migration plan: its new id, source, and the item content to upsert. */
export type MigratedItemPlan = {
    id: string;
    sourceDataset: string;
    sourceId: string;
    input: { query: string };
    expectedOutput: string;
    metadata: {
        category: string;
        kind: 'agent';
        tier: ['full'];
        expectedErrors?: string[];
        maxTurns?: number;
        tools?: string[];
        failTools?: string[];
    };
};

/** Map one legacy item onto its migrated shape: kind: agent, tier: [full], new id. */
export function buildMigratedItem(sourceDataset: string, family: string, item: LegacyMcpAgentItem): MigratedItemPlan {
    const id = deriveNewId(family, item.id);
    const expectedErrors = getExpectedErrorsForId(id);
    return {
        id,
        sourceDataset,
        sourceId: item.id,
        input: item.input,
        expectedOutput: item.expectedOutput,
        metadata: {
            category: item.metadata.category,
            kind: 'agent',
            tier: ['full'],
            ...(expectedErrors !== undefined && { expectedErrors }),
            ...(item.metadata.maxTurns !== undefined && { maxTurns: item.metadata.maxTurns }),
            ...(item.metadata.tools !== undefined && { tools: item.metadata.tools }),
            ...(item.metadata.failTools !== undefined && { failTools: item.metadata.failTools }),
        },
    };
}

/** A new id two different source items stripped down to, and which sources collided. */
export type IdCollision = { id: string; sources: { dataset: string; id: string }[] };

/** Two source ids stripping to the same new id is a hard abort, named before any write. */
export function findIdCollisions(plans: MigratedItemPlan[]): IdCollision[] {
    const sourcesByNewId = new Map<string, { dataset: string; id: string }[]>();
    for (const plan of plans) {
        const sources = sourcesByNewId.get(plan.id) ?? [];
        sources.push({ dataset: plan.sourceDataset, id: plan.sourceId });
        sourcesByNewId.set(plan.id, sources);
    }
    return [...sourcesByNewId.entries()]
        .filter(([, sources]) => sources.length > 1)
        .map(([id, sources]) => ({ id, sources }));
}

/** Every active item of one source dataset, validated against the legacy shape. */
async function fetchLegacyActiveItems(langfuse: LangfuseClient, datasetName: string): Promise<LegacyMcpAgentItem[]> {
    const dataset = await langfuse.dataset.get(datasetName, { fetchItemsPageSize: 100 });
    return dataset.items
        .filter((item) => item.status === 'ACTIVE')
        .map((item) => parseLegacyMcpAgentItem(datasetName, item));
}

/** The full migration plan: every active item of every source dataset, mapped to its new shape. */
async function planMigration(langfuse: LangfuseClient): Promise<MigratedItemPlan[]> {
    const plans: MigratedItemPlan[] = [];
    for (const { name, family } of SOURCE_DATASETS) {
        const items = await fetchLegacyActiveItems(langfuse, name);
        for (const item of items) {
            plans.push(buildMigratedItem(name, family, item));
        }
    }
    return plans;
}

/** `mcp-server-evals` may already exist from a prior partial run; create it only if missing. */
async function ensureTargetDatasetExists(langfuse: LangfuseClient, name: string, description: string): Promise<void> {
    try {
        await langfuse.api.datasets.get(name);
        return;
    } catch (error) {
        const statusCode = (error as { statusCode?: number } | null)?.statusCode;
        if (statusCode !== 404) throw error;
    }
    await langfuse.api.datasets.create({ name, description });
}

/** Upsert every planned item into the target dataset. Upsert-by-id, so a re-run is a no-op replay. */
async function upsertMigratedItems(langfuse: LangfuseClient, plans: MigratedItemPlan[]): Promise<void> {
    for (const plan of plans) {
        await langfuse.dataset.createItem({
            datasetName: MCP_AGENT_DATASET_NAME,
            id: plan.id,
            input: plan.input,
            expectedOutput: plan.expectedOutput,
            metadata: plan.metadata,
        });
    }
}

/**
 * Names of the planned fields the migrated item does not reproduce. Compares every field the
 * plan sets: the prompt, the judge reference, the category, and the exempted tool names.
 */
export function comparePlannedFields(plan: MigratedItemPlan, actual: McpAgentTestCase): string[] {
    const wrongFields: string[] = [];
    if (actual.query !== plan.input.query) wrongFields.push('query');
    if (actual.reference !== plan.expectedOutput) wrongFields.push('expectedOutput');
    if (actual.category !== plan.metadata.category) wrongFields.push('category');
    const plannedErrors = plan.metadata.expectedErrors ?? [];
    const actualErrors = actual.expectedErrors ?? [];
    if (JSON.stringify(actualErrors) !== JSON.stringify(plannedErrors)) wrongFields.push('expectedErrors');
    return wrongFields;
}

/**
 * Fetch the migrated dataset back through the real (extended) validator and check every item
 * reproduces its plan: the ids present, and each item's kind, tier, prompt, judge reference,
 * category and exempted tool names. Throws with a diff on any mismatch, so nothing downstream
 * (archiving, which destroys the only other copy) runs.
 */
async function validateMigration(langfuse: LangfuseClient, plans: MigratedItemPlan[]): Promise<void> {
    const cases = await fetchMcpAgentCases(langfuse, MCP_AGENT_DATASET_NAME);

    const expectedIds = new Set(plans.map((plan) => plan.id));
    const actualIds = new Set(cases.map((c) => c.id));
    const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
    const unexpectedIds = [...actualIds].filter((id) => !expectedIds.has(id));
    const wrongKindIds = cases.filter((c) => c.kind !== 'agent').map((c) => c.id);
    const wrongTierIds = cases.filter((c) => c.tier.length !== 1 || c.tier[0] !== 'full').map((c) => c.id);

    // Content, not just presence: an id/kind/tier check would pass a item whose query, judge
    // reference or exempted tool names were written wrong, and archiving the sources after that
    // destroys the only other copy.
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const contentMismatches = plans.flatMap((plan) => {
        const actual = caseById.get(plan.id);
        if (actual === undefined) return [];
        const wrongFields = comparePlannedFields(plan, actual);
        return wrongFields.length > 0 ? [`${plan.id} (${wrongFields.join(', ')})`] : [];
    });

    const problems: string[] = [];
    if (cases.length !== plans.length) problems.push(`expected ${plans.length} items, got ${cases.length}`);
    if (missingIds.length > 0) problems.push(`missing: ${missingIds.join(', ')}`);
    if (unexpectedIds.length > 0) problems.push(`unexpected: ${unexpectedIds.join(', ')}`);
    if (wrongKindIds.length > 0) problems.push(`kind !== "agent": ${wrongKindIds.join(', ')}`);
    if (wrongTierIds.length > 0) problems.push(`tier !== ["full"]: ${wrongTierIds.join(', ')}`);
    if (contentMismatches.length > 0) problems.push(`content mismatch: ${contentMismatches.join('; ')}`);

    if (problems.length > 0) {
        throw new Error(`Post-migration validation of "${MCP_AGENT_DATASET_NAME}" failed:\n  ${problems.join('\n  ')}`);
    }
}

/** Archive every ACTIVE item of one dataset, raw passthrough (no schema). Returns the count archived. */
async function archiveDatasetItems(langfuse: LangfuseClient, datasetName: string): Promise<number> {
    const dataset = await langfuse.dataset.get(datasetName, { fetchItemsPageSize: 100 });
    const activeItems = dataset.items.filter((item) => item.status === 'ACTIVE');
    for (const item of activeItems) {
        await langfuse.dataset.createItem({
            datasetName,
            id: item.id,
            input: item.input,
            expectedOutput: item.expectedOutput,
            metadata: item.metadata,
            status: 'ARCHIVED',
        });
    }
    return activeItems.length;
}

/**
 * Best-effort delete of the spike's throwaway experiment runs. Never throws: the spike found
 * the SDK's run-delete surface 404s on this instance, so "not supported" is an expected,
 * non-blocking outcome, not a migration failure.
 */
async function deleteSpikeExperimentRuns(langfuse: LangfuseClient): Promise<void> {
    let runs;
    try {
        runs = (await langfuse.api.datasets.getRuns(SPIKE_DATASET_NAME, { limit: 100 })).data;
    } catch (error) {
        console.log(
            `ℹ️  Could not list experiment runs on "${SPIKE_DATASET_NAME}" (not supported here, or none exist): ` +
                `${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    const spikeRuns = runs.filter((run) => run.name.startsWith(SPIKE_RUN_NAME_PREFIX));
    for (const run of spikeRuns) {
        try {
            await langfuse.api.datasets.deleteRun(SPIKE_DATASET_NAME, run.name);
            console.log(`  🗑️  deleted experiment run "${run.name}"`);
        } catch (error) {
            console.log(
                `  ℹ️  could not delete experiment run "${run.name}" (not supported here): ` +
                    `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

/** Console table of the migration plan: old id -> new id, with expectedErrors flagged. */
function printPlanTable(plans: MigratedItemPlan[]): void {
    console.table(
        plans.map((plan) => ({
            sourceDataset: plan.sourceDataset,
            oldId: plan.sourceId,
            newId: plan.id,
            expectedErrors: plan.metadata.expectedErrors?.join(', ') ?? '',
        })),
    );

    const countsByFamily = new Map<string, number>();
    for (const plan of plans) {
        const family = plan.id.split('/')[0];
        countsByFamily.set(family, (countsByFamily.get(family) ?? 0) + 1);
    }
    const summary = [...countsByFamily.entries()].map(([family, count]) => `${family}=${count}`).join(', ');
    const withErrors = plans.filter((plan) => plan.metadata.expectedErrors !== undefined).length;
    console.log(
        `📊 ${plans.length} item(s) planned (${summary}); ${withErrors} with expectedErrors, ${plans.length - withErrors} without.`,
    );
}

async function main() {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores
    // every flag behind it. Drop it so both call styles work.
    const args = hideBin(process.argv).filter((arg) => arg !== '--');
    const argv = (await yargs(args)
        .options({
            'dry-run': {
                type: 'boolean',
                description: 'Print the migration plan and abort before any write',
                default: false,
            },
        })
        .help().argv) as { dryRun: boolean };

    // Fail before touching Langfuse, listing every missing variable at once.
    const missing = findMissingEnvVars(LANGFUSE_ENV_VARS);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    const langfuse = new LangfuseClient();

    try {
        console.log('📋 Reading the 7 source datasets...');
        const plans = await planMigration(langfuse);

        const collisions = findIdCollisions(plans);
        if (collisions.length > 0) {
            console.error('❌ Id collision(s) — aborting before any write:');
            for (const collision of collisions) {
                console.error(
                    `  "${collision.id}" <- ${collision.sources.map((s) => `${s.dataset}/${s.id}`).join(', ')}`,
                );
            }
            process.exit(1);
        }

        printPlanTable(plans);

        if (argv.dryRun) {
            console.log('✅ Dry run: nothing written.');
            return;
        }

        console.log(`📥 Upserting ${plans.length} item(s) into "${MCP_AGENT_DATASET_NAME}"...`);
        await ensureTargetDatasetExists(langfuse, MCP_AGENT_DATASET_NAME, TARGET_DATASET_DESCRIPTION);
        await upsertMigratedItems(langfuse, plans);

        console.log('🔍 Validating the migrated dataset before archiving anything...');
        await validateMigration(langfuse, plans);
        console.log('✅ Validation passed.');

        console.log('🗄️  Archiving source and leftover datasets...');
        for (const { name } of SOURCE_DATASETS) {
            const count = await archiveDatasetItems(langfuse, name);
            console.log(`  archived ${count} item(s) in "${name}"`);
        }
        for (const name of LEFTOVER_DATASETS_TO_ARCHIVE) {
            const count = await archiveDatasetItems(langfuse, name);
            console.log(`  archived ${count} item(s) in "${name}"`);
        }

        console.log('🧹 Cleaning up the spike experiment runs (best-effort)...');
        await deleteSpikeExperimentRuns(langfuse);

        console.log('✅ Migration complete.');
    } catch (error) {
        console.error(`❌ Migration failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    } finally {
        await langfuse.flush();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    void main();
}
