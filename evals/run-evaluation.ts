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
import type { ExperimentTask } from '@arizeai/phoenix-client/types/experiments';
import dotenv from 'dotenv';
import OpenAI from 'openai';

import log from '@apify/log';

import { ApifyClient } from '../src/apify-client.js';
import { getToolPublicFieldOnly, processParamsGetTools } from '../src/index-internals.js';
import type { ToolBase, ToolEntry } from '../src/types.js';
import { DATASET_NAME, MODELS_TO_EVALUATE, PASS_THRESHOLD, SYSTEM_PROMPT, validateEnvVars } from './config.js';

log.setLevel(log.LEVELS.DEBUG);

dotenv.config({ path: '.env' });

type ExampleInputOnly = { input: Record<string, unknown>, metadata?: Record<string, unknown>, output?: never };

// Type for Phoenix evaluation run results
interface EvaluationRun {
    name: string;
    result?: {
        score?: number;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

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

function transformToolsToAnthropicFormat(tools: ToolBase[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // Phoenix tools schema uses inputSchema in Anthropic
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
}

function createOpenAITask(modelName: string, tools: ToolBase[]) {
    const toolsOpenAI = transformToolsToOpenAIFormat(tools);

    return async (example: ExampleInputOnly): Promise<{
        toolCalls: string[];
        input: Record<string, unknown>,
        metadata: Record<string, unknown>,
    }> => {
        const client = new OpenAI();

        const response = await client.chat.completions.create({
            model: modelName,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: String(example.input?.question ?? '') },
            ],
            tools: toolsOpenAI,
        });

        const toolCalls: string[] = [];
        const firstMessage = response.choices?.[0]?.message;
        if (firstMessage?.tool_calls?.length) {
            const toolCall = firstMessage.tool_calls[0];
            const name = toolCall?.function?.name;
            if (name) toolCalls.push(name);
        }
        return {
            toolCalls,
            input: example.input,
            metadata: { content: firstMessage },
        };
    };
}

function createAnthropicTask(modelName: string, tools: ToolBase[]) {
    const toolsAnthropic = transformToolsToAnthropicFormat(tools);

    return async (example: ExampleInputOnly): Promise<{
        toolCalls: string[];
        input: Record<string, unknown>,
        metadata: Record<string, unknown>,
    }> => {
        const client = new Anthropic({});

        const response = await client.messages.create({
            model: modelName,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: String(example.input?.question ?? '') }],
            tools: toolsAnthropic,
            max_tokens: 2048,
        });

        const toolCalls: string[] = [];
        for (const content of response.content) {
            if (content.type === 'tool_use') {
                const toolUseContent = content as Anthropic.ToolUseBlock;
                if (toolUseContent.name) toolCalls.push(toolUseContent.name);
            }
        }
        return {
            toolCalls,
            input: example.input,
            metadata: { content: response.content },
        };
    };
}

// Evaluator: returns score 1 if expected tool_calls match output list, 0 otherwise
const toolsMatch = asEvaluator({
    name: 'tools_match',
    kind: 'CODE',
    evaluate: async ({ output, expected }: {
        output: { toolCalls?: string[], input?: Record<string, unknown>, metadata?: Record<string, unknown> } | null;
        expected?: Record<string, unknown>;
    }) => {
        const toolCalls = String(expected?.tool_calls ?? '');
        const expectedTools = toolCalls
            .split(', ')
            .map((t) => t.trim())
            .filter(Boolean)
            .sort();
        // console.log(`Output tools: ${JSON.stringify(output?.metadata)} -> ${JSON.stringify(output?.toolCalls)}`);
        const actualArr = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
        const actual = [...actualArr].sort();
        const matches = JSON.stringify(expectedTools) === JSON.stringify(actual);
        log.debug(
            `----------------------\n`
            + `Query: ${String(output?.input?.question ?? '')}\n`
            + `LLM response: ${JSON.stringify(output?.metadata?.content ?? '')}\n`
            + `Match: ${matches}, expected tools: ${JSON.stringify(expectedTools)}, actual tools: ${JSON.stringify(actual)}`,
        );
        return {
            score: matches ? 1 : 0,
        };
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
            headers: { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` },
        },
    });

    // Resolve dataset by name -> id
    let datasetId: string | undefined;
    try {
        const info = await getDatasetInfo({ client, dataset: { datasetName: DATASET_NAME } });
        datasetId = info?.id as string | undefined;
        if (!datasetId) throw new Error(`Dataset "${DATASET_NAME}" not found`);
    } catch (e) {
        log.error(`Error loading dataset: ${e}`);
        return 1;
    }

    log.info(`Loaded dataset "${DATASET_NAME}" with ID: ${datasetId}`);

    const results: { model: string; accuracy: number; correct: number; total: number; experiment_id?: string; error?: string }[] = [];

    for (const modelName of MODELS_TO_EVALUATE) {
        log.info(`\nEvaluating model: ${modelName}`);

        let accuracy = 0;
        let correctCases = 0;
        let totalCases = 0;
        let experimentId: string | undefined;
        let error: string | undefined;

        let taskFn: (example: ExampleInputOnly) => Promise<{ toolCalls: string[] }>;
        if (modelName.startsWith('gpt')) {
            taskFn = createOpenAITask(modelName, tools);
        } else if (modelName.startsWith('claude')) {
            taskFn = createAnthropicTask(modelName, tools);
        } else {
            log.warning(`Unknown model type: ${modelName}, skipping`);
            results.push({ model: modelName, accuracy: 0, correct: 0, total: 0, error: 'Unknown model type' });
            continue;
        }

        const experimentName = `MCP tool calling eval ${modelName}`;
        const experimentDescription = `Evaluation of ${modelName} on MCP tool calling`;

        try {
            const experiment = await runExperiment({
                client,
                dataset: { datasetName: DATASET_NAME },
                // Cast to satisfy ExperimentTask type
                task: taskFn as ExperimentTask,
                evaluators: [toolsMatch],
                experimentName,
                experimentDescription,
                concurrency: 10,
            });

            const runsMap = experiment.runs ?? {};
            const evalRuns = experiment.evaluationRuns ?? [];
            totalCases = Object.keys(runsMap).length;
            const toolMatchEvals = evalRuns.filter((er: EvaluationRun) => er.name === 'tools_match');
            correctCases = toolMatchEvals.filter((er: EvaluationRun) => (er.result?.score ?? 0) > 0.5).length;
            accuracy = totalCases > 0 ? correctCases / totalCases : 0;
            experimentId = experiment.id;

            log.info(`${modelName}: ${(accuracy * 100).toFixed(1)}% (${correctCases}/${totalCases})`);
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

    const allPassed = results.filter((r) => !r.error).every((r) => r.accuracy >= PASS_THRESHOLD);
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
