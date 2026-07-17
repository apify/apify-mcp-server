#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Host-side orchestrator for the workflow evaluations.
 *
 * Harbor executes each test case in Docker and Opik observes via the native `opik harbor run`
 * integration (traces only, no Opik experiments or datasets). This orchestrator:
 *   1. generates one Harbor task dir per (filtered) test case from test_cases.json,
 *   2. builds the shared prebuilt image the tasks reference,
 *   3. invokes `opik harbor run` through the uv sub-package with mapped flags,
 *   4. reads each trial's reward and propagates the exit code (0 only if every trial passed).
 *
 * Usage:
 *   pnpm run evals:workflow
 *   pnpm run evals:workflow -- --harness ts-executor --id search-google-maps
 *   pnpm run evals:workflow -- --category search --concurrency 8
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
    DEFAULT_TOOL_TIMEOUT_SECONDS,
    DOCKER_IMAGE_TAG,
    MODELS,
    OPIK_LOCAL_API_URL,
    OPIK_PROJECT_NAME,
    OPIK_WORKSPACE,
    sanitizeEnvValue,
} from './config.js';
import {
    buildEnvPassthroughArgs,
    buildHarborRunArgs,
    DEFAULT_AGENT_MODELS,
    HARNESS,
    resolveAgentModel,
} from './harness.js';
import type { TrialOutcome } from './output_formatter.js';
import { formatResultsTable, summarize } from './output_formatter.js';
import { partitionForHarness, resetTasksRoot, writeTaskDir } from './task_generator.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import { filterTestCases, loadTestCases } from './test_cases_loader.js';

type CliArgs = {
    harness: HARNESS;
    category?: string;
    id?: string;
    agentModel?: string;
    judgeModel: string;
    toolTimeout: number;
    concurrency: number;
};

const REPO_ROOT = process.cwd();
const HARBOR_DIR = path.join(REPO_ROOT, 'evals/workflows/harbor');
const TASKS_DIR = path.join(HARBOR_DIR, 'tasks');
const JOBS_DIR = path.join(HARBOR_DIR, 'jobs');
const DOCKERFILE = path.join(HARBOR_DIR, 'Dockerfile');

/** Run a command with inherited stdio; resolve with its exit code. */
async function runStreaming(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT): Promise<number> {
    return await new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
        child.on('error', (error) => {
            console.error(`Failed to spawn ${command}: ${error.message}`);
            resolve(1);
        });
        child.on('close', (code) => resolve(code ?? 1));
    });
}

/** Recursively collect every result.json path under a directory. */
function findResultFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...findResultFiles(full));
        } else if (entry.name === 'result.json') {
            found.push(full);
        }
    }
    return found;
}

/** Extract the judge reason the verifier printed to stdout (everything after "REASON:"). */
function readJudgeReason(trialDir: string): string | undefined {
    const stdoutPath = path.join(trialDir, 'verifier', 'test-stdout.txt');
    if (!existsSync(stdoutPath)) return undefined;
    const stdout = readFileSync(stdoutPath, 'utf8');
    // run_judge.ts prints "VERDICT:\nREASON:<reason>" with REASON last, so capture to end of
    // output; collapse whitespace so a multi-line reason stays one table row.
    const match = stdout.match(/REASON:\s*([\s\S]*)$/);
    return match ? match[1].trim().replace(/\s+/g, ' ') : undefined;
}

type HarborTrialResult = {
    task_name?: string;
    verifier_result?: { rewards?: Record<string, number> | null } | null;
    exception_info?: { exception_message?: string } | null;
};

/** Parse one trial's result.json + verifier stdout into a keyed outcome (by test id). */
function parseTrialOutcome(resultPath: string, categoryById: Map<string, string>): TrialOutcome | undefined {
    let result: HarborTrialResult;
    try {
        result = JSON.parse(readFileSync(resultPath, 'utf8')) as HarborTrialResult;
    } catch {
        return undefined;
    }
    if (!result.task_name) return undefined;

    const id = result.task_name.split('/').pop() as string;
    const reward = result.verifier_result?.rewards?.reward ?? null;
    const trialDir = path.dirname(resultPath);

    let reason: string;
    if (reward === null) {
        reason = result.exception_info?.exception_message ?? 'No reward recorded (verifier did not run)';
    } else {
        reason = readJudgeReason(trialDir) ?? `reward=${reward}`;
    }

    return { id, category: categoryById.get(id), reward, reason };
}

/** Read env var, sanitized. */
function env(name: string): string | undefined {
    return sanitizeEnvValue(process.env[name]);
}

