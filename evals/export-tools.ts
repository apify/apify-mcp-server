#!/usr/bin/env tsx

/**
 * Export Tools Script for MCP Evaluations
 *
 * Usage:
 *   npm run evals:export-tools
 *   tsx evals/export-tools.ts
 *   tsx evals/export-tools.ts --output-dir ./custom/path
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import log from '@apify/log';

import { ApifyClient } from '../src/apify-client.js';
import { getToolPublicFieldOnly, processParamsGetTools } from '../src/index-internals.js';

async function exportTools(): Promise<void> {
    console.log('Exporting MCP tools...');

    // Get output directory from command line args
    const outputDir = process.argv.includes('--output-dir')
        ? process.argv[process.argv.indexOf('--output-dir') + 1]
        : process.cwd();

    const apifyClient = new ApifyClient({ token: process.env.APIFY_API_TOKEN || '' });

    const urlTools = await processParamsGetTools('', apifyClient);
    console.log(`Found ${urlTools.length} tools`);

    const toolsFromUrl = urlTools.map((t) => getToolPublicFieldOnly(t.tool));
    const jsonFromUrl = JSON.stringify(toolsFromUrl, null, 2);

    const outputPath = join(outputDir, 'tools.json');
    writeFileSync(outputPath, jsonFromUrl);

    console.log(`Tools exported successfully to ${outputPath}`);
    console.log(`Exported ${toolsFromUrl.length} tools`);
}

exportTools().catch((err) => {
    log.error('Error exporting tools to JSON:', err);
    process.exit(1);
});
