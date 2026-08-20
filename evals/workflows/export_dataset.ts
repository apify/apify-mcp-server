#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Write the Langfuse dataset back to `dataset_snapshot.json`.
 *
 * The snapshot is a reviewable copy that nothing reads at runtime: it puts UI edits into
 * git history and keeps the cases somewhere other than the Langfuse database.
 *
 * Usage:
 *   pnpm run evals:workflow:export-dataset
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';
import { fetchWorkflowCases, WORKFLOW_DATASET_NAME } from './langfuse_dataset.js';

// Before any client is constructed below: the Langfuse SDK reads process.env itself and
// passes it to node:http, which throws ERR_INVALID_CHAR on a CI secret with a newline.
sanitizeProcessEnv();

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Snapshot file for a dataset. Resolved from this module so cwd cannot change it, and
 * named after the dataset unless it is the default one, whose file name predates
 * `--dataset` and stays put so its history is continuous.
 */
export function snapshotPathFor(datasetName: string): string {
    const fileName =
        datasetName === WORKFLOW_DATASET_NAME ? 'dataset_snapshot.json' : `dataset_snapshot.${datasetName}.json`;
    return path.join(MODULE_DIR, fileName);
}

async function main() {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores every
    // flag behind it - silently exporting the default dataset over the wrong snapshot.
    const argv = (await yargs(hideBin(process.argv).filter((arg) => arg !== '--'))
        .options({
            dataset: { type: 'string', description: 'Langfuse dataset to export', default: WORKFLOW_DATASET_NAME },
        })
        .help().argv) as { dataset: string };

    // Fail before touching Langfuse, listing every missing variable at once.
    const missing = findMissingEnvVars(LANGFUSE_ENV_VARS);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    const cases = await fetchWorkflowCases(new LangfuseClient(), argv.dataset);
    // Drop the raw item: the snapshot holds test cases, not Langfuse bookkeeping.
    const testCases = cases.map(({ item, ...testCase }) => testCase);

    const snapshotPath = snapshotPathFor(argv.dataset);
    fs.writeFileSync(snapshotPath, `${JSON.stringify(testCases, null, 2)}\n`);
    console.log(`✅ Wrote ${testCases.length} case(s) from "${argv.dataset}" to ${snapshotPath}`);
}

void main();
