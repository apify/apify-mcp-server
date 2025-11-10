#!/usr/bin/env tsx
/**
 * Main evaluation script for MCP tool calling (TypeScript version).
 */

import { createClient } from '@arizeai/phoenix-client';
// eslint-disable-next-line import/extensions
import { getDatasetInfo } from '@arizeai/phoenix-client/datasets';
// eslint-disable-next-line import/extensions
import { asEvaluator, runExperiment } from '@arizeai/phoenix-client/experiments';
import type { ExperimentEvaluationRun, ExperimentTask } from '@arizeai/phoenix-client/types/experiments';
import dotenv from 'dotenv';
import yargs from 'yargs';
// eslint-disable-next-line import/extensions
import { hideBin } from 'yargs/helpers';

import log from '@apify/log';

import {
    loadTools,
    createOpenRouterTask,
    createToolSelectionLLMEvaluator
} from './evaluation-utils.js';
import {
    DATASET_NAME,
    MODELS_TO_EVALUATE,
    PASS_THRESHOLD,
    EVALUATOR_NAMES,
    type EvaluatorName,
    sanitizeHeaderValue,
    validateEnvVars
} from './config.js';

interface EvaluatorResult {
    model: string;
    experimentName: string;
    experimentId: string;
    evaluatorName: EvaluatorName;
    accuracy: number;
    correct: number;
    total: number;
    passed: boolean;
    error?: string;
}

/**
 * Interface for command line arguments
 */
interface CliArgs {
    datasetName?: string;
}

log.setLevel(log.LEVELS.DEBUG);

const RUN_LLM_EVALUATOR = true;
const RUN_TOOLS_EXACT_MATCH_EVALUATOR = true;

dotenv.config({ path: '.env' });

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
    .wrap(null) // Disable automatic wrapping to avoid issues with long lines
    .usage('Usage: $0 [options]')
    .env()
    .option('dataset-name', {
        type: 'string',
        describe: 'Custom dataset name to evaluate (default: from config.ts)',
        example: 'my_custom_dataset',
    })
    .help('help')
    .alias('h', 'help')
    .version(false)
    .epilogue('Examples:')
    .epilogue('  $0                                    # Use default dataset from config')
    .epilogue('  $0 --dataset-name tmp-1               # Evaluate custom dataset')
    .epilogue('  npm run evals:run -- --dataset-name custom_v1  # Via npm script')
    .parseSync() as CliArgs;

// Sanitize secrets early to avoid invalid header characters in CI
process.env.OPENROUTER_API_KEY = sanitizeHeaderValue(process.env.OPENROUTER_API_KEY);

// Tools match evaluator: returns score 1 if expected tool_calls match output list, 0 otherwise
const toolsExactMatch = asEvaluator({
    name: EVALUATOR_NAMES.TOOLS_EXACT_MATCH,
    kind: 'CODE',
    evaluate: async ({ output, expected }: any) => {
        log.info(`Evaluating tools match. Expected: ${JSON.stringify(expected)}, Output: ${JSON.stringify(output)}`);

        let expectedTools = expected?.expectedTools || [];
        if (typeof expectedTools === 'string') {
            expectedTools = expectedTools.split(', ');
        }

        if (!expectedTools || expectedTools.length === 0) {
            log.debug('Tools match: No expected tools provided');
            return {
                score: 1.0,
                explanation: 'No expected tools present in the test case, either not required or not provided',
            };
        }

        // Normalize tool names: treat call-actor with step="info" as equivalent to fetch-actor-details
        const normalizeToolName = (toolName: string): string => {
            // Normalize call-actor to fetch-actor-details (bidirectional equivalence)
            if (toolName === 'call-actor' || toolName === 'fetch-actor-details') {
                return 'fetch-actor-details';
            }
            return toolName;
        };

        const normalizeToolCall = (toolCall: any): string => {
            const toolName = toolCall.function?.name || '';

            // If it's call-actor with step="info", treat it as fetch-actor-details
            if (toolName === 'call-actor') {
                try {
                    const args = JSON.parse(toolCall.function?.arguments || '{}');
                    if (args.step === 'info') {
                        return 'fetch-actor-details';
                    }
                } catch (e) {
                    // If we can't parse arguments, just return the tool name
                }
            }

            return toolName;
        };

        // Normalize expected tools (both call-actor and fetch-actor-details → fetch-actor-details)
        const normalizedExpectedTools = [...expectedTools]
            .map(normalizeToolName)
            .sort();

        const outputToolsTmp = (output?.tool_calls || [])
            .map(normalizeToolCall)
            .sort();

        const outputToolsSet = Array.from(new Set(outputToolsTmp)).sort();
        // it is correct if outputTools includes multiple calls to the same tool
        const isCorrect = JSON.stringify(normalizedExpectedTools) === JSON.stringify(outputToolsSet);
        const score = isCorrect ? 1.0 : 0.0;
        const explanation = `Expected: ${JSON.stringify(normalizedExpectedTools)}, Got: ${JSON.stringify(outputToolsSet)}`;

        log.debug(`🤖 Tools exact match: score=${score}, output=${JSON.stringify(outputToolsSet)}, expected=${JSON.stringify(normalizedExpectedTools)}`);

        return {
            score,
            explanation,
        };
    },
});


