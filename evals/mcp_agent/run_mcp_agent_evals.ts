#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for MCP agent evaluations (Langfuse backend).
 *
 * Every run reads its test cases from the Langfuse dataset and executes the matching
 * items as an experiment: a Claude Code agent (Claude Agent SDK) driving its own freshly
 * spawned Apify MCP server, then an LLM judge. Traces, scores, and the dataset live in
 * Langfuse.
 *
 * Usage:
 *   pnpm run evals:mcp-agent
 *   pnpm run evals:mcp-agent -- --category search
 *   pnpm run evals:mcp-agent -- --id '^tasks/'     # one family, matched by its id prefix
 *   pnpm run evals:mcp-agent -- --concurrency 8
 *   pnpm run evals:mcp-agent -- --mcp-tools-only   # drop Claude Code's built-in tools
 *   pnpm run evals:mcp-agent -- --subscription     # bill the local Claude Code login, not the API
 *   pnpm run evals:mcp-agent -- --tier pr           # the fast PR-gating set
 *   pnpm run evals:mcp-agent -- --iterations 3      # 3 trials per item, pass@k / pass^k in the summary
 *   pnpm run evals:mcp-agent -- --pass-threshold 0.9 # exit 0 while the aggregate pass rate is >= 0.9
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
import type { DatasetItem } from './langfuse_dataset.js';
import { fetchMcpAgentCases, filterByTier, MCP_AGENT_DATASET_NAME } from './langfuse_dataset.js';
import { buildRunSummary, evaluators, makeTask, resolveExitCode } from './langfuse_experiment.js';
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
    tier?: 'pr' | 'full';
    dataset: string;
    agentModel: string;
    judgeModel?: string;
    toolTimeout: number;
    concurrency: number;
    mcpToolsOnly: boolean;
    subscription: boolean;
    claudeJudge: boolean;
    iterations: number;
    passThreshold: number;
};

