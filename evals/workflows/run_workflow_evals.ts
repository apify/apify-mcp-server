#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for workflow evaluations (Langfuse backend).
 *
 * Every run syncs test_cases.json into the Langfuse dataset and executes the
 * matching dataset items as an experiment: a fresh MCP client per item, a
 * multi-turn agent conversation, then an LLM judge. Traces, scores, and the
 * dataset live in Langfuse.
 *
 * Usage:
 *   pnpm run evals:workflow
 *   pnpm run evals:workflow -- --category search
 *   pnpm run evals:workflow -- --id search-google-maps
 *   pnpm run evals:workflow -- --concurrency 8
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import { execSync } from 'node:child_process';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { filterByCategory, filterById } from '../shared/test_case_loader.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, MODELS, sanitizeProcessEnv } from './config.js';
import { resolveDatasetName, resolveItemId, syncDataset } from './langfuse_dataset.js';
import { buildRunSummary, evaluators, makeTask } from './langfuse_experiment.js';
import { createLangfuseClient, initTracing, shutdownTracing } from './langfuse_tracing.js';
import { LlmClient } from './llm_client.js';
import { loadTestCases, resolveTestCasesPath } from './test_cases_loader.js';

// Before anything reads process.env: the Langfuse SDK and the Apify client pass these
// straight to node:http, which throws ERR_INVALID_CHAR on a CI secret with a newline.
sanitizeProcessEnv();

type CliArgs = {
    category?: string;
    id?: string;
    testCasesPath?: string;
    agentModel: string;
    judgeModel: string;
    toolTimeout: number;
    concurrency: number;
};

/** Current git branch, or 'unknown' if it can't be resolved. */
function getGitBranch(): string {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

async function main() {
    // yargs infers the kebab-case key, not the camelCase alias, hence the cast.
    const argv = (await yargs(hideBin(process.argv))
        .options({
            category: { type: 'string', description: 'Filter by test case category (supports * wildcard)' },
            id: { type: 'string', description: 'Run test cases whose ID matches this regex' },
            'test-cases-path': { type: 'string', description: 'Path to test cases JSON file (own dataset)' },
            'agent-model': { type: 'string', description: 'LLM model for the agent', default: MODELS.agent },
            'judge-model': { type: 'string', description: 'LLM model for the judge', default: MODELS.judge },
            'tool-timeout': {
                type: 'number',
                description: 'Tool call timeout in seconds',
                default: DEFAULT_TOOL_TIMEOUT_SECONDS,
            },
            concurrency: { alias: 'c', type: 'number', description: 'Items to run in parallel', default: 4 },
        })
        .help().argv) as CliArgs;

    const langfuse = createLangfuseClient(['APIFY_TOKEN', 'OPENROUTER_API_KEY']);
    // Non-empty: createLangfuseClient exits otherwise. Sanitized above.
    const apifyToken = process.env.APIFY_TOKEN as string;
    const testCasesPath = resolveTestCasesPath(argv.testCasesPath);
    const datasetName = resolveDatasetName(testCasesPath);

    let exitCode = 1;
    try {
        // The dataset items are the only source of truth for a run, so sync first and
        // filter what comes back. Running on real dataset items is what makes the run
        // a Langfuse dataset run, comparable with every other run.
        const testCases = loadTestCases(testCasesPath);
        const items = await syncDataset(langfuse, datasetName, testCases);

        // Match on the test cases with the shared helpers, then pick the dataset items
        // they map to. One matching rule for every entry point that filters test cases.
        let selected = testCases;
        if (argv.id) selected = filterById(selected, argv.id);
        if (argv.category) selected = filterByCategory(selected, argv.category);
        const selectedIds = new Set(selected.map((testCase) => resolveItemId(datasetName, testCase.id)));
        const data = items.filter((item) => selectedIds.has(item.id));
        if (data.length === 0) {
            throw new Error(`No test case in "${datasetName}" matches --id/--category`);
        }
        const requestedIds = data.map((item) => item.id);

        initTracing();

        // Traces every agent/judge call as a generation nested under the item's trace.
        const llmClient = new LlmClient();

        const runName = `${getGitBranch()}-${argv.agentModel.split('/').pop()}-${Date.now()}`;
        console.log(`▶️  Running experiment "${runName}" over ${data.length} item(s), concurrency ${argv.concurrency}`);

        const result = await langfuse.experiment.run({
            name: datasetName,
            runName,
            description: 'Multi-turn workflow evals for the Apify MCP server.',
            data,
            task: makeTask({
                llmClient,
                apifyToken,
                agentModel: argv.agentModel,
                judgeModel: argv.judgeModel,
                toolTimeout: argv.toolTimeout,
            }),
            evaluators,
            runEvaluators: [
                // Denominator is the requested count, not itemResults.length, so items the
                // SDK dropped pull the rate down instead of vanishing from it.
                async ({ itemResults }) => ({
                    name: 'pass_rate',
                    value: buildRunSummary(requestedIds, itemResults).passedCount / requestedIds.length,
                }),
            ],
            maxConcurrency: argv.concurrency,
            metadata: {
                agentModel: argv.agentModel,
                judgeModel: argv.judgeModel,
                toolTimeout: argv.toolTimeout,
            },
        });

        // Compact on purpose: CI logs only need what went wrong, and Langfuse holds the
        // full per-item view behind the run link below.
        const summary = buildRunSummary(requestedIds, result.itemResults);
        for (const failure of summary.failures) {
            console.log(`❌ ${failure.id}: ${failure.reason}`);
        }
        if (summary.droppedIds.length > 0) {
            console.error(`🔥 Never completed (task threw, see errors above): ${summary.droppedIds.join(', ')}`);
        }

        console.log(`📊 ${summary.passedCount}/${requestedIds.length} passed`);
        console.log(`🔗 ${result.datasetRunUrl ?? `Run "${result.runName}" (view in Langfuse)`}`);

        exitCode = summary.exitCode;
    } catch (error) {
        console.error(`❌ Run failed: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
    } finally {
        // Flush scores and spans before exit or the last batch is lost.
        await langfuse.flush();
        await shutdownTracing();
    }

    process.exit(exitCode);
}

void main();
