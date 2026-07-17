#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for workflow evaluations
 *
 * Usage:
 *   pnpm run evals:workflow
 *   pnpm run evals:workflow -- --category basic
 *   pnpm run evals:workflow -- --id test-001
 *   pnpm run evals:workflow -- --verbose
 *   pnpm run evals:workflow -- --concurrency 10
 */

import path from 'node:path';

import pLimit from 'p-limit';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { filterByLineRanges } from '../shared/line_range_filter.js';
import type { LineRange } from '../shared/line_range_parser.js';
import { checkRangesOutOfBounds, parseLineRanges, validateLineRanges } from '../shared/line_range_parser.js';
import { DEFAULT_TEST_TIMEOUT_SECONDS, DEFAULT_TOOL_TIMEOUT_SECONDS, MODELS, sanitizeEnvValue } from './config.js';
import { executeConversation } from './conversation_executor.js';
import { LlmClient } from './llm_client.js';
import { McpClient } from './mcp_client.js';
import type { EvaluationResult, TestResultRecord } from './output_formatter.js';
import {
    aggregateRepeatedResults,
    formatDetailedResult,
    formatRepeatSummaryTable,
    formatResultsTable,
} from './output_formatter.js';
import { raceWithTimeout, TestTimeoutError } from './race_with_timeout.js';
import {
    findBaselineRecord,
    loadResultsDatabase,
    saveResultsDatabase,
    updateResultsWithEvaluations,
} from './results_writer.js';
import type { WorkflowTestCase, WorkflowTestCaseWithLineNumbers } from './test_cases_loader.js';
import { filterTestCases, loadTestCases, loadTestCasesWithLineNumbers } from './test_cases_loader.js';
import { writeTraces } from './traces_writer.js';
import type { ConversationTurn } from './types.js';
import { evaluateConversation } from './workflow_judge.js';

type CliArgs = {
    category?: string;
    id?: string;
    lines?: string;
    verbose?: boolean;
    testCasesPath?: string;
    agentModel?: string;
    judgeModel?: string;
    toolTimeout?: number;
    concurrency?: number;
    output?: boolean;
    resultsPath?: string;
    baseline?: string;
    traces?: string;
    testTimeout?: number;
    repeat?: number;
};

/**
 * Helper function to log messages with test ID prefix
 */
function logWithPrefix(testId: string, message: string): void {
    const lines = message.split('\n');
    for (const line of lines) {
        console.log(`[${testId}] ${line}`);
    }
}

/**
 * Run a single test case evaluation
 */
