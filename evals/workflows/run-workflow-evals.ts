#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/extensions */
/**
 * Main CLI entry point for workflow evaluations
 *
 * Usage:
 *   npm run evals:workflow
 *   npm run evals:workflow -- --category basic
 *   npm run evals:workflow -- --id test-001
 *   npm run evals:workflow -- --verbose
 *   npm run evals:workflow -- --concurrency 10
 */

import path from 'node:path';

import pLimit from 'p-limit';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { filterByLineRanges } from '../shared/line-range-filter.js';
import type { LineRange } from '../shared/line-range-parser.js';
import { checkRangesOutOfBounds, parseLineRanges, validateLineRanges } from '../shared/line-range-parser.js';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, MODELS } from './config.js';
import { executeConversation } from './conversation-executor.js';
import { LlmClient } from './llm-client.js';
import { McpClient } from './mcp-client.js';
import type { EvaluationResult } from './output-formatter.js';
import { formatDetailedResult, formatResultsTable } from './output-formatter.js';
import {
    loadResultsDatabase,
    saveResultsDatabase,
    updateResultsWithEvaluations,
} from './results-writer.js';
import type { WorkflowTestCase, WorkflowTestCaseWithLineNumbers } from './test-cases-loader.js';
import { filterTestCases, loadTestCases, loadTestCasesWithLineNumbers } from './test-cases-loader.js';
import { evaluateConversation } from './workflow-judge.js';

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
}

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
): Promise<EvaluationResult> {
    const testId = testCase.id;

    logWithPrefix(testId, `[${index + 1}/${total}] Running...`);

    // Create FRESH MCP instance per test for isolation
    const mcpClient = new McpClient(argv.toolTimeout);
    const startTime = Date.now();
    let result: EvaluationResult;

    try {
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
        });

        // Judge conversation
        const judgeResult = await evaluateConversation(testCase, conversation, llmClient, argv.judgeModel);

        const durationMs = Date.now() - startTime;

        result = {
            testCase,
            conversation,
            judgeResult,
            durationMs,
        };

        logWithPrefix(testId, `  ${judgeResult.verdict === 'PASS' ? '✅' : '❌'} ${judgeResult.verdict} (${durationMs}ms)`);
    } catch (error) {
        const durationMs = Date.now() - startTime;

        result = {
            testCase,
            conversation: {
                userPrompt: testCase.query,
                turns: [],
                completed: false,
                hitMaxTurns: false,
                totalTurns: 0,
            },
            judgeResult: {
                verdict: 'FAIL',
                reason: 'Error during execution',
                rawResponse: '',
            },
            durationMs,
            error: error instanceof Error ? error.message : String(error),
        };

        logWithPrefix(testId, `  🔥 ERROR (${durationMs}ms)`);
    } finally {
        // ALWAYS cleanup MCP client for this test
        try {
            await mcpClient.cleanup();
        } catch (cleanupError) {
            logWithPrefix(testId, `  ⚠️  Cleanup failed: ${cleanupError}`);
        }
    }

    // Show detailed output if verbose
    if (argv.verbose) {
        logWithPrefix(testId, '');
        logWithPrefix(testId, formatDetailedResult(result));
    }

    return result;
}

async function main() {
    // Parse CLI arguments
    const argv = await yargs(hideBin(process.argv))
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
            description: 'Filter by line range in test-cases.json '
                + '(format: "start-end" or single line, comma-separated, e.g., "10-20,50-60,100")',
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
        .help()
        .argv as CliArgs;

    console.log('='.repeat(100));
    console.log('Workflow Evaluation Runner');
    console.log('='.repeat(100));
    console.log();

    // Check environment variables
    const apifyToken = process.env.APIFY_TOKEN;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

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

    // Initialize LLM client (shared across all tests - stateless)
    const llmClient = new LlmClient();

    // Run evaluations
    console.log(`▶️  Running ${filteredTestCases.length} evaluation(s) with concurrency ${argv.concurrency}...`);
    console.log();

    // Create concurrency limiter
    const limit = pLimit(argv.concurrency!);

    // Execute tests in parallel with concurrency control
    const resultPromises = filteredTestCases.map(async (testCase, index) => {
        return limit(async () => {
            return runSingleTest(testCase, index, filteredTestCases.length, argv, llmClient, apifyToken);
        });
    });

    // Wait for all tests to complete
    const results = await Promise.all(resultPromises);

    // Save results to file if --output flag is present
    if (argv.output) {
        const resultsPath = path.join(process.cwd(), 'evals/workflows/results.json');
        try {
            const database = loadResultsDatabase(resultsPath);
            const updatedDatabase = updateResultsWithEvaluations(
                database,
                results,
                argv.agentModel!,
                argv.judgeModel!,
            );
            saveResultsDatabase(resultsPath, updatedDatabase);
            console.log(`✅ Results saved to: ${resultsPath}`);
            console.log();
        } catch (error) {
            console.error(`❌ Failed to save results: ${error}`);
            console.error('   Results will still be displayed but not persisted.');
            console.log();
        }
    }

    // Display results
    console.log(formatResultsTable(results));

    // Exit with appropriate code - ALL tests must pass
    const totalTests = results.length;
    const passedTests = results.filter((r) => !r.error && r.judgeResult.verdict === 'PASS').length;
    const errorTests = results.filter((r) => r.error).length;

    // Exit 0 only if ALL tests passed with no errors
    const allPassed = totalTests > 0 && passedTests === totalTests && errorTests === 0;
    process.exit(allPassed ? 0 : 1);
}

void main();
