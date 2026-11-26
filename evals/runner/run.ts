#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for MCP agent evaluations (Langfuse backend).
 *
 * A run reads its test cases from a Langfuse dataset (`--dataset`) or from JSON files in a
 * directory (`--cases`) and executes the matching ones as an experiment: a Claude Code agent
 * (Claude Agent SDK) driving its own freshly spawned Apify MCP server, then an LLM judge.
 * Traces and scores live in Langfuse.
 *
 * Usage:
 *   pnpm run evals:mcp-agent                       # the pr dataset
 *   pnpm run evals:mcp-agent -- --cases <dir>      # the case files in <dir>, not linked to a dataset
 *   pnpm run evals:mcp-agent -- --cases <dir> --link-dataset <name>  # copy the files into <name>, then link the run to it
 *   pnpm run evals:mcp-agent -- --category search
 *   pnpm run evals:mcp-agent -- --dataset mcp-server-evals-merge --id '^merge/tasks/'  # one family, by its id prefix
 *   pnpm run evals:mcp-agent -- --concurrency 8
 *   pnpm run evals:mcp-agent -- --subscription     # bill the local Claude Code login, not the API
 *   pnpm run evals:mcp-agent -- --dataset mcp-server-evals-merge  # the judged agent items
 *   pnpm run evals:mcp-agent -- --iterations 3      # 3 trials per item, pass@k / pass^k in the summary
 *   pnpm run evals:mcp-agent -- --pass-threshold 0.9 # exit 0 while the aggregate pass rate is >= 0.9
 *   pnpm run evals:mcp-agent -- --run-id ci-42          # name this run's resources after ci-42
 */

// Must be the first import: config modules read process.env at load time.
import 'dotenv/config';

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { type ExperimentItem, LangfuseClient } from '@langfuse/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { readJsonFile } from '../../src/utils/generic.js';
import { assertStdioBinExists } from '../agent/claude_agent.js';
import { MODELS } from '../config.js';
import { findMissingEnvVars, LANGFUSE_ENV_VARS, sanitizeProcessEnv } from '../environment.js';
import { ClaudeJudgeClient } from '../judge/claude_client.js';
import { OpenRouterClient } from '../judge/openrouter_client.js';
import type { McpAgentTestCase } from '../langfuse/dataset.js';
import { fetchMcpAgentCases, MCP_AGENT_PR_DATASET_NAME, toMcpAgentTestCase } from '../langfuse/dataset.js';
import { copyCasesToDataset } from '../langfuse/dataset_copy.js';
import { initTracing, shutdownTracing } from '../langfuse/tracing.js';
import { createRunId, validateRunId } from '../run_id.js';
import { readCaseFiles, toExperimentItem } from './case_files.js';
import {
    buildExperimentUrl,
    buildGateBreakdown,
    buildRunSummary,
    createExperimentTask,
    EVALUATORS,
    expandIterations,
    formatGateBreakdown,
    formatRunSummary,
    formatStepSummary,
    formatTeardownHint,
    resolveExitCode,
    resolveGitBranch,
    validateCaseSource,
    validateConcurrency,
    validateIterations,
    validatePassThreshold,
} from './experiment.js';
import { filterByCategory, filterById } from './filters.js';

// Before any client is constructed below: the Langfuse SDK and the Apify client read
// process.env themselves and pass it to node:http, which throws ERR_INVALID_CHAR on a
// CI secret with a newline. Imported config that reads env at load time (OPENROUTER_CONFIG)
// runs before this and sanitizes its own values.
sanitizeProcessEnv();

/**
 * Maximum time to wait for a single MCP tool call to complete, in seconds.
 * Actor runs that take longer than this will timeout.
 * For long-running Actors, increase this value via CLI: --tool-timeout 600
 */
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 60;

