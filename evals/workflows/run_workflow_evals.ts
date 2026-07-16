#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for workflow evaluations.
 *
 * Runs the agent+judge loop through the Opik TS SDK (self-hosted): test cases are synced into an
 * Opik dataset, each case runs as an evaluate() task with a fresh MCP server, and the judge is an
 * Opik scoring metric. Traces (llm + tool spans) and experiments show up in the local Opik UI.
 *
 * Usage:
 *   pnpm run evals:workflow
 *   pnpm run evals:workflow -- --category basic
 *   pnpm run evals:workflow -- --id test-001
 *   pnpm run evals:workflow -- --concurrency 8
 */

import path from 'node:path';

// OpikSpanType, not SpanType: opik 2.1.23's runtime ESM build only exports the alias
// (the .d.ts declares both, so type-check can't catch a plain SpanType import).
import { evaluate, getTrackContext, OpikSpanType, setGlobalClient } from 'opik';
import type { EvaluationTask } from 'opik';
import { trackOpenAI } from 'opik-openai';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
    DEFAULT_TOOL_TIMEOUT_SECONDS,
    MODELS,
    OPIK_DATASET_NAME,
    OPIK_PROJECT_NAME,
    sanitizeEnvValue,
} from './config.js';
import { executeConversation } from './conversation_executor.js';
import { createOpenRouterClient, LlmClient } from './llm_client.js';
import { McpClient } from './mcp_client.js';
import {
    buildExperimentName,
    createOpikClient,
    getGitMetadata,
    OPIK_START_HINT,
    pingOpikServer,
    toDatasetItem,
} from './opik_client.js';
import type { WorkflowDatasetItem } from './opik_client.js';
import type { EvaluationResult, TestResultRecord } from './output_formatter.js';
import { formatResultsTable, sumResultBytes } from './output_formatter.js';
import {
    findBaselineRecord,
    loadResultsDatabase,
    saveResultsDatabase,
    updateResultsWithEvaluations,
} from './results_writer.js';
import type { WorkflowTestCase } from './test_cases_loader.js';
import { filterTestCases, loadTestCases } from './test_cases_loader.js';
import { WorkflowJudgeMetric } from './workflow_judge_metric.js';

type CliArgs = {
    category?: string;
    id?: string;
    testCasesPath?: string;
    agentModel: string;
    judgeModel: string;
    toolTimeout: number;
    concurrency: number;
    output?: boolean;
    baseline?: string;
};

/**
 * Helper function to log messages with test ID prefix
 */
function logWithPrefix(testId: string, message: string): void {
    for (const line of message.split('\n')) {
        console.log(`[${testId}] ${line}`);
    }
}

