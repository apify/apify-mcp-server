#!/usr/bin/env tsx

import dotenv from 'dotenv';
import log from '@apify/log';
import {
    loadTools,
    createOpenRouterTask,
    createToolSelectionLLMEvaluator,
    loadTestCases, filterById,
    type TestCase
} from './evaluation-utils.js';
import { PASS_THRESHOLD, sanitizeHeaderValue } from './config.js';

dotenv.config({ path: '.env' });
log.setLevel(log.LEVELS.INFO);

// const MODEL_NAME = 'openai/gpt-4.1-mini';
const MODEL_NAME = 'anthropic/claude-haiku-4.5'
const RUN_LLM_JUDGE = true;

// Hardcoded examples for quick testing
const EXAMPLES: TestCase[] = [
];

EXAMPLES.push(...filterById(loadTestCases('test-cases.json').testCases, 'weather-mcp-search-then-call-1'));

async function main() {
    process.env.OPENROUTER_API_KEY = sanitizeHeaderValue(process.env.OPENROUTER_API_KEY);

    console.log(`\nEvaluating ${EXAMPLES.length} examples\n`);

    // 1. Load tools
    const tools = await loadTools();
    console.log(`Loaded ${tools.length} tools\n`);

    // Loop through each example
    for (let i = 0; i < EXAMPLES.length; i++) {
        const example = EXAMPLES[i];

        console.log(`\n=== Example ${i + 1}/${EXAMPLES.length}: ${example.id} ===`);
        console.log('Query:', example.query);
        console.log('Expected tools:', example.expectedTools);

        // 2. Call LLM with tools
        console.log('\nRunning LLM tool calling');
        const task = createOpenRouterTask(MODEL_NAME, tools);
        const output = await task({ input: example as unknown as Record<string, unknown> });

        console.log('\nLLM response');
        console.log('Tool calls:', JSON.stringify(output.tool_calls, null, 2));
        console.log('Message:', output.llm_response || '(no message)');

        if (!RUN_LLM_JUDGE) {
            console.log('Skipping LLM evaluation as RUN_LLM_JUDGE is set to false');
            console.log('='.repeat(50));
        } else {
            // 3. Evaluate with LLM judge
            console.log('\nEvaluating with LLM');
            const llmEvaluator = createToolSelectionLLMEvaluator(tools);
            const result = await llmEvaluator.evaluate({
                input: example as unknown as Record<string, unknown>,
                output,
                expected: example as unknown as Record<string, unknown>
            });

            const passed = result.score ? (result.score > PASS_THRESHOLD) : false;
            console.log('\nEvaluation result');
            console.log('Score:', result.score );
            console.log('Explanation:', result.explanation);
            console.log('Passed:', result.score ? (passed ? 'True ✅' : 'False ❌') : 'False ❌');
            console.log('='.repeat(50));
        }
    }
}

main().catch(console.error);
