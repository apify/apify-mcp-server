#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for workflow evaluations (Langfuse backend).
 *
 * Every run reads its test cases from the Langfuse dataset and executes the matching
 * items as an experiment: a Claude Code agent (Claude Agent SDK) driving its own freshly
 * spawned Apify MCP server, then an LLM judge. Traces, scores, and the dataset live in
 * Langfuse.
 *
 * Usage:
 *   pnpm run evals:workflow
 *   pnpm run evals:workflow -- --category search
 *   pnpm run evals:workflow -- --id search-google-maps
 *   pnpm run evals:workflow -- --concurrency 8
 *   pnpm run evals:workflow -- --mcp-tools-only   # drop Claude Code's built-in tools
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import { execSync } from 'node:child_process';

import { LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { readJsonFile } from '../../src/utils/generic.js';
import { findMissingEnvVars, LANGFUSE_ENV_VARS } from '../shared/config.js';
import { filterByCategory, filterById } from '../shared/test_case_loader.js';
import { assertStdioBinExists } from './claude_agent.js';
import { ClaudeLlmClient } from './claude_judge_client.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, MODELS, sanitizeProcessEnv } from './config.js';
import { fetchWorkflowCases, WORKFLOW_DATASET_NAME } from './langfuse_dataset.js';
import { buildRunSummary, countPassed, evaluators, makeTask } from './langfuse_experiment.js';
import { initTracing, shutdownTracing } from './langfuse_tracing.js';
import { LlmClient } from './llm_client.js';

// Before any client is constructed below: the Langfuse SDK and the Apify client read
// process.env themselves and pass it to node:http, which throws ERR_INVALID_CHAR on a
// CI secret with a newline. Imported config that reads env at load time (OPENROUTER_CONFIG)
// runs before this and sanitizes its own values.
sanitizeProcessEnv();

type CliArgs = {
    category?: string;
    id?: string;
    dataset: string;
    agentModel: string;
    judgeModel?: string;
    toolTimeout: number;
    concurrency: number;
    mcpToolsOnly: boolean;
    subscription: boolean;
    claudeJudge: boolean;
    allowToolErrors: boolean;
};

/** Current git branch, or 'unknown' if it can't be resolved. */
function getGitBranch(): string {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Version of the Agent SDK, recorded in run metadata: the harness is a moving target and
 * a release can shift results. Read from the exact pin in package.json.
 */
function resolveAgentSdkVersion(): string {
    const manifest = readJsonFile<{ devDependencies: Record<string, string> }>(import.meta.url, '../../package.json');
    return manifest.devDependencies['@anthropic-ai/claude-agent-sdk'] ?? 'unknown';
}

async function main() {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores
    // every flag behind it. Drop it so both call styles work.
    const args = hideBin(process.argv).filter((arg) => arg !== '--');

    // yargs infers the kebab-case key, not the camelCase alias, hence the cast.
    const argv = (await yargs(args)
        .options({
            category: { type: 'string', description: 'Filter by test case category (supports * wildcard)' },
            id: { type: 'string', description: 'Run test cases whose ID matches this regex' },
            dataset: {
                type: 'string',
                description: 'Langfuse dataset to run',
                default: WORKFLOW_DATASET_NAME,
            },
            'agent-model': { type: 'string', description: 'LLM model for the agent', default: MODELS.agent },
            'judge-model': {
                type: 'string',
                description: `LLM model for the judge (default: ${MODELS.judge}, or ${MODELS.claudeJudge} with --claude-judge)`,
            },
            'tool-timeout': {
                type: 'number',
                description: 'Tool call timeout in seconds',
                default: DEFAULT_TOOL_TIMEOUT_SECONDS,
            },
            concurrency: { alias: 'c', type: 'number', description: 'Items to run in parallel', default: 8 },
            'mcp-tools-only': {
                type: 'boolean',
                description: "Drop Claude Code's built-in tools, leaving only the Apify MCP server's",
                default: false,
            },
            subscription: {
                type: 'boolean',
                description: 'Run the agent on the local Claude Code login (subscription) instead of ANTHROPIC_API_KEY',
                default: false,
            },
            'claude-judge': {
                type: 'boolean',
                description:
                    'Run the judge on the Claude Agent SDK (local Claude Code login) instead of OpenRouter, ' +
                    'so no OPENROUTER_API_KEY is needed. --judge-model then takes an Anthropic model ID.',
                default: false,
            },
            'allow-tool-errors': {
                type: 'boolean',
                description:
                    'Do not fail items on failed tool calls. Only for error-handling suites ' +
                    '(cases that provoke errors on purpose); the default gate requires zero tool errors.',
                default: false,
            },
        })
        // Langfuse batches items with `i += concurrency`, so 0 loops forever and NaN never
        // starts, reporting every item as "never completed". Reject both up front.
        .check((parsed) => {
            if (!Number.isInteger(parsed.concurrency) || parsed.concurrency < 1) {
                throw new Error(`--concurrency must be a positive integer, got "${parsed.concurrency}"`);
            }
            return true;
        })
        .help().argv) as CliArgs;

    // Different defaults per judge provider, so an unset --judge-model never sends an
    // OpenRouter slug to the Anthropic API or vice versa.
    const judgeModel = argv.judgeModel ?? (argv.claudeJudge ? MODELS.claudeJudge : MODELS.judge);

    // Fail before any test runs, listing every missing variable at once.
    const missing = findMissingEnvVars([
        ...LANGFUSE_ENV_VARS,
        'APIFY_TOKEN',
        ...(argv.claudeJudge ? [] : ['OPENROUTER_API_KEY']),
        ...(argv.subscription ? [] : ['ANTHROPIC_API_KEY']),
    ]);
    if (missing.length > 0) {
        console.error(`❌ Error: missing environment variable(s): ${missing.join(', ')}`);
        process.exit(1);
    }

    // The Agent SDK's Claude Code subprocess falls back to the local login only when no
    // API key is in its environment, which it inherits from this process.
    if (argv.subscription) {
        delete process.env.ANTHROPIC_API_KEY;
    }

    // The Agent SDK spawns the MCP server from the built binary; fail early with the fix.
    try {
        assertStdioBinExists();
    } catch (error) {
        console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    const langfuse = new LangfuseClient();
    // Non-empty: checked above. Sanitized above that.
    const apifyToken = process.env.APIFY_TOKEN as string;
    const datasetName = argv.dataset;

    let exitCode = 1;
    try {
        // Read-only: the dataset is the source of truth, edited in the Langfuse UI and
        // committed back with `evals:workflow:export-dataset`.
        console.log(`📇 Fetching dataset "${datasetName}"...`);
        const cases = await fetchWorkflowCases(langfuse, datasetName);

        // Shared helpers, so every entry point filters test cases by the same rule.
        let selected = cases;
        if (argv.id) selected = filterById(selected, argv.id);
        if (argv.category) selected = filterByCategory(selected, argv.category);
        const data = selected.map((workflowCase) => workflowCase.item);
        if (data.length === 0) {
            throw new Error(
                `No active item in dataset "${datasetName}" (${cases.length} total) matches --id/--category`,
            );
        }
        const requestedIds = data.map((item) => item.id);

        initTracing();

        // Traces each judge call as a generation nested under the item's trace.
        const llmClient = argv.claudeJudge ? new ClaudeLlmClient() : new LlmClient();

        const agentSdkVersion = resolveAgentSdkVersion();
        const runName = `${getGitBranch()}-${argv.agentModel.split('/').pop()}-${Date.now()}`;
        console.log(
            `▶️  Running experiment "${runName}" over ${data.length} item(s), concurrency ${argv.concurrency} ` +
                `(agent: ${argv.agentModel} via Claude Agent SDK ${agentSdkVersion}` +
                `${argv.mcpToolsOnly ? ', MCP tools only' : ', +built-in tools'})`,
        );

        const result = await langfuse.experiment.run({
            name: datasetName,
            runName,
            description: 'Multi-turn workflow evals for the Apify MCP server.',
            data,
            task: makeTask({
                llmClient,
                apifyToken,
                agentModel: argv.agentModel,
                judgeModel,
                toolTimeout: argv.toolTimeout,
                mcpToolsOnly: argv.mcpToolsOnly,
            }),
            evaluators,
            runEvaluators: [
                // Denominator is the requested count, not itemResults.length, so items the
                // SDK dropped pull the rate down instead of vanishing from it.
                async ({ itemResults }) => ({
                    name: 'pass_rate',
                    value: countPassed(itemResults, argv.allowToolErrors) / requestedIds.length,
                }),
            ],
            maxConcurrency: argv.concurrency,
            metadata: {
                agentModel: argv.agentModel,
                judgeModel,
                judgeProvider: argv.claudeJudge ? 'claude-agent-sdk' : 'openrouter',
                toolTimeout: argv.toolTimeout,
                mcpToolsOnly: argv.mcpToolsOnly,
                agentSdkVersion,
                agentAuth: argv.subscription ? 'subscription' : 'api-key',
                allowToolErrors: argv.allowToolErrors,
            },
        });

        // Compact on purpose: Langfuse holds the full per-item view behind the run link.
        const summary = buildRunSummary(requestedIds, result.itemResults, argv.allowToolErrors);
        for (const failure of summary.failures) {
            console.log(`❌ ${failure.id}: ${failure.reason}`);
        }
        if (summary.droppedIds.length > 0) {
            console.error(`🔥 Never completed (task threw, see errors above): ${summary.droppedIds.join(', ')}`);
        }

        console.log(`📊 ${summary.passedCount}/${requestedIds.length} passed`);
        console.log(`🔗 ${result.datasetRunUrl ?? `Run "${result.runName}" (view in Langfuse)`}`);

        // 0 only when every requested item ran and passed: a dropped item leaves
        // passedCount short of the request, so this covers it too.
        exitCode = summary.passedCount === requestedIds.length ? 0 : 1;
    } catch (error) {
        console.error(`❌ Run failed: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
    } finally {
        // Flush scores and spans before exit or the last batch is lost. Guarded
        // individually: a failed export must not skip the other flush, and an
        // unhandled rejection here would override the run's exit code.
        try {
            await langfuse.flush();
        } catch (error) {
            console.error(`⚠️ Langfuse flush failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            await shutdownTracing();
        } catch (error) {
            console.error(`⚠️ Span export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    process.exit(exitCode);
}

void main();
