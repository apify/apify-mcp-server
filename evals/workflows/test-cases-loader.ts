/**
 * Test case loader and filter
 */

import fs from 'fs';
import path from 'path';

/**
 * Test case structure
 */
export interface WorkflowTestCase {
    /** Unique test case ID */
    id: string;
    /** Category for grouping (e.g., "basic", "advanced", "actor-calling") */
    category: string;
    /** User prompt for the agent */
    prompt: string;
    /** Requirements that must be met for the test to pass */
    requirements: string;
    /** Maximum number of turns allowed (optional, defaults to config value) */
    maxTurns?: number;
    /** Tools to enable for this test (optional, e.g., ["actors", "docs", "apify/rag-web-browser"]) */
    tools?: string[];
}

/**
 * Load test cases from JSON file
 */
export function loadTestCases(filePath?: string): WorkflowTestCase[] {
    const testCasesPath = filePath || path.join(process.cwd(), 'evals/workflows/test-cases.json');
    
    if (!fs.existsSync(testCasesPath)) {
        throw new Error(`Test cases file not found: ${testCasesPath}`);
    }

    const content = fs.readFileSync(testCasesPath, 'utf-8');
    const testCases = JSON.parse(content) as WorkflowTestCase[];

    // Validate test cases
    const seenIds = new Set<string>();
    
    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const testCaseRef = `Test case #${i + 1} (id: ${tc.id || 'missing'})`;
        
        // Check required fields
        const missingFields: string[] = [];
        if (!tc.id) missingFields.push('id');
        if (!tc.category) missingFields.push('category');
        if (!tc.prompt) missingFields.push('prompt');
        if (!tc.requirements) missingFields.push('requirements');
        
        if (missingFields.length > 0) {
            throw new Error(
                `${testCaseRef}: Missing or empty required field(s): ${missingFields.join(', ')}\n` +
                `Required fields: id, category, prompt, requirements\n` +
                `Test case: ${JSON.stringify(tc, null, 2)}`
            );
        }
        
        // Check for duplicate IDs
        if (seenIds.has(tc.id)) {
            throw new Error(
                `${testCaseRef}: Duplicate test case ID '${tc.id}'\n` +
                `Each test case must have a unique ID.`
            );
        }
        seenIds.add(tc.id);
    }

    return testCases;
}

/**
 * Filter test cases by ID or category
 */
export function filterTestCases(
    testCases: WorkflowTestCase[],
    options: { id?: string; category?: string }
): WorkflowTestCase[] {
    let filtered = testCases;

    if (options.id) {
        filtered = filtered.filter(tc => tc.id === options.id);
    }

    if (options.category) {
        filtered = filtered.filter(tc => tc.category === options.category);
    }

    return filtered;
}
