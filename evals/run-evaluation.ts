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
import { createClassifierFn } from '@arizeai/phoenix-evals';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';

import log from '@apify/log';

import { ApifyClient } from '../src/apify-client.js';
import { getToolPublicFieldOnly, processParamsGetTools } from '../src/index-internals.js';
import type { ToolBase, ToolEntry } from '../src/types.js';
import {
    DATASET_NAME,
    MODELS_TO_EVALUATE,
    PASS_THRESHOLD,
    SYSTEM_PROMPT,
    TOOL_CALLING_BASE_TEMPLATE,
    TOOL_SELECTION_EVAL_MODEL,
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

log.setLevel(log.LEVELS.DEBUG);

dotenv.config({ path: '.env' });

// Sanitize secrets early to avoid invalid header characters in CI
process.env.OPENROUTER_API_KEY = sanitizeHeaderValue(process.env.OPENROUTER_API_KEY);

type ExampleInputOnly = { input: Record<string, unknown>, metadata?: Record<string, unknown>, output?: never };

async function loadTools(): Promise<ToolBase[]> {
    const apifyClient = new ApifyClient({ token: process.env.APIFY_API_TOKEN || '' });
    const urlTools = await processParamsGetTools('', apifyClient);
    return urlTools.map((t: ToolEntry) => getToolPublicFieldOnly(t.tool)) as ToolBase[];
}

function transformToolsToOpenAIFormat(tools: ToolBase[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as OpenAI.Chat.ChatCompletionTool['function']['parameters'],
        },
    }));
}

function createOpenRouterTask(modelName: string, tools: ToolBase[]) {
    const toolsOpenAI = transformToolsToOpenAIFormat(tools);

    return async (example: ExampleInputOnly): Promise<{
        tool_calls: Array<{ function?: { name?: string } }>;
        llm_response: string;
        query: string;
        context: string;
        reference: string;
    }> => {
        const client = new OpenAI({
            baseURL: process.env.OPENROUTER_BASE_URL,
            apiKey: sanitizeHeaderValue(process.env.OPENROUTER_API_KEY),
        });

        console.log(`Input: ${JSON.stringify(example)}`);

        const context = String(example.input?.context ?? '');
        const query = String(example.input?.query ?? '');

        let content = context ? `Context: ${context}\n\n` : '';
        content += query ? `User query: ${query}` : '';

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
        ];

        console.log(`Model: ${modelName}, Messages: ${JSON.stringify(messages)}`);

        const response = await client.chat.completions.create({
            model: modelName,
            messages,
            tools: toolsOpenAI,
        });

        return {
            tool_calls: response.choices[0].message.tool_calls || [],
            llm_response: response.choices[0].message.content || '',
            query: String(example.input?.query ?? ''),
            context: String(example.input?.context ?? ''),
            reference: String(example.input?.reference ?? ''),
        };
    };
}

// Tools match evaluator: returns score 1 if expected tool_calls match output list, 0 otherwise
const toolsExactMatch = asEvaluator({
    name: EVALUATOR_NAMES.TOOLS_EXACT_MATCH,
    kind: 'CODE',
    evaluate: async ({ output, expected }: any) => {
        let expectedTools = expected?.expectedTools || [];
        if (typeof expectedTools === 'string') {
            expectedTools = expectedTools.split(', ');
        }

        if (!expectedTools || expectedTools.length === 0) {
            log.debug('Tools match: No expected tools provided');
            return {
                score: 1.0,
                explanation: 'No expected tools provided',
            };
        }

        expectedTools = [...expectedTools].sort();

        const outputTools = (output?.tool_calls || [])
            .map((toolCall: any) => toolCall.function?.name || '')
            .sort();

        const isCorrect = JSON.stringify(expectedTools) === JSON.stringify(outputTools);
        const score = isCorrect ? 1.0 : 0.0;
        const explanation = `Expected: ${JSON.stringify(expectedTools)}, Got: ${JSON.stringify(outputTools)}`;

        log.debug(`# Tools exact match: score=${score}, output=${JSON.stringify(outputTools)}, expected=${JSON.stringify(expectedTools)}`);

        return {
            score,
            explanation,
        };
    },
});

const openai = createOpenAI({
    // custom settings, e.g.
    baseURL: process.env.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
});

const classifierFn = createClassifierFn({
    model: openai(TOOL_SELECTION_EVAL_MODEL),
    choices: { correct: 1.0, incorrect: 0.0, 'not-applicable': 1 },
    promptTemplate: TOOL_CALLING_BASE_TEMPLATE,
});
// LLM-based evaluator using Phoenix classifier - more robust than direct LLM calls
const createToolSelectionLLMEvaluator = (tools: ToolBase[]) => asEvaluator({
    name: EVALUATOR_NAMES.TOOL_SELECTION_LLM,
    kind: 'LLM',
    evaluate: async ({ input, output, expected }: any) => {
        console.log(`Evaluating tool selection. Input: ${JSON.stringify(input)}, Output: ${JSON.stringify(output)}, Expected: ${JSON.stringify(expected)}`);

        const evalInput = {
            query: input?.query || '',
            context: input?.context || '',
            tool_calls: output?.tool_calls || [],
            llm_response: output?.llm_response || '',
            reference: expected?.reference || '',
            tool_definitions: JSON.stringify(tools)
        };

        try {
            const result = await classifierFn(evalInput);
            console.log(`# Tool selection evaluation result: ${JSON.stringify(result)} (Score: ${result.score})`);
            return {
                score: result.score || 0.0,
                explanation: result.explanation || 'No explanation provided'
            };
        } catch (error) {
            console.log(`Tool selection evaluation failed: ${error}`);
            return {
                score: 0.0,
                explanation: `Evaluation failed: ${error}`
            };
        }
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

async function main(): Promise<number> {
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
        const info = await getDatasetInfo({ client, dataset: { datasetName: DATASET_NAME } });
        datasetId = info?.id as string | undefined;
    } catch (e) {
        log.error(`Error loading dataset: ${e}`);
        return 1;
    }

    if (!datasetId) throw new Error(`Dataset "${DATASET_NAME}" not found`);

    log.info(`Loaded dataset "${DATASET_NAME}" with ID: ${datasetId}`);

    const results: EvaluatorResult[] = [];

    // Create the LLM evaluator with loaded tools
    const toolSelectionLLMEvaluator = createToolSelectionLLMEvaluator(tools);

    for (const modelName of MODELS_TO_EVALUATE) {
        log.info(`\nEvaluating model: ${modelName}`);

        // OpenRouter task
        const taskFn = createOpenRouterTask(modelName, tools);

        const experimentName = `MCP tool selection eval ${modelName}`;
        const experimentDescription = `Evaluation of ${modelName} on MCP tool selection`;

        try {
            const experiment = await runExperiment({
                client,
                dataset: { datasetName: DATASET_NAME },
                // Cast to satisfy ExperimentTask type
                task: taskFn as ExperimentTask,
                evaluators: [toolsExactMatch, toolSelectionLLMEvaluator],
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
main()
    .then((code) => process.exit(code))
    .catch((err) => {
        log.error('Unexpected error:', err);
        process.exit(1);
    });
