/**
 * Shared evaluation utilities extracted from run-evaluation.ts
 */

import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { asEvaluator } from '@arizeai/phoenix-client/experiments';
import { createClassifierFn } from '@arizeai/phoenix-evals';

import log from '@apify/log';

import { ApifyClient } from '../src/apify-client.js';
import { getToolPublicFieldOnly, processParamsGetTools } from '../src/index-internals.js';
import type { ToolBase, ToolEntry } from '../src/types.js';
import {
    SYSTEM_PROMPT,
    TOOL_CALLING_BASE_TEMPLATE,
    TOOL_SELECTION_EVAL_MODEL,
    EVALUATOR_NAMES,
    sanitizeHeaderValue
} from './config.js';

type ExampleInputOnly = { input: Record<string, unknown>, metadata?: Record<string, unknown>, output?: never };

export async function loadTools(): Promise<ToolBase[]> {
    const apifyClient = new ApifyClient({ token: process.env.APIFY_API_TOKEN || '' });
    const urlTools = await processParamsGetTools('', apifyClient);
    return urlTools.map((t: ToolEntry) => getToolPublicFieldOnly(t.tool)) as ToolBase[];
}

export function transformToolsToOpenAIFormat(tools: ToolBase[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as OpenAI.Chat.ChatCompletionTool['function']['parameters'],
        },
    }));
}

export function createOpenRouterTask(modelName: string, tools: ToolBase[]) {
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

        log.info(`Input: ${JSON.stringify(example)}`);

        const context = String(example.input?.context ?? '');
        const query = String(example.input?.query ?? '');

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: 'system', content: SYSTEM_PROMPT },
        ];

        if (context) {
            messages.push({
                role: 'user',
                content: `My previous interaction with the assistant: ${context}`
            });
        }

        messages.push({
            role: 'user',
            content: `${query}`,
        });

        log.info(`Messages to model: ${JSON.stringify(messages)}`);

        const response = await client.chat.completions.create({
            model: modelName,
            messages,
            tools: toolsOpenAI,
        });

        log.info(`Model response: ${JSON.stringify(response.choices[0])}`);

        return {
            tool_calls: response.choices[0].message.tool_calls || [],
            llm_response: response.choices[0].message.content || '',
            query: String(example.input?.query ?? ''),
            context: String(example.input?.context ?? ''),
            reference: String(example.input?.reference ?? ''),
        };
    };
}

export function createClassifierEvaluator() {
    const openai = createOpenAI({
        // custom settings, e.g.
        baseURL: process.env.OPENROUTER_BASE_URL,
        apiKey: process.env.OPENROUTER_API_KEY,
    });

    return createClassifierFn({
        model: openai(TOOL_SELECTION_EVAL_MODEL),
        choices: {correct: 1.0, incorrect: 0.0},
        promptTemplate: TOOL_CALLING_BASE_TEMPLATE,
    });
}

// LLM-based evaluator using Phoenix classifier - more robust than direct LLM calls
export function createToolSelectionLLMEvaluator(tools: ToolBase[]) {
    const evaluator = createClassifierEvaluator();

    return asEvaluator({
        name: EVALUATOR_NAMES.TOOL_SELECTION_LLM,
        kind: 'LLM',
        evaluate: async ({ input, output, expected }: any) => {
            log.info(`Evaluating tool selection. Input: ${JSON.stringify(input)}, Output: ${JSON.stringify(output)}, Expected: ${JSON.stringify(expected)}`);

            const evalInput = {
                query: input?.query || '',
                context: input?.context || '',
                tool_calls: JSON.stringify(output?.tool_calls || []),
                llm_response: output?.llm_response || '',
                reference: expected?.reference || '',
                tool_definitions: JSON.stringify(tools)
            };

            try {
                const result = await evaluator(evalInput);
                log.info(`🕵 Tool selection: score: ${result.score}: ${JSON.stringify(result)}`);
                return {
                    score: result.score || 0.0,
                    explanation: result.explanation || 'No explanation returned by model'
                };
            } catch (error) {
                log.info(`Tool selection evaluation failed: ${error}`);
                return {
                    score: 0.0,
                    explanation: `Evaluation failed: ${error}`
                };
            }
        },
    });
}
