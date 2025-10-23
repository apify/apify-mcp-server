#!/usr/bin/env tsx

import dotenv from 'dotenv';
import log from '@apify/log';
import {
    loadTools,
    createOpenRouterTask,
    createToolSelectionLLMEvaluator
} from './evaluation-utils.js';
import { PASS_THRESHOLD, sanitizeHeaderValue } from './config.js';

dotenv.config({ path: '.env' });
log.setLevel(log.LEVELS.INFO);

// const MODEL_NAME = 'openai/gpt-4.1-mini';
const MODEL_NAME = 'anthropic/claude-haiku-4.5'

// Hardcoded example for quick testing
const EXAMPLE = {
    "id": "instagram-profile-scraping-1",
    "category": "search-actors",
    "query": "I need to find Actor for instagram profile scraping",
    "expectedTools": ["search-actors"],
    "reference": "The 'search-actors' tool should be called with search parameter 'instagram profile'. It must not use extended queries such as 'instagram profile scraper' or any more detailed variations."
};

async function main() {


    process.env.OPENROUTER_API_KEY = sanitizeHeaderValue(process.env.OPENROUTER_API_KEY);

    console.log('\nEvaluating single example\n');
    console.log('Query:', EXAMPLE.query);
    console.log('Expected tools:', EXAMPLE.expectedTools);

    // 1. Load tools
    const tools = await loadTools();
    console.log(`\nLoaded ${tools.length} tools`);

    // 2. Call LLM with tools
    console.log('\nRunning LLM tool calling');
    const task = createOpenRouterTask(MODEL_NAME, tools);
    const output = await task({ input: EXAMPLE });

    console.log('\nLLM response');
    console.log('Tool calls:', JSON.stringify(output.tool_calls, null, 2));
    console.log('Message:', output.llm_response || '(no message)');

    // 3. Evaluate with LLM judge
    console.log('\nEvaluating with LLM');
    const llmEvaluator = createToolSelectionLLMEvaluator(tools);
    const result = await llmEvaluator.evaluate({
        input: EXAMPLE,
        output,
        expected: EXAMPLE
    });

    console.log('\nEvaluation result');
    console.log('Score:', result.score);
    console.log('Explanation:', result.explanation);
    console.log('\nPassed:', result.score ? (result.score > PASS_THRESHOLD ? 'True' : 'False') : 'False');
}

main().catch(console.error);
