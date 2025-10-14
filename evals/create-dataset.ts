#!/usr/bin/env tsx
/**
 * One-time script to create Phoenix dataset from test cases.
 * Run this once to upload test cases to Phoenix platform and receive a dataset ID.
 */

import { readFileSync } from 'node:fs';
import { dirname as pathDirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@arizeai/phoenix-client';
// eslint-disable-next-line import/extensions
import { createDataset } from '@arizeai/phoenix-client/datasets';
import dotenv from 'dotenv';

import { validateEnvVars } from './config.js';

// Load environment variables from .env file if present
dotenv.config({ path: '.env' });

interface TestCase {
    id: string;
    category: string;
    question: string;
    expected_tools: string[];
}

interface TestData {
    version: string;
    test_cases: TestCase[];
}

// eslint-disable-next-line consistent-return
function loadTestCases(): TestData {
    const filename = fileURLToPath(import.meta.url);
    const dirname = pathDirname(filename);
    const testCasesPath = join(dirname, 'test_cases.json');

    try {
        const fileContent = readFileSync(testCasesPath, 'utf-8');
        return JSON.parse(fileContent) as TestData;
    } catch {
        // eslint-disable-next-line no-console
        console.error(`Error: Test cases file not found at ${testCasesPath}`);
        process.exit(1);
    }
}

async function createDatasetFromTestCases(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('Creating Phoenix dataset from test cases...');

    // Validate environment variables
    if (!validateEnvVars()) {
        process.exit(1);
    }

    // Load test cases
    const testData = loadTestCases();
    const testCases = testData.test_cases;

    // eslint-disable-next-line no-console
    console.log(`Loaded ${testCases.length} test cases`);

    // Convert to format expected by Phoenix
    const examples = testCases.map((testCase) => ({
        input: { question: testCase.question },
        output: { tool_calls: testCase.expected_tools.join(', ') },
        metadata: { category: testCase.category },
    }));

    // Initialize Phoenix client
    const client = createClient({
        options: {
            baseUrl: process.env.PHOENIX_BASE_URL!,
            headers: { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` },
        },
    });

    // Upload dataset
    const datasetName = `mcp_tool_calling_ground_truth_v${testData.version}`;

    // eslint-disable-next-line no-console
    console.log(`Uploading dataset '${datasetName}' to Phoenix...`);

    try {
        const { datasetId } = await createDataset({
            client,
            name: datasetName,
            description: `MCP tool calling ground truth dataset version ${testData.version}`,
            examples,
        });

        // eslint-disable-next-line no-console
        console.log(`Dataset '${datasetName}' created with ID: ${datasetId}`);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Error creating dataset: ${error}`);
        process.exit(1);
    }
}

// Run the script
createDatasetFromTestCases().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Unexpected error:', error);
    process.exit(1);
});