function processEvaluatorResult(
    experiment: any,
    modelName: string,
    experimentName: string,
    evaluatorName: EvaluatorName
): EvaluatorResult {
    const runsMap = experiment.runs ?? {};
    const evalRuns = experiment.evaluationRuns ?? [];
    const total = Object.keys(runsMap).length;

    const evaluatorRuns = evalRuns.filter((er: ExperimentEvaluationRun) => er.name === evaluatorName);
    const correct = evaluatorRuns.filter((er: ExperimentEvaluationRun) => (er.result?.score ?? 0) > 0.5).length;
    const accuracy = total > 0 ? correct / total : 0;

    return {
        model: modelName,
        experimentName,
        experimentId: experiment.id,
        evaluatorName,
        accuracy,
        correct,
        total,
        passed: accuracy >= PASS_THRESHOLD,
    };
}


function printResults(results: EvaluatorResult[]): void {
    log.info('📊 Results:');
    for (const result of results) {
        const { model, evaluatorName, accuracy, correct, total, passed, error } = result;
        if (error) {
            log.info(`${model}: ${evaluatorName} ❌ Error`);
        } else {
            const status = passed ? 'PASS' : 'FAIL';
            log.info(`${model}: ${evaluatorName} ${(accuracy * 100).toFixed(1)}% (${correct}/${total}) ${status}`);
        }
    }

    log.info(`\nPass threshold: ${(PASS_THRESHOLD * 100).toFixed(1)}%`);
    const allPassed = results.every(r => !r.error && r.passed);
    if (allPassed) {
        log.info('All tests passed');
    } else {
        log.info('Some tests failed');
    }
}

async function main(datasetName: string): Promise<number> {
    log.info('Starting MCP tool calling evaluation');

    if (!validateEnvVars()) {
        return 1;
    }

    const tools = await loadTools();
    log.info(`Loaded ${tools.length} tools`);

    // Phoenix client init (options may be provided via env)
    const client = createClient({
        options: {
            baseUrl: process.env.PHOENIX_BASE_URL!,
            headers: { Authorization: `Bearer ${sanitizeHeaderValue(process.env.PHOENIX_API_KEY)}` },
        },
    });

    // Resolve dataset by name -> id
    let datasetId: string | undefined;
    try {
        const info = await getDatasetInfo({ client, dataset: { datasetName } });
        datasetId = info?.id as string | undefined;
    } catch (e) {
        log.error(`Error loading dataset: ${e}`);
        return 1;
    }

    if (!datasetId) throw new Error(`Dataset "${datasetName}" not found`);

    log.info(`Loaded dataset "${datasetName}" with ID: ${datasetId}`);

    const results: EvaluatorResult[] = [];

    // Create the LLM evaluator with loaded tools
    const toolSelectionLLMEvaluator = createToolSelectionLLMEvaluator(tools);

    for (const modelName of MODELS_TO_EVALUATE) {
        log.info(`\nEvaluating model: ${modelName}`);

        // OpenRouter task
        const taskFn = createOpenRouterTask(modelName, tools);

        // Get PR info for better tracking
        const prNumber = process.env.GITHUB_PR_NUMBER || 'local';
        const prLabel = prNumber === 'local' ? 'local run' : `PR #${prNumber}`;

        const experimentName = `MCP server:  ${modelName}`;
        const experimentDescription = `${modelName}, ${prLabel}`;

        const evaluators = [];
        if (RUN_TOOLS_EXACT_MATCH_EVALUATOR) {
            evaluators.push(toolsExactMatch);
        }
        if (RUN_LLM_EVALUATOR) {
            evaluators.push(toolSelectionLLMEvaluator);
        }

        try {
            const experiment = await runExperiment({
                client,
                dataset: { datasetName },
                // Cast to satisfy ExperimentTask type
                task: taskFn as ExperimentTask,
                evaluators,
                experimentName,
                experimentDescription,
                concurrency: 10,
            });
            log.info(`Experiment run completed`);

            // Process each evaluator separately
            results.push(processEvaluatorResult(experiment, modelName, experimentName, EVALUATOR_NAMES.TOOLS_EXACT_MATCH));
            results.push(processEvaluatorResult(experiment, modelName, experimentName, EVALUATOR_NAMES.TOOL_SELECTION_LLM));
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            log.error(`Error evaluating ${modelName}:`, err);
            log.error(`Full error trace: ${err.stack ?? err.message}`);

            // Add error results for both evaluators
            Object.values(EVALUATOR_NAMES).forEach(evaluatorName => {
                results.push({
                    model: modelName,
                    experimentName,
                    experimentId: '',
                    evaluatorName,
                    accuracy: 0,
                    correct: 0,
                    total: 0,
                    passed: false,
                    error: err.message
                });
            });
        }
    }

    printResults(results);

    const allPassed = results.every(r => !r.error && r.passed);
    return allPassed ? 0 : 1;
}

// Run
main(argv.datasetName || DATASET_NAME)
    .then((code) => process.exit(code))
    .catch((err) => {
        log.error('Unexpected error:', err);
        process.exit(1);
    });
