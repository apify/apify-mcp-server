#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Copy a Langfuse workflow dataset into a new one, adding `expectedTools` to the cases
 * that have a single correct tool path.
 *
 * A run never writes to its dataset (see the README's first design decision), so this is
 * the one-off that seeds the rubric dataset. It only ever creates: the source dataset is
 * read and left untouched, so the previous suite keeps running unchanged.
 *
 * Copied item ids get a suffix (`-rubric` by default): Langfuse item ids are unique per
 * project across datasets, so a copy cannot reuse them.
 *
 * Usage:
 *   pnpm run evals:workflow:clone-dataset -- --dry-run
 *   pnpm run evals:workflow:clone-dataset
 *   pnpm run evals:workflow:clone-dataset -- --target other-name --id-suffix=-other
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { HELPER_TOOLS } from '../../src/const.js';
import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';
import type { WorkflowCase } from './langfuse_dataset.js';
import { fetchWorkflowCases, WORKFLOW_DATASET_NAME } from './langfuse_dataset.js';

// Before any client is constructed below: the Langfuse SDK reads process.env itself and
// passes it to node:http, which throws ERR_INVALID_CHAR on a CI secret with a newline.
sanitizeProcessEnv();

/** Default name of the dataset this script creates. */
const RUBRIC_DATASET_NAME = 'workflow-evals-rubric';

/**
 * The tools that constitute correct tool selection, per test case id.
 *
 * Only the cases whose requirements pin one path are listed. A case is deliberately
 * absent when the agent can reach the answer more than one way - every case that has to
 * discover an Actor first (`search-actors`, or knowing the id, or reading its input
 * schema are all legitimate), and every case whose requirements name a goal rather than a
 * sequence. `toolSelection` is then scored by the judge instead.
 *
 * The set is compared exactly, so a listed case fails the dimension on any extra call.
 * That is the point: for these cases, the target Actor is named in the query or the
 * requirements spell out the sequence, so an extra call is a detour.
 */
const EXPECTED_TOOLS: Record<string, string[]> = {
    // Requirements name fetch-actor-details and nothing else.
    'fetch-details-mcp-tools-list': [HELPER_TOOLS.ACTOR_GET_DETAILS],
    'fetch-details-non-mcp-actor-graceful': [HELPER_TOOLS.ACTOR_GET_DETAILS],
    'fetch-details-mcp-tools-then-call': [HELPER_TOOLS.ACTOR_GET_DETAILS, HELPER_TOOLS.ACTOR_CALL],
    'workflow-mcp-discover-and-execute': [HELPER_TOOLS.ACTOR_GET_DETAILS, HELPER_TOOLS.ACTOR_CALL],
    // The one case whose requirements spell out search -> details -> call as the pattern
    // under test.
    'workflow-search-fetch-schema-call': [
        HELPER_TOOLS.STORE_SEARCH,
        HELPER_TOOLS.ACTOR_GET_DETAILS,
        HELPER_TOOLS.ACTOR_CALL,
    ],
    // Search results already carry the names, descriptions and usage stats these cases
    // ask for, so a follow-up details call is a detour.
    'search-generic-scrapers': [HELPER_TOOLS.STORE_SEARCH],
    'search-google-maps': [HELPER_TOOLS.STORE_SEARCH],
    'search-instagram-scrapers': [HELPER_TOOLS.STORE_SEARCH],
    'search-tiktok-scrapers': [HELPER_TOOLS.STORE_SEARCH],
    // The Actor is named in the query and call-actor is forced to fail, so the only other
    // call that belongs here is the report.
    'report-problem-on-tool-error': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.PROBLEM_REPORT],
    // Seeded storage cases: the query names apify/rag-web-browser, so there is nothing to
    // discover before the call and the storage tool that follows is named too.
    'storage-actor-run-list-seeded': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.ACTOR_RUN_LIST_GET],
    'storage-actor-run-status-seeded': [
        HELPER_TOOLS.ACTOR_CALL,
        HELPER_TOOLS.ACTOR_RUNS_GET,
        HELPER_TOOLS.DATASET_GET_ITEMS,
    ],
    'storage-dataset-items-seeded': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.DATASET_GET_ITEMS],
    'storage-dataset-metadata-seeded': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.DATASET_GET],
    'storage-dataset-schema-seeded': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.DATASET_SCHEMA_GET],
    'storage-kv-keys-seeded': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET],
    'storage-kv-record-seeded': [HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET],
    // Only one tool is even enabled for this case.
    'storage-run-list-recent': [HELPER_TOOLS.ACTOR_RUN_LIST_GET],
};

