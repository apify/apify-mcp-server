#!/usr/bin/env tsx
/**
 * Main evaluation script for MCP tool calling (TypeScript version).
 */

import { readFileSync } from 'node:fs';
import { dirname as pathDirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@arizeai/phoenix-client';
// eslint-disable-next-line import/extensions
import { getDatasetInfo } from '@arizeai/phoenix-client/datasets';
// eslint-disable-next-line import/extensions
import { asEvaluator, runExperiment } from '@arizeai/phoenix-client/experiments';
import dotenv from 'dotenv';
import OpenAI from 'openai';

import { DATASET_NAME, MODELS_TO_EVALUATE, PASS_THRESHOLD, SYSTEM_PROMPT, validateEnvVars } from './config.js';

dotenv.config({ path: '.env' });

type ToolDef = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

type ExampleInputOnly = { input: Record<string, unknown> };

function loadTools(): ToolDef[] {
    const filename = fileURLToPath(import.meta.url);
    const dirname = pathDirname(filename);
    const toolsPath = join(dirname, 'tools.json');

    try {
        const json = readFileSync(toolsPath, 'utf-8');
        return JSON.parse(json) as ToolDef[];
    } catch {
        // eslint-disable-next-line no-console
        console.error(`Error: tools.json not found at ${toolsPath}`);
        // eslint-disable-next-line no-console
        console.error("Run 'npm run evals:export-tools' first to export current tool definitions");
        process.exit(1);
    }
    // Unreachable, process exits above
    return [];
}

function transformToolsToOpenAIFormat(tools: ToolDef[]) {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));
}

function transformToolsToAnthropicFormat(tools: ToolDef[]) {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // Phoenix tools schema uses inputSchema in Anthropic
        input_schema: tool.inputSchema as Record<string, unknown>,
    }));
}

function createOpenAITask(modelName: string, tools: ToolDef[]) {
    const toolsOpenAI = transformToolsToOpenAIFormat(tools);

    return async (example: ExampleInputOnly): Promise<{ toolCalls: string[] }> => {
        const client = new OpenAI();

        const response = await client.chat.completions.create({
            model: modelName,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: String(example.input?.question ?? '') },
            ],
            tools: toolsOpenAI as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        });

        const toolCalls: string[] = [];
        const first = response.choices?.[0]?.message as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        // eslint-disable-next-line no-console
        console.log(example.input?.question, first);
        if (first?.tool_calls?.length) {
            const toolCall = first.tool_calls[0] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
            const name = toolCall?.function?.name as string | undefined;
            if (name) toolCalls.push(name);
        }
        return { toolCalls };
    };
}

function createAnthropicTask(modelName: string, tools: ToolDef[]) {
    const toolsAnthropic = transformToolsToAnthropicFormat(tools);

    return async (example: ExampleInputOnly): Promise<{ toolCalls: string[] }> => {
        const client = new Anthropic({});

        const response = await client.messages.create({
            model: modelName,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: String(example.input?.question ?? '') }],
            tools: toolsAnthropic as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            max_tokens: 2048,
        });

        const toolCalls: string[] = [];
        // eslint-disable-next-line no-console
        console.log(example.input?.question, response.content);
        for (const content of response.content) {
            if ((content as any).type === 'tool_use') { // eslint-disable-line @typescript-eslint/no-explicit-any
                const name = (content as any).name as string | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
                if (name) toolCalls.push(name);
            }
        }
        return { toolCalls };
    };
}

// Evaluator: returns score 1 if expected tool_calls match output list, 0 otherwise
const toolsMatch = asEvaluator({
    name: 'tools_match',
    kind: 'CODE',
    evaluate: async (args) => {
        const { output, expected } = args as { output: { toolCalls?: string[] } | null; expected?: Record<string, unknown> };
        const toolCalls = String((expected as Record<string, unknown> | undefined)?.tool_calls ?? '');
        const expectedTools = toolCalls
            .split(', ')
            .map((t) => t.trim())
            .filter(Boolean)
            .sort();

        const actualArr = Array.isArray(output?.toolCalls) ? output?.toolCalls ?? [] : [];
        const actual = [...actualArr].sort();
        const matches = JSON.stringify(expectedTools) === JSON.stringify(actual);
        return {
            label: matches ? 'matches' : 'does not match',
            score: matches ? 1 : 0,
            explanation: matches ? 'Output tool calls match expected' : 'Mismatch between expected and output tool calls',
            metadata: {},
        };
    },
});