async function main() {
    // `pnpm run evals:workflow -- --flag` forwards a leading `--` that yargs would treat as an
    // options terminator; drop it so the flags parse.
    const rawArgs = hideBin(process.argv);
    if (rawArgs[0] === '--') rawArgs.shift();

    const argv = (await yargs(rawArgs)
        .option('harness', {
            type: 'string',
            choices: [HARNESS.CLAUDE_CODE, HARNESS.TS_EXECUTOR],
            description: 'Agent harness to run',
            default: HARNESS.CLAUDE_CODE,
        })
        .option('category', { type: 'string', description: 'Filter by test case category' })
        .option('id', { type: 'string', description: 'Run a specific test case by id' })
        .option('agent-model', {
            type: 'string',
            description:
                `Agent model; passed through verbatim. Default per harness: ` +
                `claude-code=${DEFAULT_AGENT_MODELS[HARNESS.CLAUDE_CODE]}, ` +
                `ts-executor=${DEFAULT_AGENT_MODELS[HARNESS.TS_EXECUTOR]}`,
        })
        .option('judge-model', {
            type: 'string',
            description: `Judge model (default: ${MODELS.judge})`,
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
            description: 'Concurrent trials (maps to harbor -n, default: 4)',
            default: 4,
        })
        .help().argv) as CliArgs;

    console.log('='.repeat(100));
    console.log(`Workflow Evaluation Runner (harness: ${argv.harness})`);
    console.log('='.repeat(100));

    // Required secrets. ts-executor uses OpenRouter; claude-code additionally needs Anthropic.
    const apifyToken = env('APIFY_TOKEN');
    const openrouterKey = env('OPENROUTER_API_KEY');
    const anthropicKey = env('ANTHROPIC_API_KEY');
    if (!apifyToken) {
        console.error('❌ APIFY_TOKEN is required');
        process.exit(1);
    }
    if (!openrouterKey) {
        console.error('❌ OPENROUTER_API_KEY is required');
        process.exit(1);
    }
    if (argv.harness === HARNESS.CLAUDE_CODE && !anthropicKey) {
        console.error('❌ ANTHROPIC_API_KEY is required for the claude-code harness');
        console.error('   Set it, or run the ts-executor harness: --harness ts-executor');
        process.exit(1);
    }

    // Load and filter test cases.
    let testCases: WorkflowTestCase[];
    try {
        testCases = loadTestCases();
    } catch (error) {
        console.error(`❌ Failed to load test cases: ${error}`);
        process.exit(1);
    }
    const filtered = filterTestCases(testCases, { id: argv.id, category: argv.category });
    if (filtered.length === 0) {
        console.error('❌ No trials executed: no test cases matched the filters.');
        process.exit(1);
    }

    const { runnable, skipped } = partitionForHarness(filtered, argv.harness);
    for (const testCase of skipped) {
        console.log(`⏭️  Skipping ${testCase.id}: uses failTools, which the claude-code harness cannot inject.`);
    }
    if (runnable.length === 0) {
        console.error(`❌ No trials executed: all matched test cases were skipped for the ${argv.harness} harness.`);
        process.exit(1);
    }

    // 1. Generate task dirs (build output; regenerated each run).
    console.log(`\n📝 Generating ${runnable.length} Harbor task(s) in ${TASKS_DIR}`);
    resetTasksRoot(TASKS_DIR);
    const categoryById = new Map<string, string>();
    for (const testCase of runnable) {
        categoryById.set(testCase.id, testCase.category);
        writeTaskDir(TASKS_DIR, { testCase, harness: argv.harness, toolTimeoutSeconds: argv.toolTimeout });
    }

    // 2. Build the shared prebuilt image.
    console.log(`\n🐳 Building image ${DOCKER_IMAGE_TAG}`);
    const buildEnv = { ...process.env, DOCKER_BUILDKIT: '1' };
    const buildCode = await runStreaming(
        'docker',
        ['build', '-f', DOCKERFILE, '-t', DOCKER_IMAGE_TAG, REPO_ROOT],
        buildEnv,
    );
    if (buildCode !== 0) {
        console.error('❌ Image build failed');
        process.exit(1);
    }

    // 3. Invoke `opik harbor run` through the uv sub-package.
    rmSync(JOBS_DIR, { recursive: true, force: true });
    mkdirSync(JOBS_DIR, { recursive: true });

    const agentModel = resolveAgentModel(argv.harness, argv.agentModel);
    const harborArgs = buildHarborRunArgs({
        harness: argv.harness,
        tasksDir: TASKS_DIR,
        jobsDir: JOBS_DIR,
        agentModel,
        concurrency: argv.concurrency,
    });
    const passthrough = buildEnvPassthroughArgs({
        harness: argv.harness,
        apifyToken,
        openrouterKey,
        anthropicKey,
        judgeModel: argv.judgeModel,
        toolTimeoutSeconds: argv.toolTimeout,
    });

    const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPIK_URL_OVERRIDE: env('OPIK_URL_OVERRIDE') || OPIK_LOCAL_API_URL,
        OPIK_WORKSPACE: OPIK_WORKSPACE,
        OPIK_PROJECT_NAME: OPIK_PROJECT_NAME,
        // Make the custom ts-executor agent importable by its `module:ClassName` path.
        PYTHONPATH: process.env.PYTHONPATH ? `${HARBOR_DIR}:${process.env.PYTHONPATH}` : HARBOR_DIR,
    };

    console.log(`\n▶️  opik harbor run (${runnable.length} task(s), project "${OPIK_PROJECT_NAME}")\n`);
    const harborCode = await runStreaming(
        'uv',
        ['run', '--project', HARBOR_DIR, 'opik', 'harbor', ...harborArgs, ...passthrough],
        childEnv,
    );

    // 4. Collect outcomes and print the summary.
    const parsed = new Map<string, TrialOutcome>();
    for (const resultPath of findResultFiles(JOBS_DIR)) {
        const outcome = parseTrialOutcome(resultPath, categoryById);
        if (outcome) parsed.set(outcome.id, outcome);
    }
    const outcomes: TrialOutcome[] = runnable.map(
        (testCase) =>
            parsed.get(testCase.id) ?? {
                id: testCase.id,
                category: testCase.category,
                reward: null,
                reason: 'No result produced by Harbor',
            },
    );

    console.log(
        `\n${formatResultsTable(
            outcomes,
            skipped.map((testCase) => testCase.id),
        )}`,
    );

    // Exit 0 only if harbor succeeded and every executed trial passed.
    const { passed, total } = summarize(outcomes);
    const allPassed = harborCode === 0 && total > 0 && passed === total;
    process.exit(allPassed ? 0 : 1);
}

void main();