async function runSingleTest(
    testCase: WorkflowTestCase,
    index: number,
    total: number,
    argv: CliArgs,
    llmClient: LlmClient,
    apifyToken: string,
    attemptIndex: number,
    totalAttempts: number,
): Promise<EvaluationResult> {
    const testId = testCase.id;
    // Distinguish repeated attempts of the same test case in log output; unchanged when
    // --repeat is not used (totalAttempts === 1).
    const logId = totalAttempts > 1 ? `${testId}#${attemptIndex}/${totalAttempts}` : testId;

    logWithPrefix(logId, `[${index + 1}/${total}] Running...`);

    // Create FRESH MCP instance per test for isolation
    const mcpClient = new McpClient(argv.toolTimeout, {
        disallowedTools: testCase.disallowedTools,
        allowedCallActorTargets: testCase.allowedCallActorTargets,
        disallowedCallActorTargets: testCase.disallowedCallActorTargets,
    });
    const startTime = Date.now();
    let result: EvaluationResult;

    // Shared with executeConversation() so a timed-out test still has whatever turns
    // completed before the cutoff, instead of an empty conversation (see the catch block).
    const turnsSoFar: ConversationTurn[] = [];

    try {
        const runTest = async () => {
            // Start MCP server with test-specific tools (if configured)
            await mcpClient.start(apifyToken, testCase.tools);

            // Get server instructions (if provided)
            const serverInstructions = mcpClient.getInstructions();

            // Execute conversation (tools fetched dynamically inside)
            const conversation = await executeConversation({
                userPrompt: testCase.query,
                mcpClient,
                llmClient,
                maxTurns: testCase.maxTurns,
                model: argv.agentModel,
                serverInstructions,
                agentInstructions: testCase.agentInstructions,
                turns: turnsSoFar,
            });

            // Judge conversation
            const judgeResult = await evaluateConversation(testCase, conversation, llmClient, argv.judgeModel);

            const policyViolation = conversation.turns.some((turn) =>
                turn.toolResults.some((toolResult) => toolResult.policyViolation),
            );
            const finalJudgeResult = policyViolation
                ? {
                      ...judgeResult,
                      verdict: 'FAIL' as const,
                      reason: 'Agent violated the evaluation tool policy.',
                  }
                : judgeResult;
            return { conversation, judgeResult: finalJudgeResult };
        };

        // Keep a direct reference so a late rejection (test timed out, but the abandoned
        // work keeps running and eventually throws) doesn't surface as an unhandled rejection.
        const testPromise = runTest();
        testPromise.catch(() => {});

        const { conversation, judgeResult: finalJudgeResult } = await raceWithTimeout(
            testPromise,
            argv.testTimeout ?? DEFAULT_TEST_TIMEOUT_SECONDS,
        );

        const durationMs = Date.now() - startTime;
        result = {
            testCase,
            conversation,
            judgeResult: finalJudgeResult,
            durationMs,
            attemptIndex,
            totalAttempts,
        };

        logWithPrefix(
            logId,
            `  ${finalJudgeResult.verdict === 'PASS' ? '✅' : '❌'} ${finalJudgeResult.verdict} (${durationMs}ms)`,
        );
    } catch (error) {
        const durationMs = Date.now() - startTime;
        const timedOut = error instanceof TestTimeoutError;

        result = {
            testCase,
            conversation: {
                userPrompt: testCase.query,
                turns: turnsSoFar,
                completed: false,
                hitMaxTurns: false,
                totalTurns: turnsSoFar.length,
            },
            judgeResult: {
                verdict: 'FAIL',
                reason: timedOut ? 'Test exceeded its wall-clock timeout' : 'Error during execution',
                rawResponse: '',
            },
            durationMs,
            error: error instanceof Error ? error.message : String(error),
            timedOut,
            attemptIndex,
            totalAttempts,
        };

        logWithPrefix(logId, `  ${timedOut ? '⏱️  TIMEOUT' : '🔥 ERROR'} (${durationMs}ms)`);
    } finally {
        // ALWAYS cleanup MCP client for this test
        try {
            await mcpClient.cleanup();
        } catch (cleanupError) {
            logWithPrefix(logId, `  ⚠️  Cleanup failed: ${cleanupError}`);
        }
    }

    // Show detailed output if verbose
    if (argv.verbose) {
        logWithPrefix(logId, '');
        logWithPrefix(logId, formatDetailedResult(result));
    }

    return result;
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
        .option('lines', {
            alias: 'l',
            type: 'string',
            description:
                'Filter by line range in test-cases.json ' +
                '(format: "start-end" or single line, comma-separated, e.g., "10-20,50-60,100")',
        })
        .option('verbose', {
            type: 'boolean',
            description: 'Show detailed output for each test',
            default: false,
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
        .option('test-timeout', {
            type: 'number',
            description: `Wall-clock timeout in seconds for one whole test case (agent + judge), default: ${DEFAULT_TEST_TIMEOUT_SECONDS}`,
            default: DEFAULT_TEST_TIMEOUT_SECONDS,
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
            description: 'Save test results to JSON file',
            default: false,
        })
        .option('results-path', {
            type: 'string',
            description: 'Results JSON file (default: evals/workflows/results.json)',
        })
        .option('baseline', {
            type: 'string',
            description:
                'Results JSON file to compare against; prints byte/token deltas per test ' +
                '(default: evals/workflows/results.json)',
        })
        .option('traces', {
            type: 'string',
            description:
                'Write full per-turn traces (LLM output, tool calls, full args/results, untruncated) to this JSON file',
        })
        .option('repeat', {
            type: 'number',
            description:
                'Run each test case this many times and print an aggregated pass/completion/error-rate summary ' +
                '(default: 1). --traces and --results-path record every attempt individually, never averaged.',
            default: 1,
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

    // Load test cases (with or without line numbers based on --lines flag)
    console.log('📂 Loading test cases...');
    let testCases: WorkflowTestCase[] | WorkflowTestCaseWithLineNumbers[];
    let totalLines: number | undefined;

    try {
        if (argv.lines) {
            // Load with line number metadata
            const result = loadTestCasesWithLineNumbers(argv.testCasesPath);
            testCases = result.testCases;
            totalLines = result.totalLines;
        } else {
            // Normal load (no line tracking overhead)
            testCases = loadTestCases(argv.testCasesPath);
        }
    } catch (error) {
        console.error(`❌ Failed to load test cases: ${error}`);
        process.exit(1);
    }

    // Parse and validate line ranges (if provided)
    let lineRanges: LineRange[] | undefined;
    if (argv.lines) {
        try {
            lineRanges = parseLineRanges(argv.lines);
            validateLineRanges(lineRanges);

            // Check if ranges are out of bounds
            if (checkRangesOutOfBounds(lineRanges, totalLines!)) {
                console.error(`❌ Error: Line range out of bounds`);
                console.error(`   Test cases file has ${totalLines} lines`);
                console.error(`   Requested ranges: ${argv.lines}`);
                console.log('');
                process.exit(1);
            }
        } catch (error) {
            console.error(`❌ Failed to parse line ranges: ${error}`);
            console.log('');
            console.log('Usage: --lines <range>');
            console.log('  Single line:      --lines 100');
            console.log('  Range:            --lines 10-20');
            console.log('  Multiple ranges:  --lines 10-20,50-60,100');
            console.log('');
            process.exit(1);
        }
    }

    // Apply filters (AND logic)
    let filteredTestCases = testCases;

    // Filter by line ranges first (if provided)
    if (lineRanges && testCases.length > 0 && '_lineStart' in testCases[0]) {
        filteredTestCases = filterByLineRanges(
            filteredTestCases as WorkflowTestCaseWithLineNumbers[],
            lineRanges,
        ) as WorkflowTestCase[];
        console.log(`🔍 Filtered by line ranges ${argv.lines}: ${filteredTestCases.length} test case(s)`);
    }

    // Then apply ID/category filters
    filteredTestCases = filterTestCases(filteredTestCases, {
        id: argv.id,
        category: argv.category,
    });

    if (filteredTestCases.length === 0) {
        console.log('⚠️  No test cases found matching the filters.');
        if (!argv.lines) {
            console.log('');
            console.log('Available test cases:');
            for (const tc of testCases) {
                console.log(`  - ${tc.id} (${tc.category}): ${tc.query}`);
            }
        }
        process.exit(0);
    }

    console.log(`✅ Loaded ${filteredTestCases.length} test case(s)`);
    console.log();

    // Load baseline for byte/token deltas (read before --output overwrites results.json).
    // Matched by agent model + test ID; the judge model is ignored because bytes/tokens
    // come from the agent, so a baseline recorded with a different judge still compares.
    const resultsPath = argv.resultsPath
        ? path.resolve(process.cwd(), argv.resultsPath)
        : path.join(process.cwd(), 'evals/workflows/results.json');
    const baselinePath = argv.baseline ? path.resolve(process.cwd(), argv.baseline) : resultsPath;
    const baselineByTestId = new Map<string, TestResultRecord>();
    let baselineWithMetrics = 0;
    try {
        const baselineDb = loadResultsDatabase(baselinePath);
        for (const testCase of filteredTestCases) {
            const record = findBaselineRecord(baselineDb, argv.agentModel!, testCase.id);
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

    // Initialize LLM client (shared across all tests - stateless)
    const llmClient = new LlmClient();

    // Run evaluations
    const repeat = argv.repeat!;
    const totalJobs = filteredTestCases.length * repeat;
    console.log(
        `▶️  Running ${filteredTestCases.length} evaluation(s)` +
            (repeat > 1 ? ` × ${repeat} repeat(s) = ${totalJobs} job(s)` : '') +
            ` with concurrency ${argv.concurrency}...`,
    );
    console.log();

    // Create concurrency limiter
    const limit = pLimit(argv.concurrency!);

    // Each (test case, attempt) pair is its own job through the same limiter -- repeats of one
    // test case interleave with everything else exactly like distinct test cases do. Run
    // sequentially yourself via --concurrency 1 for a clean, low-noise comparison; --repeat
    // doesn't invent a separate scheduling mode for that.
    const jobs: { testCase: WorkflowTestCase; attemptIndex: number }[] = [];
    for (const testCase of filteredTestCases) {
        for (let attemptIndex = 1; attemptIndex <= repeat; attemptIndex++) {
            jobs.push({ testCase, attemptIndex });
        }
    }

    // Execute tests in parallel with concurrency control
    const resultPromises = jobs.map(async ({ testCase, attemptIndex }, index) => {
        return limit(async () => {
            return runSingleTest(testCase, index, totalJobs, argv, llmClient, apifyToken, attemptIndex, repeat);
        });
    });

    // Wait for all tests to complete
    const results = await Promise.all(resultPromises);

    // Save results to file if --output flag is present
    if (argv.output) {
        try {
            const database = loadResultsDatabase(resultsPath);
            const updatedDatabase = updateResultsWithEvaluations(database, results, argv.agentModel!, argv.judgeModel!);
            saveResultsDatabase(resultsPath, updatedDatabase);
            console.log(`✅ Results saved to: ${resultsPath}`);
            console.log();
        } catch (error) {
            console.error(`❌ Failed to save results: ${error}`);
            console.error('   Results will still be displayed but not persisted.');
            console.log();
        }
    }

    // Save full per-turn traces if --traces flag is present
    if (argv.traces) {
        try {
            const tracesPath = path.resolve(process.cwd(), argv.traces);
            writeTraces(tracesPath, results);
            console.log(`✅ Traces saved to: ${tracesPath}`);
            console.log();
        } catch (error) {
            console.error(`❌ Failed to save traces: ${error}`);
            console.log();
        }
    }

    // Display results (with byte/token deltas when a baseline matched) -- every individual
    // attempt, never averaged; that's what --traces and --results-path also record.
    console.log(formatResultsTable(results, baselineByTestId.size > 0 ? baselineByTestId : undefined));

    if (repeat > 1) {
        console.log(formatRepeatSummaryTable(aggregateRepeatedResults(results)));
    }

    // Exit with appropriate code - ALL tests must pass
    const totalTests = results.length;
    const passedTests = results.filter((r) => !r.error && r.judgeResult.verdict === 'PASS').length;
    const errorTests = results.filter((r) => r.error).length;

    // --repeat exists to characterize flakiness across N attempts, not to gate on one unlucky
    // run -- exit 0 regardless of individual outcomes (the summary above is for a human to read).
    // Default (repeat = 1) keeps the strict all-must-pass gate unchanged.
    if (repeat > 1) {
        process.exit(0);
    }
    const allPassed = totalTests > 0 && passedTests === totalTests && errorTests === 0;
    process.exit(allPassed ? 0 : 1);
}

void main();