async function main() {
    // Parse CLI arguments
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
            description: 'Number of tests to run in parallel (default: 4)',
            default: 4,
        })
        .option('output', {
            alias: 'o',
            type: 'boolean',
            description: 'Save test results to JSON file (evals/workflows/results.json)',
            default: false,
        })
        .option('baseline', {
            type: 'string',
            description:
                'Results JSON file to compare against; prints byte/token deltas per test ' +
                '(default: evals/workflows/results.json)',
        })
        .help().argv) as CliArgs;

    console.log('='.repeat(100));
    console.log('Workflow Evaluation Runner');
    console.log('='.repeat(100));
    console.log();

    // Check environment variables
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

    // Load all test cases (full set is synced to the dataset; filters pick what runs)
    console.log('📂 Loading test cases...');
    let testCases: WorkflowTestCase[];
    try {
        testCases = loadTestCases(argv.testCasesPath);
    } catch (error) {
        console.error(`❌ Failed to load test cases: ${error}`);
        process.exit(1);
    }

    const filteredTestCases = filterTestCases(testCases, { id: argv.id, category: argv.category });

    if (filteredTestCases.length === 0) {
        console.log('⚠️  No test cases found matching the filters.');
        console.log('');
        console.log('Available test cases:');
        for (const tc of testCases) {
            console.log(`  - ${tc.id} (${tc.category}): ${tc.query}`);
        }
        process.exit(0);
    }

    console.log(`✅ Loaded ${filteredTestCases.length} test case(s)`);
    console.log();

    // Load baseline for byte/token deltas (read before --output overwrites results.json).
    // Matched by agent model + test ID; the judge model is ignored because bytes/tokens
    // come from the agent, so a baseline recorded with a different judge still compares.
    const baselinePath = argv.baseline ?? path.join(process.cwd(), 'evals/workflows/results.json');
    const baselineByTestId = new Map<string, TestResultRecord>();
    let baselineWithMetrics = 0;
    try {
        const baselineDb = loadResultsDatabase(baselinePath);
        for (const testCase of filteredTestCases) {
            const record = findBaselineRecord(baselineDb, argv.agentModel, testCase.id);
            if (!record) continue;
            baselineByTestId.set(testCase.id, record);
            // Records written before these metrics existed lack the fields at runtime.
            if (record.resultBytes !== undefined || record.totalTokens !== undefined) {
                baselineWithMetrics++;
            }
        }
        // Explain the baseline state so a missing delta is never a silent mystery.
        if (baselineWithMetrics > 0) {
            console.log(`📐 Baseline: ${baselineWithMetrics} matching result(s) with metrics from ${baselinePath}`);
        } else if (baselineByTestId.size > 0) {
            console.log(
                `📐 Baseline: ${baselineByTestId.size} matching result(s) in ${baselinePath}, but none record bytes/tokens yet. ` +
                    `Re-run once with --output to capture them, then deltas appear next run.`,
            );
        } else {
            console.log(
                `📐 No baseline for agent model ${argv.agentModel} in ${baselinePath}. ` +
                    `Run once with --output to record one (deltas need a prior --output run with the same agent model).`,
            );
        }
        console.log();
    } catch (error) {
        console.error(`⚠️  Could not load baseline from ${baselinePath}: ${error}`);
        console.log();
    }

    // Preflight: don't spend money on LLM calls if Opik is unreachable.
    const opik = createOpikClient();
    console.log(`🔌 Checking Opik server at ${opik.config.apiUrl}...`);
    if (!(await pingOpikServer())) {
        console.error(`❌ Error: Opik server is not reachable at ${opik.config.apiUrl}`);
        console.error('   Start a local Opik server, then re-run:');
        console.error(`     ${OPIK_START_HINT}`);
        console.error('   Or point OPIK_URL_OVERRIDE at a running instance.');
        process.exit(1);
    }
    setGlobalClient(opik);

    // Sync every test case into the dataset (Opik dedups identical items by content).
    console.log(`📤 Syncing ${testCases.length} test case(s) to Opik dataset "${OPIK_DATASET_NAME}"...`);
    const dataset = await opik.getOrCreateDataset<WorkflowDatasetItem>(OPIK_DATASET_NAME);
    await dataset.insert(testCases.map(toDatasetItem));

    // evaluate() has no item filter, so drive it over the filtered subset via client-side selection.
    const filteredIds = new Set(filteredTestCases.map((tc) => tc.id));
    const getAllItems = dataset.getItems.bind(dataset);
    dataset.getItems = (async (nbSamples?: number, lastRetrievedId?: string) =>
        (await getAllItems(nbSamples, lastRetrievedId)).filter((item) =>
            filteredIds.has(item.testId),
        )) as typeof dataset.getItems;

    // Shared, stateless clients: one raw OpenAI wrapped per test for agent tracing, one plain
    // (untracked) judge client so judge LLM calls stay out of the task traces.
    const agentRawClient = createOpenRouterClient();
    const judgeLlm = new LlmClient();

    const testCaseById = new Map(filteredTestCases.map((tc) => [tc.id, tc]));
    // Side channel: the task records conversation/duration/error here; the judge metric fills in
    // the verdict. Assembled into the results/console pipeline after evaluate() returns.
    const resultsById = new Map<string, EvaluationResult>();

    const task: EvaluationTask<WorkflowDatasetItem> = async (item) => {
        const testCase = testCaseById.get(item.testId);
        if (!testCase) {
            throw new Error(`Unknown dataset item test id: ${item.testId}`);
        }

        // The evaluate engine runs the task inside its trace context; spans nest under it.
        const ctx = getTrackContext();
        const parent = ctx?.span ?? ctx?.trace;

        // Fresh MCP server per test for isolation (matches the original runner).
        const mcpClient = new McpClient(argv.toolTimeout, testCase.failTools);
        const startTime = Date.now();

        // Agent LLM calls become spans under this test's trace; the judge client stays untracked.
        const agentLlm = new LlmClient(trackOpenAI(agentRawClient, { client: opik, parent, generationName: 'agent' }));

        logWithPrefix(testCase.id, 'running...');

        try {
            await mcpClient.start(apifyToken, testCase.tools);
            const serverInstructions = mcpClient.getInstructions();

            const conversation = await executeConversation({
                userPrompt: testCase.query,
                mcpClient,
                llmClient: agentLlm,
                maxTurns: testCase.maxTurns,
                model: argv.agentModel,
                serverInstructions,
                onToolResult: (toolCall, result, durationMs) => {
                    if (!parent) return;
                    const now = Date.now();
                    // Full raw result (no truncation) — local instance, this is the debug payload.
                    parent.span({
                        name: toolCall.name,
                        type: OpikSpanType.Tool,
                        input: { name: toolCall.name, arguments: toolCall.arguments },
                        output: result.success ? { result: result.result } : { error: result.error },
                        metadata: { resultBytes: result.resultBytes ?? 0, durationMs },
                        startTime: new Date(now - durationMs),
                        endTime: new Date(now),
                    });
                },
            });

            const durationMs = Date.now() - startTime;
            const resultBytes = sumResultBytes(conversation);

            resultsById.set(testCase.id, {
                testCase,
                conversation,
                // Overwritten by the judge metric; placeholder until then.
                judgeResult: { verdict: 'FAIL', reason: 'Not yet judged', rawResponse: '' },
                durationMs,
            });

            ctx?.trace?.update({
                metadata: {
                    agentModel: argv.agentModel,
                    turns: conversation.totalTurns,
                    totalTokens: conversation.totalTokens ?? 0,
                    totalResultBytes: resultBytes,
                },
            });

            logWithPrefix(testCase.id, `done in ${durationMs}ms (${conversation.totalTurns} turns)`);

            return {
                completed: conversation.completed,
                hitMaxTurns: conversation.hitMaxTurns,
                totalTurns: conversation.totalTurns,
                totalTokens: conversation.totalTokens ?? 0,
                totalResultBytes: resultBytes,
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            const message = error instanceof Error ? error.message : String(error);

            resultsById.set(testCase.id, {
                testCase,
                conversation: {
                    userPrompt: testCase.query,
                    turns: [],
                    completed: false,
                    hitMaxTurns: false,
                    totalTurns: 0,
                },
                judgeResult: { verdict: 'FAIL', reason: 'Error during execution', rawResponse: '' },
                durationMs,
                error: message,
            });

            ctx?.trace?.update({ metadata: { agentModel: argv.agentModel, error: message } });
            logWithPrefix(testCase.id, `🔥 error after ${durationMs}ms: ${message}`);

            return { completed: false, error: message };
        } finally {
            try {
                await mcpClient.cleanup();
            } catch (cleanupError) {
                logWithPrefix(testCase.id, `⚠️  cleanup failed: ${cleanupError}`);
            }
        }
    };

    const git = getGitMetadata();
    const experimentName = buildExperimentName(git.branch, argv.agentModel);

    console.log(`▶️  Running ${filteredTestCases.length} evaluation(s) as experiment "${experimentName}"...`);
    console.log();

    const evalResult = await evaluate({
        dataset,
        task,
        scoringMetrics: [new WorkflowJudgeMetric(resultsById, judgeLlm, argv.judgeModel)],
        experimentName,
        projectName: OPIK_PROJECT_NAME,
        experimentConfig: {
            agentModel: argv.agentModel,
            judgeModel: argv.judgeModel,
            toolTimeout: argv.toolTimeout,
            ...(git.branch ? { gitBranch: git.branch } : {}),
            ...(git.commit ? { gitCommit: git.commit } : {}),
            filters: { id: argv.id ?? null, category: argv.category ?? null },
        },
        taskThreads: argv.concurrency,
        client: opik,
    });
    await opik.flush();

    console.log();
    if (evalResult.resultUrl) {
        console.log(`🔗 Experiment: ${evalResult.resultUrl}`);
    }
    console.log();

    // Assemble results in the filtered order for the results/console pipeline.
    const results: EvaluationResult[] = filteredTestCases.map(
        (tc) =>
            resultsById.get(tc.id) ?? {
                testCase: tc,
                conversation: { userPrompt: tc.query, turns: [], completed: false, hitMaxTurns: false, totalTurns: 0 },
                judgeResult: { verdict: 'FAIL', reason: 'Test did not run', rawResponse: '' },
                durationMs: 0,
                error: 'Test did not run',
            },
    );

    // Save results to file if --output flag is present
    if (argv.output) {
        const resultsPath = path.join(process.cwd(), 'evals/workflows/results.json');
        try {
            const database = loadResultsDatabase(resultsPath);
            const updatedDatabase = updateResultsWithEvaluations(database, results, argv.agentModel, argv.judgeModel);
            saveResultsDatabase(resultsPath, updatedDatabase);
            console.log(`✅ Results saved to: ${resultsPath}`);
            console.log();
        } catch (error) {
            console.error(`❌ Failed to save results: ${error}`);
            console.error('   Results will still be displayed but not persisted.');
            console.log();
        }
    }

    // Display results (with byte/token deltas when a baseline matched)
    console.log(formatResultsTable(results, baselineByTestId.size > 0 ? baselineByTestId : undefined));

    // Exit with appropriate code - ALL tests must pass
    const totalTests = results.length;
    const passedTests = results.filter((r) => !r.error && r.judgeResult.verdict === 'PASS').length;
    const errorTests = results.filter((r) => r.error).length;

    // Exit 0 only if ALL tests passed with no errors
    const allPassed = totalTests > 0 && passedTests === totalTests && errorTests === 0;
    process.exit(allPassed ? 0 : 1);
}

void main();
