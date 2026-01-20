/* eslint-disable no-console */
/**
 * Build-time check to ensure widget files exist
 * This script validates that all registered widgets have corresponding files
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WIDGET_REGISTRY } from '../src/resources/widgets.js';

const filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(filename), '..');
const webDistPath = resolve(projectRoot, 'src/web/dist');

const missingWidgets: string[] = [];
const existingWidgets: string[] = [];

for (const config of Object.values(WIDGET_REGISTRY)) {
    const jsPath = resolve(webDistPath, config.jsFilename);
    if (existsSync(jsPath)) {
        existingWidgets.push(config.name);
    } else {
        missingWidgets.push(`${config.name} (${config.jsFilename})`);
    }
}

if (missingWidgets.length > 0) {
    console.error('Missing widget files:');
    for (const widget of missingWidgets) {
        console.error(`   - ${widget}`);
    }
    console.error(`\nExpected location: ${webDistPath}`);
    console.error('\nPlease build the widgets before building the server.');
    process.exit(1);
}

if (existingWidgets.length > 0) {
    console.log('All widget files found:');
    for (const widget of existingWidgets) {
        console.log(`   - ${widget}`);
    }
}

process.exit(0);
