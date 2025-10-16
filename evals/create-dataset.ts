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

import log from '@apify/log';

import { sanitizeHeaderValue, validateEnvVars } from './config.js';

// Set log level to debug
log.setLevel(log.LEVELS.INFO);

// Load environment variables from .env file if present
dotenv.config({ path: '.env' });

interface TestCase {
    id: string;
    category: string;
    query: string;
    context?: string;
    expectedTools?: string[];
    reference?: string;
}

interface TestData {
    version: string;
    testCases: TestCase[];
}

// eslint-disable-next-line consistent-return
function loadTestCases(): TestData {
    const filename = fileURLToPath(import.meta.url);
    const dirname = pathDirname(filename);
    const testCasesPath = join(dirname, 'test-cases.json');

    try {
        const fileContent = readFileSync(testCasesPath, 'utf-8');
        return JSON.parse(fileContent) as TestData;
    } catch {
        log.error(`Error: Test cases file not found at ${testCasesPath}`);
        process.exit(1);
    }
}

async function createDatasetFromTestCases(): Promise<void> {
    log.info('Creating Phoenix dataset from test cases...');

    // Validate environment variables
    if (!validateEnvVars()) {
        process.exit(1);
    }

    // Load test cases
    const testData = loadTestCases();
    const { testCases } = testData;

    log.info(`Loaded ${testCases.length} test cases`);

    // Convert to format expected by Phoenix
    const examples = testCases.map((testCase) => ({
        input: { query: testCase.query },
        output: { expectedTools: testCase.expectedTools?.join(', '), reference: testCase.reference || '' },
        metadata: { category: testCase.category },
    }));

    // Initialize Phoenix client
    const client = createClient({
        options: {
            baseUrl: process.env.PHOENIX_BASE_URL!,
            headers: { Authorization: `Bearer ${sanitizeHeaderValue(process.env.PHOENIX_API_KEY)}` },
        },
    });

    // Upload dataset
    const datasetName = `mcp_server_dataset_v${testData.version}`;

    log.info(`Uploading dataset '${datasetName}' to Phoenix...`);

    try {
        const { datasetId } = await createDataset({
            client,
            name: datasetName,
            description: `MCP server dataset: version ${testData.version}`,
            examples,
        });

        log.info(`Dataset '${datasetName}' created with ID: ${datasetId}`);
    } catch (error) {
        log.error(`Error creating dataset: ${error}`);
        process.exit(1);
    }
}

// Run the script
createDatasetFromTestCases().catch((error) => {
    log.error('Unexpected error:', error);
    process.exit(1);
});
