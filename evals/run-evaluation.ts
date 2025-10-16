#!/usr/bin/env tsx
/**
 * Main evaluation script for MCP tool calling (TypeScript version).
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@arizeai/phoenix-client';
// eslint-disable-next-line import/extensions
import { getDatasetInfo } from '@arizeai/phoenix-client/datasets';
// eslint-disable-next-line import/extensions
import { asEvaluator, runExperiment } from '@arizeai/phoenix-client/experiments';
import type { ExperimentEvaluationRun, ExperimentTask } from '@arizeai/phoenix-client/types/experiments';
import { createClassifierFn } from '@arizeai/phoenix-evals';
import { openai } from '@ai-sdk/openai';
import dotenv from 'dotenv';
import OpenAI from 'openai';

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
    sanitizeHeaderValue,
    validateEnvVars,
    OPENROUTER_BASE_URL
} from './config.js';

log.setLevel(log.LEVELS.DEBUG);

dotenv.config({ path: '.env' });

// Sanitize secrets early to avoid invalid header characters in CI
process.env.ANTHROPIC_API_KEY = sanitizeHeaderValue(process.env.ANTHROPIC_API_KEY);
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
            baseURL: OPENROUTER_BASE_URL,
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
const toolsMatch = asEvaluator({
    name: 'tools_exact_match',
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

        log.debug(`# Tools match: score=${score}, output=${JSON.stringify(outputTools)}, expected=${JSON.stringify(expectedTools)}`);

        return {
            score,
            explanation,
        };
    },
});

// Create the Phoenix classifier evaluator
const model = openai('gpt-4o-mini');

const classifierFn = createClassifierFn({
    model,
    choices: { correct: 1.0, incorrect: 0.0 },
    promptTemplate: TOOL_CALLING_BASE_TEMPLATE,
});

// LLM-based evaluator using Phoenix classifier - more robust than direct LLM calls
const createToolCallingLLMEvaluator = (tools: ToolBase[]) => asEvaluator({
    name: 'tool_calling_llm',
    kind: 'LLM',
    evaluate: async ({ input, output, expected }: any) => {
        console.log(`Evaluating tool calling. Input: ${JSON.stringify(input)}, Output: ${JSON.stringify(output)}, Expected: ${JSON.stringify(expected)}`);

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
            console.log(`# Tool calling evaluation result: ${JSON.stringify(result)} (Score: ${result.score})`);
            return {
                score: result.score || 0.0,
                explanation: result.explanation || 'No explanation provided'
            };
        } catch (error) {
            console.log(`Evaluation failed: ${error}`);
            return {
                score: 0.0,
                explanation: `Evaluation failed: ${error}`
            };
        }
    },
});

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

    const results: { model: string; accuracy: number; correct: number; total: number; experiment_id?: string; error?: string }[] = [];

    // Create the LLM evaluator with loaded tools
    const toolCallingLLMEvaluator = createToolCallingLLMEvaluator(tools);

    for (const modelName of MODELS_TO_EVALUATE) {
        log.info(`\nEvaluating model: ${modelName}`);

        let accuracy = 0;
        let correctCases = 0;
        let totalCases = 0;
        let experimentId: string | undefined;
        let error: string | undefined;

        // OpenRouter task
        let taskFn: (example: ExampleInputOnly) => Promise<any>;
        taskFn = createOpenRouterTask(modelName, tools);

        const experimentName = `MCP tool calling eval ${modelName}`;
        const experimentDescription = `Evaluation of ${modelName} on MCP tool calling`;

        try {
            const experiment = await runExperiment({
                client,
                dataset: { datasetName: DATASET_NAME },
                // Cast to satisfy ExperimentTask type
                task: taskFn as ExperimentTask,
                // evaluators: [toolsMatch, toolCallingLLMEvaluator],
                evaluators: [toolCallingLLMEvaluator],
                experimentName,
                experimentDescription,
                concurrency: 10,
            });
            log.info(`Experiment run completed. View details at: ${experiment}`);

            const runsMap = experiment.runs ?? {};
            const evalRuns = experiment.evaluationRuns ?? [];
            totalCases = Object.keys(runsMap).length;
            const toolMatchEvals = evalRuns.filter((er: ExperimentEvaluationRun) => er.name === 'tools_exact_match');
            correctCases = toolMatchEvals.filter((er: ExperimentEvaluationRun) => (er.result?.score ?? 0) > 0.5).length;
            accuracy = totalCases > 0 ? correctCases / totalCases : 0;

            // Log detailed results for both evaluators
            const toolCallingEvals = evalRuns.filter((er: ExperimentEvaluationRun) => er.name === 'tool_calling_llm');
            const toolCallingCorrect = toolCallingEvals.filter((er: ExperimentEvaluationRun) => (er.result?.score ?? 0) > 0.5).length;
            const toolCallingAccuracy = totalCases > 0 ? toolCallingCorrect / totalCases : 0;

            log.info(`${modelName} - Tools Match: ${(accuracy * 100).toFixed(1)}% (${correctCases}/${totalCases})`);
            log.info(`${modelName} - Tool Calling LLM: ${(toolCallingAccuracy * 100).toFixed(1)}% (${toolCallingCorrect}/${totalCases})`);
            experimentId = experiment.id;
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            log.error(`Error evaluating ${modelName}:`, err);
            log.error(`Full error trace: ${err.stack ?? err.message}`);
            error = err.message;
        }
        results.push({ model: modelName, accuracy, correct: correctCases, total: totalCases, experiment_id: experimentId, error });
    }

    log.info('📊 Results:');
    for (const result of results) {
        const { model, accuracy, error } = result;
        if (error) {
            log.info(`  ${model}: ❌ Error`);
        } else {
            log.info(`  ${model}: ${(accuracy * 100).toFixed(1)}%`);
        }
    }

    const allPassed = results.every((r) => !r.error && r.accuracy >= PASS_THRESHOLD);
    log.info(`Pass threshold: ${(PASS_THRESHOLD * 100).toFixed(1)}%`);
    if (allPassed) {
        log.info('✅ All models passed the threshold');
    } else {
        log.info('❌ Some models failed to meet the threshold');
    }

    return allPassed ? 0 : 1;
}

// Run
main()
    .then((code) => process.exit(code))
    .catch((err) => {
        log.error('Unexpected error:', err);
        process.exit(1);
    });
