#!/usr/bin/env node
/**
 * Main CLI entry point for workflow evaluations
 * 
 * Usage:
 *   npm run evals:workflow
 *   npm run evals:workflow -- --category basic
 *   npm run evals:workflow -- --id test-001
 *   npm run evals:workflow -- --verbose
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { MODELS, DEFAULT_TOOL_TIMEOUT_SECONDS } from './config.js';
import { mcpToolsToOpenAiTools } from './convert-mcp-tools.js';
import { executeConversation } from './conversation-executor.js';
import { LlmClient } from './llm-client.js';
import { McpClient } from './mcp-client.js';
import type { EvaluationResult } from './output-formatter.js';
import { formatDetailedResult, formatResultsTable } from './output-formatter.js';
import { filterTestCases, loadTestCases } from './test-cases-loader.js';
import { evaluateConversation } from './workflow-judge.js';

interface CliArgs {
    category?: string;
    id?: string;
    verbose?: boolean;
    testCasesPath?: string;
    agentModel?: string;
    judgeModel?: string;
    toolTimeout?: number;
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

    // Load and filter test cases
    console.log('📂 Loading test cases...');
    let testCases;
    try {
        testCases = loadTestCases(argv.testCasesPath);
    } catch (error) {
        console.error(`❌ Failed to load test cases: ${error}`);
        process.exit(1);
    }

    const filteredTestCases = filterTestCases(testCases, {
        id: argv.id,
        category: argv.category,
    });

    if (filteredTestCases.length === 0) {
        console.log('⚠️  No test cases found matching the filters.');
        console.log('');
        console.log('Available test cases:');
        for (const tc of testCases) {
            console.log(`  - ${tc.id} (${tc.category}): ${tc.prompt}`);
        }
        process.exit(0);
    }

    console.log(`✅ Loaded ${filteredTestCases.length} test case(s)`);
    console.log();

    // Initialize LLM client (shared across all tests - stateless)
    const llmClient = new LlmClient();

    // Run evaluations
    console.log(`▶️  Running ${filteredTestCases.length} evaluation(s)...`);
    console.log();

    const results: EvaluationResult[] = [];

    for (let i = 0; i < filteredTestCases.length; i++) {
        const testCase = filteredTestCases[i];
        console.log(`[${i + 1}/${filteredTestCases.length}] Running: ${testCase.id}...`);

        // Create FRESH MCP instance per test for isolation
        const mcpClient = new McpClient(argv.toolTimeout);
        const startTime = Date.now();
        let result: EvaluationResult;

        try {
            // Start MCP server with test-specific tools (if configured)
            await mcpClient.start(apifyToken, testCase.tools);

            // Execute conversation (tools fetched dynamically inside)
            const conversation = await executeConversation({
                userPrompt: testCase.prompt,
                mcpClient,
                llmClient,
                maxTurns: testCase.maxTurns,
                model: argv.agentModel,
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

            console.log(`  ${judgeResult.verdict === 'PASS' ? '✅' : '❌'} ${judgeResult.verdict} (${durationMs}ms)`);
        } catch (error) {
            const durationMs = Date.now() - startTime;
            
            result = {
                testCase,
                conversation: {
                    userPrompt: testCase.prompt,
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

            console.log(`  🔥 ERROR (${durationMs}ms)`);
        } finally {
            // ALWAYS cleanup MCP client for this test
            try {
                await mcpClient.cleanup();
            } catch (cleanupError) {
                console.error(`  ⚠️  Cleanup failed: ${cleanupError}`);
            }
        }

        results.push(result);

        // Show detailed output if verbose
        if (argv.verbose) {
            console.log();
            console.log(formatDetailedResult(result));
        }

        console.log();
    }

    // Display results
    console.log(formatResultsTable(results));

    // Exit with appropriate code - ALL tests must pass
    const totalTests = results.length;
    const passedTests = results.filter(r => !r.error && r.judgeResult.verdict === 'PASS').length;
    const errorTests = results.filter(r => r.error).length;

    // Exit 0 only if ALL tests passed with no errors
    const allPassed = totalTests > 0 && passedTests === totalTests && errorTests === 0;
    process.exit(allPassed ? 0 : 1);
}

main();
