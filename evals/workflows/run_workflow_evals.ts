#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for workflow evaluations (Langfuse backend).
 *
 * Runs each test case as a Langfuse experiment item: a fresh MCP client, a
 * multi-turn agent conversation, then an LLM judge. Traces, scores, and the
 * dataset live in Langfuse Cloud.
 *
 * Usage:
 *   pnpm run evals:workflow
 *   pnpm run evals:workflow -- --category search
 *   pnpm run evals:workflow -- --id search-google-maps
 *   pnpm run evals:workflow -- --concurrency 8
 */

import { execSync } from 'node:child_process';

import { LangfuseClient } from '@langfuse/client';
import { observeOpenAI } from '@langfuse/openai';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { DEFAULT_TOOL_TIMEOUT_SECONDS, MODELS, sanitizeEnvValue } from './config.js';
import { syncDataset, WORKFLOW_DATASET_NAME } from './langfuse_dataset.js';
import {
    buildRunName,
    evaluators,
    makeTask,
    testCaseToExperimentItem,
    type WorkflowExperimentItem,
    type WorkflowTaskOutput,
} from './langfuse_experiment.js';
import { getMissingLangfuseEnvVars, initTracing, LANGFUSE_BASE_URLS, shutdownTracing } from './langfuse_tracing.js';
import { LlmClient } from './llm_client.js';
import { filterTestCases, loadTestCases } from './test_cases_loader.js';

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
    const argv = (await yargs(hideBin(process.argv))
        .option('category', {
            type: 'string',
            description: 'Filter by test case category',
        })
        .option('id', {
            type: 'string',
            description: 'Run specific test case by ID',
        })
        .option('test-cases-path', {
            type: 'string',
            description: 'Path to test cases JSON file',
        })
        .option('agent-model', {
            type: 'string',
            description: `LLM model for the agent (default: ${MODELS.agent})`,
            default: MODELS.agent,
        })
        .option('judge-model', {
            type: 'string',
            description: `LLM model for the judge (default: ${MODELS.judge})`,
            default: MODELS.judge,
        })
        .option('tool-timeout', {
            type: 'number',
            description: `Tool call timeout in seconds (default: ${DEFAULT_TOOL_TIMEOUT_SECONDS})`,
            default: DEFAULT_TOOL_TIMEOUT_SECONDS,
        })
        .option('concurrency', {
            alias: 'c',
            type: 'number',
            description: 'Number of items to run in parallel (default: 4)',
            default: 4,
        })
        .help().argv) as CliArgs;

    console.log('='.repeat(100));
    console.log('Workflow Evaluation Runner (Langfuse)');
    console.log('='.repeat(100));
    console.log();

    // Environment variables.
    const apifyToken = sanitizeEnvValue(process.env.APIFY_TOKEN);
    const openrouterKey = sanitizeEnvValue(process.env.OPENROUTER_API_KEY);

    if (!apifyToken) {
        console.error('❌ Error: APIFY_TOKEN environment variable is required');
        process.exit(1);
    }

    if (!openrouterKey) {
        console.error('❌ Error: OPENROUTER_API_KEY environment variable is required');
        process.exit(1);
    }

    const missingLangfuse = getMissingLangfuseEnvVars();
    if (missingLangfuse.length > 0) {
        console.error(`❌ Error: missing Langfuse environment variable(s): ${missingLangfuse.join(', ')}`);
        console.error(
            `   Set all of: ${['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'].join(', ')}`,
        );
        console.error(`   LANGFUSE_BASE_URL must be one of: ${LANGFUSE_BASE_URLS.join(' or ')}`);
        process.exit(1);
    }

    // Load test cases.
    console.log('📂 Loading test cases...');
    let allTestCases;
    try {
        allTestCases = loadTestCases(argv.testCasesPath);
    } catch (error) {
        console.error(`❌ Failed to load test cases: ${error}`);
        process.exit(1);
    }

    const filteredTestCases = filterTestCases(allTestCases, { id: argv.id, category: argv.category });

    if (filteredTestCases.length === 0) {
        console.log('⚠️  No test cases found matching the filters.');
        console.log('');
        console.log('Available test cases:');
        for (const tc of allTestCases) {
            console.log(`  - ${tc.id} (${tc.category}): ${tc.query}`);
        }
        process.exit(0);
    }

    console.log(`✅ Loaded ${filteredTestCases.length} of ${allTestCases.length} test case(s)`);
    console.log();

    // Start tracing and the Langfuse client.
    initTracing();
    const langfuse = new LangfuseClient();

    let exitCode = 1;
    try {
        // Sync ALL test cases into the dataset (independent of run filters).
        console.log(`📇 Syncing ${allTestCases.length} test case(s) into dataset "${WORKFLOW_DATASET_NAME}"...`);
        await syncDataset(langfuse, allTestCases);
        console.log();

        // Wrap the agent/judge LLM client so calls nest under each item's trace.
        const llmClient = new LlmClient((client) => observeOpenAI(client));

        const runName = buildRunName(getGitBranch(), argv.agentModel, Date.now());
        console.log(`▶️  Running experiment "${runName}" with concurrency ${argv.concurrency}...`);
        console.log();

        const data: WorkflowExperimentItem[] = filteredTestCases.map(testCaseToExperimentItem);

        const result = await langfuse.experiment.run({
            name: 'workflow-evals',
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
            maxConcurrency: argv.concurrency,
            metadata: {
                agentModel: argv.agentModel,
                judgeModel: argv.judgeModel,
                toolTimeout: argv.toolTimeout,
            },
        });

        // Compact pass/fail table.
        console.log('='.repeat(100));
        console.log('Results');
        console.log('='.repeat(100));

        let passed = 0;
        for (const item of result.itemResults) {
            const output = item.output as WorkflowTaskOutput;
            const judge = item.evaluations.find((e) => e.name === 'workflow_judge');
            const isPass = judge?.value === 1;
            if (isPass) passed += 1;

            const id = (item.item.metadata as { testCase?: { id?: string } })?.testCase?.id ?? '(unknown)';
            const status = output.error ? '🔥 ERROR' : isPass ? '✅ PASS' : '❌ FAIL';
            const reason = output.error ?? output.judgeResult.reason;
            console.log(`${status} | ${id} | ${reason}`);
        }

        const total = result.itemResults.length;
        console.log('-'.repeat(100));
        console.log(`📊 ${passed}/${total} passed`);
        if (result.datasetRunUrl) {
            console.log(`🔗 ${result.datasetRunUrl}`);
        } else {
            console.log(`🔗 Run "${result.runName}" (experiment ${result.experimentId}) — view in Langfuse Cloud`);
        }
        console.log('='.repeat(100));

        // Strict gate: every item must have workflow_judge === 1 (errored items score 0).
        exitCode = total > 0 && passed === total ? 0 : 1;
    } catch (error) {
        console.error(`❌ Experiment failed: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
    } finally {
        // Flush scores and spans before exit or the last batch is lost.
        await langfuse.flush();
        await shutdownTracing();
    }

    process.exit(exitCode);
}

void main();
