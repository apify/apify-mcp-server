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

import { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { findMissingEnvVars } from '../shared/config.js';
import { sanitizeProcessEnv } from './config.js';
import { resolveDatasetName, syncDataset } from './langfuse_dataset.js';
import { LANGFUSE_ENV_VARS } from './langfuse_tracing.js';
import { loadTestCases, resolveTestCasesPath } from './test_cases_loader.js';

// Before anything reads process.env: the Langfuse SDK passes these straight to
// node:http, which throws ERR_INVALID_CHAR on a CI secret with a newline.
sanitizeProcessEnv();

async function main() {
    const argv = (await yargs(hideBin(process.argv))
        .options({
            'test-cases-path': { type: 'string', description: 'Path to test cases JSON file (own dataset)' },
        })
        .help().argv) as { testCasesPath?: string };

    // Fail before touching Langfuse, listing every missing variable at once.
    const missing = findMissingEnvVars(LANGFUSE_ENV_VARS);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    const testCasesPath = resolveTestCasesPath(argv.testCasesPath);
    const datasetName = resolveDatasetName(testCasesPath);
    const items = await syncDataset(new LangfuseClient(), datasetName, loadTestCases(testCasesPath));

    console.log(`✅ Dataset "${datasetName}" now has ${items.length} item(s)`);
}

void main();