/**
 * The item metadata to write, which is the source metadata plus expectedTools.
 *
 * `id`, `query` and `reference` are dropped because they are item fields rather than
 * metadata, and `item` because a fetched case carries the raw Langfuse item alongside its
 * flat view - writing that back would nest the whole source item inside the metadata, and
 * the strict validator rejects it on the next read.
 */
export function buildTargetMetadata(
    testCase: WorkflowCase,
    expectedTools: Record<string, string[]> = EXPECTED_TOOLS,
): Record<string, unknown> {
    const { id, query, reference, item, ...metadata } = testCase;
    const tools = expectedTools[id];
    return { ...metadata, ...(tools === undefined ? {} : { expectedTools: tools }) };
}

async function main() {
    const argv = (await yargs(hideBin(process.argv).filter((arg) => arg !== '--'))
        .options({
            source: { type: 'string', description: 'Dataset to copy from', default: WORKFLOW_DATASET_NAME },
            target: { type: 'string', description: 'Dataset to create', default: RUBRIC_DATASET_NAME },
            // Not optional in practice: Langfuse item ids are unique per project across
            // datasets, so copying an item under its own id is a 409. Pass it as
            // `--id-suffix=-foo`; a bare `-foo` value is read as flags.
            'id-suffix': {
                type: 'string',
                description: 'Appended to every copied item id (Langfuse item ids are unique per project)',
                default: '-rubric',
            },
            'dry-run': { type: 'boolean', description: 'Print what would be written and exit', default: false },
        })
        .help().argv) as { source: string; target: string; idSuffix: string; dryRun: boolean };

    const missing = findMissingEnvVars(LANGFUSE_ENV_VARS);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    if (argv.source === argv.target) {
        console.error(`❌ Error: --source and --target are both "${argv.source}"; this script never writes back.`);
        process.exit(1);
    }

    const langfuse = new LangfuseClient();
    const cases = await fetchWorkflowCases(langfuse, argv.source);
    console.log(`📇 Read ${cases.length} active case(s) from "${argv.source}"`);

    // Fail loudly on an id that no longer exists: the mapping is hand-written against the
    // dataset, and a renamed case would otherwise silently lose its expectedTools.
    const unknownIds = Object.keys(EXPECTED_TOOLS).filter((id) => !cases.some((entry) => entry.id === id));
    if (unknownIds.length > 0) {
        console.error(`❌ Error: EXPECTED_TOOLS names ids absent from "${argv.source}": ${unknownIds.join(', ')}`);
        process.exit(1);
    }

    for (const testCase of cases) {
        const metadata = buildTargetMetadata(testCase);
        const expected = (metadata.expectedTools as string[] | undefined) ?? [];
        console.log(`   ${testCase.id}${argv.idSuffix} -> ${expected.length > 0 ? expected.join(', ') : '(judged)'}`);
    }

    if (argv.dryRun) {
        console.log(`🔍 Dry run: nothing written. ${Object.keys(EXPECTED_TOOLS).length} case(s) get expectedTools.`);
        return;
    }

    // Created first: createItem needs the dataset to exist. Creating one that already
    // exists is an upsert of its description, not an error, so a resumed run is fine.
    await langfuse.api.datasets.create({
        name: argv.target,
        description: `Copy of "${argv.source}" carrying expectedTools for the multi-dimension judge rubric.`,
    });

    for (const testCase of cases) {
        await langfuse.dataset.createItem({
            datasetName: argv.target,
            id: `${testCase.id}${argv.idSuffix}`,
            input: { query: testCase.query },
            expectedOutput: testCase.reference,
            metadata: buildTargetMetadata(testCase),
        });
    }

    console.log(`✅ Created "${argv.target}" with ${cases.length} item(s). "${argv.source}" is unchanged.`);
    console.log(`   Run it with: pnpm run evals:workflow -- --dataset ${argv.target}`);
}

void main();