/** Current git branch, or 'unknown' if it can't be resolved. */
function getGitBranch(): string {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

/** A dataset item repeated for `--iterations`, tagged with its 1-based trial index. */
function withIteration(item: DatasetItem, iteration: number): DatasetItem {
    return { ...item, metadata: { ...(item.metadata as Record<string, unknown> | undefined), iteration } };
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
            tier: {
                type: 'string',
                choices: ['pr', 'full'] as const,
                description: 'Only run items whose tier includes this value (default: all tiers)',
            },
            dataset: {
                type: 'string',
                description: 'Langfuse dataset to run',
                default: MCP_AGENT_DATASET_NAME,
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
            iterations: {
                type: 'number',
                description: 'Repeat each selected item N times in one run; prints pass@k / pass^k',
                default: 1,
            },
            'pass-threshold': {
                type: 'number',
                description: 'Aggregate pass rate (passed trials / requested trials) required to exit 0',
                default: 1.0,
            },
        })
        // Langfuse batches items with `i += concurrency`, so 0 loops forever and NaN never
        // starts, reporting every item as "never completed". Reject both up front.
        .check((parsed) => {
            if (!Number.isInteger(parsed.concurrency) || parsed.concurrency < 1) {
                throw new Error(`--concurrency must be a positive integer, got "${parsed.concurrency}"`);
            }
            if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1) {
                throw new Error(`--iterations must be a positive integer, got "${parsed.iterations}"`);
            }
            if (parsed['pass-threshold'] < 0 || parsed['pass-threshold'] > 1) {
                throw new Error(`--pass-threshold must be between 0 and 1, got "${parsed['pass-threshold']}"`);
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
        // Read-only: the dataset is the source of truth, edited in the Langfuse UI.
        console.log(`📇 Fetching dataset "${datasetName}"...`);
        const cases = await fetchMcpAgentCases(langfuse, datasetName);

        // Shared helpers, so every entry point filters test cases by the same rule.
        let selected = cases;
        if (argv.id) selected = filterById(selected, argv.id);
        if (argv.category) selected = filterByCategory(selected, argv.category);
        if (argv.tier) selected = filterByTier(selected, argv.tier);
        if (selected.length === 0) {
            throw new Error(
                `No active item in dataset "${datasetName}" (${cases.length} total) matches --id/--category/--tier`,
            );
        }
        const requestedIds = selected.map((mcpAgentCase) => mcpAgentCase.id);
        const { iterations } = argv;
        // One experiment.run() call, each selected item repeated `iterations` times: the
        // Langfuse v4 API has no native iteration concept, so each repeat is a shallow copy
        // tagged with metadata.iteration (1-based) and scored as its own trace/trial.
        const data = selected.flatMap((mcpAgentCase) =>
            Array.from({ length: iterations }, (_, index) => withIteration(mcpAgentCase.item, index + 1)),
        );

        initTracing();

        // Traces each judge call as a generation nested under the item's trace.
        const llmClient = argv.claudeJudge ? new ClaudeLlmClient() : new LlmClient();

        const agentSdkVersion = resolveAgentSdkVersion();
        const runName = `${getGitBranch()}-${argv.agentModel.split('/').pop()}-${Date.now()}`;
        console.log(
            `▶️  Running experiment "${runName}" over ${requestedIds.length} item(s)` +
                `${iterations > 1 ? ` x ${iterations} iteration(s)` : ''}, concurrency ${argv.concurrency} ` +
                `(agent: ${argv.agentModel} via Claude Agent SDK ${agentSdkVersion}` +
                `${argv.mcpToolsOnly ? ', MCP tools only' : ', +built-in tools'})`,
        );

        const result = await langfuse.experiment.run({
            name: datasetName,
            runName,
            description: 'MCP agent evals for the Apify MCP server (agent + selection items).',
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
                // passed trials / requested trials: requestedIds.length * iterations, so a
                // dropped trial pulls the rate down instead of vanishing from it.
                async ({ itemResults }) => ({
                    name: 'pass_rate',
                    value: buildRunSummary(requestedIds, itemResults, iterations).passRate,
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
                tier: argv.tier ?? 'all',
                iterations,
                passThreshold: argv.passThreshold,
            },
        });

        // Compact on purpose: Langfuse holds the full per-item view behind the run link.
        const summary = buildRunSummary(requestedIds, result.itemResults, iterations);

        if (iterations > 1) {
            for (const item of summary.items) {
                const outcomes = item.trials.map((trial) => (trial.passed ? '✅' : '❌')).join(' ');
                const anyPassed = item.trials.some((trial) => trial.passed);
                const allPassed = item.trials.every((trial) => trial.passed);
                console.log(
                    `🔁 ${item.id}   ${outcomes}   pass@${iterations} ${anyPassed ? '✅' : '❌'}  ` +
                        `pass^${iterations} ${allPassed ? '✅' : '❌'}`,
                );
            }
        }

        for (const failure of summary.failures) {
            const iterationSuffix = iterations > 1 ? ` (iteration ${failure.iteration})` : '';
            console.log(`❌ ${failure.id}${iterationSuffix}: ${failure.reason}`);
        }
        if (summary.droppedTrials.length > 0) {
            const dropped = summary.droppedTrials.map(
                ({ id, iteration }) => `${id}${iterations > 1 ? ` (iteration ${iteration})` : ''}`,
            );
            console.error(`🔥 Never completed (task threw, see errors above): ${dropped.join(', ')}`);
        }

        console.log(
            `📊 ${summary.passedTrials}/${summary.requestedTrials} trials passed ` +
                `(pass_rate ${summary.passRate.toFixed(2)}, threshold ${argv.passThreshold.toFixed(2)})`,
        );
        if (iterations > 1) {
            console.log(
                `📈 pass@${iterations} ${summary.passAtK}/${requestedIds.length} items · ` +
                    `pass^${iterations} ${summary.passHatK}/${requestedIds.length} items`,
            );
        }
        console.log(`🔗 ${result.datasetRunUrl ?? `Run "${result.runName}" (view in Langfuse)`}`);

        exitCode = resolveExitCode(summary, argv.passThreshold);
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