async function main(): Promise<number> {
    // eslint-disable-next-line no-console
    console.log('Starting MCP tool calling evaluation');

    if (!validateEnvVars()) {
        return 1;
    }

    const tools = loadTools();
    // eslint-disable-next-line no-console
    console.log(`Loaded ${tools.length} tools`);

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
        // eslint-disable-next-line no-console
        console.error(`Error loading dataset: ${e}`);
        return 1;
    }

    // eslint-disable-next-line no-console
    console.log(`Loaded dataset "${DATASET_NAME}" with ID: ${datasetId}`);

    const results: { model: string; accuracy: number; correct: number; total: number; experiment_id?: string; error?: string }[] = [];

    for (const modelName of MODELS_TO_EVALUATE) {
        // eslint-disable-next-line no-console
        console.log(`\nEvaluating model: ${modelName}`);

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
            // eslint-disable-next-line no-console
            console.log(`Unknown model type: ${modelName}, skipping`);
            results.push({ model: modelName, accuracy: 0, correct: 0, total: 0, error: 'Unknown model type' });
            continue;
        }

        const experimentName = `MCP tool calling eval ${modelName}`;
        const experimentDescription = `Evaluation of ${modelName} on MCP tool calling`;

        try {
            const experiment = await runExperiment({
                client,
                dataset: { datasetName: DATASET_NAME },
                // Cast as any to satisfy ExperimentTask type
                task: taskFn as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                evaluators: [toolsMatch],
                experimentName,
                experimentDescription,
                dryRun: 3,
            });

            const runsMap = experiment.runs ?? {};
            const evalRuns = experiment.evaluationRuns ?? [];
            totalCases = Object.keys(runsMap).length;
            const toolMatchEvals = evalRuns.filter((er) => er.name === 'tools_match');
            correctCases = toolMatchEvals.filter((er) => (er.result?.score ?? 0) > 0.5).length;
            accuracy = totalCases > 0 ? correctCases / totalCases : 0;
            experimentId = experiment.id;

            // eslint-disable-next-line no-console
            console.log(`${modelName}: ${(accuracy * 100).toFixed(1)}% (${correctCases}/${totalCases})`);

            if (toolMatchEvals.length > 0) {
                // eslint-disable-next-line no-console
                console.log('Sample evaluation results:');
                // eslint-disable-next-line no-console
                console.log(
                    toolMatchEvals.slice(0, Math.min(10, toolMatchEvals.length)).map((e) => ({ score: e.result?.score, label: e.result?.label })),
                );
            }
        } catch (e: unknown) {
            const err: any = e;
            // eslint-disable-next-line no-console
            console.error(`Error evaluating ${modelName}:`, err);
            // eslint-disable-next-line no-console
            console.error('Full error trace:', err?.stack ?? err);
            error = String(err?.message ?? err);
        }
        results.push({ model: modelName, accuracy, correct: correctCases, total: totalCases, experiment_id: experimentId, error });
    }

    // eslint-disable-next-line no-console
    console.log('\n📊 Results:');
    for (const result of results) {
        const { model, accuracy, error } = result;
        if (error) {
            // eslint-disable-next-line no-console
            console.log(`  ${model}: ❌ Error`);
        } else {
            // eslint-disable-next-line no-console
            console.log(`  ${model}: ${(accuracy * 100).toFixed(1)}%`);
        }
    }

    const allPassed = results.filter((r) => !r.error).every((r) => r.accuracy >= PASS_THRESHOLD);
    // eslint-disable-next-line no-console
    console.log(`\nPass threshold: ${(PASS_THRESHOLD * 100).toFixed(1)}%`);
    if (allPassed) {
        // eslint-disable-next-line no-console
        console.log('✅ All models passed the threshold');
    } else {
        // eslint-disable-next-line no-console
        console.log('❌ Some models failed to meet the threshold');
    }

    return allPassed ? 0 : 1;
}

// Run
main()
    .then((code) => process.exit(code))
    .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Unexpected error:', err);
        process.exit(1);
    });
