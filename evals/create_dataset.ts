#!/usr/bin/env tsx
/**
 * One-time script to create Phoenix dataset from test cases.
 * Run this once to upload test cases to Phoenix platform and receive a dataset ID.
 */

import { createClient } from '@arizeai/phoenix-client';
// eslint-disable-next-line import/extensions
import { createDataset } from '@arizeai/phoenix-client/datasets';
import dotenv from 'dotenv';
import yargs from 'yargs';
// eslint-disable-next-line import/extensions
import { hideBin } from 'yargs/helpers';

import log from '@apify/log';

import { sanitizeHeaderValue, validatePhoenixEnvVars } from './config.js';
import { loadTestCases, filterByCategory, filterById, type TestCase } from './evaluation-utils.js';

// Set log level to debug
log.setLevel(log.LEVELS.INFO);

/**
 * Type for command line arguments
 */
type CliArgs = {
    testCases?: string;
    category?: string;
    id?: string;
    datasetName?: string;
};

// Load environment variables from .env file if present
dotenv.config({ path: '.env' });

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
    .wrap(null) // Disable automatic wrapping to avoid issues with long lines
    .usage('Usage: $0 [options]')
    .env()
    .option('test-cases', {
        type: 'string',
        describe: 'Path to test cases JSON file',
        default: 'test-cases.json',
        example: 'custom-test-cases.json',
    })
    .option('category', {
        type: 'string',
        describe: 'Filter test cases by category. Supports wildcards with * (e.g., search-actors, search-actors-*)',
        example: 'search-actors',
    })
    .option('id', {
        type: 'string',
        describe: 'Filter test cases by ID using regex pattern',
        example: 'instagram.*',
    })
    .option('dataset-name', {
        type: 'string',
        describe: 'Custom dataset name (overrides auto-generated name)',
        example: 'my_custom_dataset',
    })
    .help('help')
    .alias('h', 'help')
    .version(false)
    .epilogue('Examples:')
    .epilogue('  $0                                    # Use defaults')
    .epilogue('  $0 --test-cases custom.json          # Use custom test cases file')
    .epilogue('  $0 --category search-actors          # Filter by exact category')
    .epilogue('  $0 --category search-actors-*        # Filter by wildcard pattern')
    .epilogue('  $0 --id instagram.*                  # Filter by ID regex pattern')
    .epilogue('  $0 --dataset-name my_dataset         # Custom dataset name')
    .epilogue('  $0 --test-cases custom.json --category search-actors')
    .parseSync() as CliArgs;


async function createDatasetFromTestCases(
    testCases: TestCase[],
    datasetName: string,
    version: string,
): Promise<void> {
    log.info('Creating Phoenix dataset from test cases...');

    // Validate environment variables
    if (!validatePhoenixEnvVars()) {
        process.exit(1);
    }

    log.info(`Loaded ${testCases.length} test cases`);

    // Convert to format expected by Phoenix
    const examples = testCases.map((testCase) => ({
        input: { query: testCase.query, context: testCase.context || '' },
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

    log.info(`Uploading dataset '${datasetName}' to Phoenix...`);

    try {
        const { datasetId } = await createDataset({
            client,
            name: datasetName,
            description: `MCP server dataset: version ${version}`,
            examples,
        });

        log.info(`Dataset '${datasetName}' created with ID: ${datasetId}`);
    } catch (error) {
        if (error instanceof Error && error.message.includes('409')) {
            log.error(`❌ Dataset '${datasetName}' already exists in Phoenix!`);
            log.error('');
            log.error('💡 Solutions:');
            log.error('  1. Use --dataset-name to specify a different name:');
            log.error(`     tsx create-dataset.ts --dataset-name ${datasetName}_v2`);
            log.error(`     npm run evals:create-dataset -- --dataset-name ${datasetName}_v2`);
            log.error('  2. Delete the existing dataset from Phoenix dashboard first');
            log.error('');
            log.error(`📋 Technical details: ${error.message}`);
        } else {
            log.error(`Error creating dataset: ${error}`);
        }
        process.exit(1);
    }
}

// Run the script
async function main(): Promise<void> {
    try {
        // Load test cases from specified file

        const testData = loadTestCases(argv.testCases || 'test-cases.json');
        let { testCases } = testData;

        // Apply category filter if specified
        if (argv.category) {
            testCases = filterByCategory(testCases, argv.category);
            log.info(`Filtered to ${testCases.length} test cases in category '${argv.category}'`);
        }

        // Apply ID filter if specified
        if (argv.id) {
            testCases = filterById(testCases, argv.id);
            log.info(`Filtered to ${testCases.length} test cases matching ID pattern '${argv.id}'`);
        }

        // Determine dataset name
        const datasetName = argv.datasetName || `mcp_server_dataset_v${testData.version}`;

        // Create dataset
        await createDatasetFromTestCases(testCases, datasetName, testData.version);
    } catch (error) {
        log.error('Unexpected error:', { error });
        process.exit(1);
    }
}

// Run
main()
    .then(() => process.exit())
    .catch((err) => {
        log.error('Unexpected error:', err);
        process.exit(1);
    });