/**
 * Default `--pass-threshold` (passed trials / requested trials) for exit code 0.
 *
 * Below 1.0 because two tool-call items in the pr dataset are kept although Haiku misses them
 * about one run in three: `pr/call-actor/ecommerce-scraper-iphone` (searches for an Actor the query
 * names) and `pr/search-apify-docs/error-handling-actors` (answers from memory). The miss is
 * the signal, not a case defect. 0.9 is the same gate CI applies, under the 0.93 floor of three
 * local runs and the 0.97 a hosted runner measured (111/115).
 */
export const DEFAULT_PASS_THRESHOLD = 0.9;

type CliArgs = {
    category?: string;
    id?: string;
    cases?: string;
    dataset?: string;
    linkDataset?: string;
    agentModel: string;
    judgeModel?: string;
    toolTimeout: number;
    concurrency: number;
    mcpToolsOnly: boolean;
    subscription: boolean;
    claudeJudge: boolean;
    iterations: number;
    passThreshold: number;
    runId?: string;
};

/** Current git branch, with `resolveGitBranch()`'s CI env fallbacks when git can't name one. */
function getGitBranch(): string {
    let rawBranch = '';
    try {
        // stderr discarded: outside a checkout git's `fatal:` is noise, not a failure.
        rawBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        // Not a git checkout; the env fallbacks decide.
    }
    return resolveGitBranch(rawBranch, process.env);
}

/** Commit the run executes, `unknown` outside a checkout that has no `GITHUB_SHA` either. */
function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return process.env.GITHUB_SHA || 'unknown';
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

/** Parsed CLI args, with `judgeModel` resolved to its provider-specific default. */
type ParsedCliArgs = Omit<CliArgs, 'judgeModel'> & { judgeModel: string };

/**
 * Declares the CLI, then validates it: flag sanity checks, required env vars, and the
 * built MCP server binary. Everything here can exit the process before any LLM spend.
 * Under `--subscription` it also removes `ANTHROPIC_API_KEY` from `process.env`.
 */
