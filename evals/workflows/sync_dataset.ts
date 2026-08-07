#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Sync `test_cases.json` into its Langfuse dataset without running any evaluation.
 * Use it to seed a fresh Langfuse instance; the eval runner performs the same sync
 * on every run. Kept separate from the runner because it needs neither a build nor
 * Apify/OpenRouter keys.
 *
 * Usage:
 *   pnpm run evals:workflow:sync-dataset
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { resolveDatasetName, syncDataset } from './langfuse_dataset.js';
import { createLangfuseClient } from './langfuse_tracing.js';
import { loadTestCases, resolveTestCasesPath } from './test_cases_loader.js';

async function main() {
    const argv = (await yargs(hideBin(process.argv))
        .options({
            'test-cases-path': { type: 'string', description: 'Path to test cases JSON file (own dataset)' },
        })
        .help().argv) as { testCasesPath?: string };

    const langfuse = createLangfuseClient();
    const testCasesPath = resolveTestCasesPath(argv.testCasesPath);
    const datasetName = resolveDatasetName(testCasesPath);
    const items = await syncDataset(langfuse, datasetName, loadTestCases(testCasesPath));

    console.log(`✅ Dataset "${datasetName}" now has ${items.length} item(s)`);
}

void main();
