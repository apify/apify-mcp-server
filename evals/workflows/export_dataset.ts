#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Write the Langfuse dataset back to `dataset_snapshot_<dataset>.json`.
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

/** Resolved from this module so cwd cannot change it. */
const SNAPSHOT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** One file per dataset, named after it. */
function snapshotPath(dataset: string): string {
    return path.join(SNAPSHOT_DIR, `dataset_snapshot_${dataset.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
}

async function main() {
    const argv = (await yargs(hideBin(process.argv))
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

    const outPath = snapshotPath(argv.dataset);
    fs.writeFileSync(outPath, `${JSON.stringify(testCases, null, 2)}\n`);
    console.log(`✅ Wrote ${testCases.length} case(s) from "${argv.dataset}" to ${outPath}`);
}

void main();