async function parseCliArgs(): Promise<ParsedCliArgs> {
    // pnpm forwards the `--` itself, and yargs reads it as end-of-options and ignores
    // every flag behind it. Drop it so both call styles work.
    const args = hideBin(process.argv).filter((arg) => arg !== '--');

    // yargs infers the kebab-case key, not the camelCase alias, hence the cast.
    const argv = (await yargs(args)
        .options({
            category: { type: 'string', description: 'Filter by test case category (supports * wildcard)' },
            id: { type: 'string', description: 'Run test cases whose ID matches this regex' },
            cases: {
                type: 'string',
                description:
                    'Directory of case files (*.json) to run instead of a dataset; ' +
                    'its name is the tier in the experiment name',
            },
            dataset: {
                type: 'string',
                description:
                    'Langfuse dataset to run; mcp-server-evals-merge holds the judged agent items ' +
                    `(default without --cases: ${MCP_AGENT_PR_DATASET_NAME})`,
            },
            'link-dataset': {
                type: 'string',
                description:
                    'With --cases: copy the case files into this Langfuse dataset (items not in the files ' +
                    'are archived), then link the run to it',
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
                description: "No effect: the agent never gets Claude Code's built-in tools",
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
                default: DEFAULT_PASS_THRESHOLD,
            },
            'run-id': {
                type: 'string',
                description:
                    'Identifier this run names its resources after ([a-z0-9-]); generated when omitted. ' +
                    'CI passes <github.run_id>-<github.run_attempt> so its teardown step matches the same names.',
            },
        })
        // Reject a bad run flag up front, before any LLM spend.
        .check((parsed) => {
            validateCaseSource({
                cases: parsed.cases,
                dataset: parsed.dataset,
                linkDataset: parsed['link-dataset'],
            });
            validateConcurrency(parsed.concurrency);
            validateIterations(parsed.iterations);
            validatePassThreshold(parsed['pass-threshold']);
            if (parsed['run-id'] !== undefined) validateRunId(parsed['run-id']);
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

    return { ...argv, judgeModel };
}

/** What a run needs from its case source, whichever of `--dataset` and `--cases` it is. */
type LoadedCases = {
    /** For messages, e.g. `dataset "mcp-server-evals-pr"`. */
    label: string;
    cases: (McpAgentTestCase & { item: ExperimentItem })[];
    experimentName: string;
    runName: string;
    metadata: Record<string, string>;
    /**
     * Whether the items belong to a hosted dataset. Only then does the Langfuse SDK store the
     * run-level scores and return a run URL.
     */
    isDatasetRun: boolean;
};

async function loadDatasetCases(langfuse: LangfuseClient, argv: ParsedCliArgs): Promise<LoadedCases> {
    const datasetName = argv.dataset ?? MCP_AGENT_PR_DATASET_NAME;
    // Read-only: this dataset is edited in the Langfuse UI.
    console.log(`📇 Fetching dataset "${datasetName}"...`);
    return {
        label: `dataset "${datasetName}"`,
        cases: await fetchMcpAgentCases(langfuse, datasetName),
        experimentName: datasetName,
        runName: `${getGitBranch()}-${argv.agentModel.split('/').pop()}-${Date.now()}`,
        metadata: {},
        isDatasetRun: true,
    };
}

/**
 * Reads the case files and, under `--link-dataset`, copies them into that dataset first. The
 * copy finishes here, before any LLM spend: see `copyCasesToDataset()` for why it cannot run later.
 * The items always carry the text from the files, never the hosted item's.
 */
async function loadFileCases(langfuse: LangfuseClient, casesDir: string, linkDataset?: string): Promise<LoadedCases> {
    const items = readCaseFiles(casesDir);
    console.log(`📇 Read ${items.length} case(s) from "${casesDir}"`);

    let datasetId: string | undefined;
    if (linkDataset !== undefined) {
        // Every case, whatever --id/--category select: a partial copy would archive the rest.
        const copied = await copyCasesToDataset(langfuse, linkDataset, items);
        datasetId = copied.datasetId;
        console.log(
            `📤 Copied ${items.length} case(s) to dataset "${linkDataset}", archived ${copied.archivedIds.length}` +
                `${copied.archivedIds.length > 0 ? `: ${copied.archivedIds.join(', ')}` : ''}`,
        );
    }

    // `evals/cases/pr` -> `pr`.
    const tier = path.basename(path.resolve(casesDir));
    const branch = getGitBranch();
    const commit = getGitCommit();
    return {
        label: `"${casesDir}"`,
        cases: items.map((item) => ({ ...toMcpAgentTestCase(item), item: toExperimentItem(item, datasetId) })),
        experimentName: `mcp-server-evals-${tier}`,
        runName: `${tier}-${branch}-${commit.slice(0, 7)}`,
        metadata: { commit, branch, tier },
        isDatasetRun: datasetId !== undefined,
    };
}

async function main() {
    const argv = await parseCliArgs();
    const { judgeModel } = argv;

    const langfuse = new LangfuseClient();
    // Non-empty: checked in parseCliArgs(). Sanitized at module load.
    const apifyToken = process.env.APIFY_TOKEN as string;

    let exitCode = 1;
    let runId: string | undefined;
    let hasAgentCases = false;
    try {
        const loaded =
            argv.cases === undefined
                ? await loadDatasetCases(langfuse, argv)
                : await loadFileCases(langfuse, argv.cases, argv.linkDataset);
        const { cases, experimentName, runName } = loaded;

        // Shared helpers, so every entry point filters test cases by the same rule.
        let selected = cases;
        if (argv.id) selected = filterById(selected, argv.id);
        if (argv.category) selected = filterByCategory(selected, argv.category);
        if (selected.length === 0) {
            throw new Error(`No case in ${loaded.label} (${cases.length} total) matches --id/--category`);
        }
        const requestedIds = selected.map((mcpAgentCase) => mcpAgentCase.id);
        hasAgentCases = selected.some((mcpAgentCase) => mcpAgentCase.kind === 'agent');
        const { iterations } = argv;
        runId = argv.runId ?? createRunId();
        // One experiment.run() call over every requested item x iteration: see
        // expandIterations() for why the Langfuse v4 API forces this shape.
        const data = expandIterations(
            selected.map((mcpAgentCase) => mcpAgentCase.item),
            iterations,
        );

        // Only the link of a run outside a dataset needs it. Asked for before the run, so a
        // failing call costs no LLM spend.
        const projectId = loaded.isDatasetRun ? undefined : (await langfuse.api.projects.get()).data[0].id;

        initTracing();

        // Traces each judge call as a generation nested under the item's trace.
        const llmClient = argv.claudeJudge ? new ClaudeJudgeClient() : new OpenRouterClient();

        const agentSdkVersion = resolveAgentSdkVersion();
        console.log(
            `▶️  Running experiment "${runName}" over ${requestedIds.length} item(s)` +
                `${iterations > 1 ? ` x ${iterations} iteration(s)` : ''}, concurrency ${argv.concurrency} ` +
                `(agent: ${argv.agentModel} via Claude Agent SDK ${agentSdkVersion}` +
                `${argv.subscription ? ', Claude Code login' : ', ANTHROPIC_API_KEY'}` +
                ', MCP tools only' +
                `; judge: ${judgeModel} via ${argv.claudeJudge ? 'Claude Code login' : 'OpenRouter'})`,
        );

        const result = await langfuse.experiment.run({
            name: experimentName,
            runName,
            description: 'MCP agent evals for the Apify MCP server (agent + tool-call items).',
            data,
            task: createExperimentTask({
                llmClient,
                apifyToken,
                agentModel: argv.agentModel,
                judgeModel,
                toolTimeout: argv.toolTimeout,
                mcpToolsOnly: argv.mcpToolsOnly,
                totalTrials: requestedIds.length * iterations,
                runId,
            }),
            evaluators: EVALUATORS,
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
                iterations,
                passThreshold: argv.passThreshold,
                runId,
                ...loaded.metadata,
            },
        });

        let experimentUrl = result.datasetRunUrl;
        if (projectId !== undefined) {
            // The SDK computes the run-level scores but stores them only for a dataset run.
            for (const evaluation of result.runEvaluations) {
                langfuse.score.create({ datasetRunId: result.experimentId, ...evaluation });
            }
            // Non-empty: checked in parseCliArgs().
            experimentUrl = buildExperimentUrl(process.env.LANGFUSE_BASE_URL as string, projectId, result.experimentId);
        }

        // Compact on purpose: Langfuse holds the full per-item view behind the run link.
        const summary = buildRunSummary(requestedIds, result.itemResults, iterations);
        const gateBreakdown = buildGateBreakdown(
            summary,
            new Set(selected.filter((mcpAgentCase) => mcpAgentCase.gate === 'blocking').map(({ id }) => id)),
        );

        for (const { stream, text } of formatRunSummary(summary, argv.passThreshold, iterations)) {
            (stream === 'error' ? console.error : console.log)(text);
        }
        console.log(`🚦 By gate: ${formatGateBreakdown(gateBreakdown)}`);
        console.log(`🔗 ${experimentUrl ?? `Run "${result.runName}" (view in Langfuse)`}`);
        if (process.env.GITHUB_STEP_SUMMARY) {
            fs.appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                formatStepSummary({
                    runName,
                    summary,
                    passThreshold: argv.passThreshold,
                    gateBreakdown,
                    experimentUrl,
                }),
            );
        }

        exitCode = resolveExitCode(summary, argv.passThreshold);
    } catch (error) {
        console.error(`❌ Run failed: ${error instanceof Error ? error.message : String(error)}`);
        exitCode = 1;
    } finally {
        // In the finally: a run that crashed may already have created schedules or tasks under this id.
        // Not for a run of tool-call cases only: nothing executes, so they create nothing.
        if (runId && hasAgentCases) {
            for (const line of formatTeardownHint(runId)) console.log(line);
        }

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
