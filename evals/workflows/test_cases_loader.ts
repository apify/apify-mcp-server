/**
 * Test case loading and validation for workflow evaluations.
 * Uses the shared JSON reader plus the workflow test case schema.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadTestCases as loadTestCasesShared } from '../shared/test_case_loader.js';

/** The canonical test cases file, resolved from this module so cwd cannot change it. */
export const DEFAULT_TEST_CASES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test_cases.json');

/**
 * A workflow test case (multi-turn agent conversation).
 *
 * Validated rather than cast because it is read from a JSON file and, once synced,
 * from a Langfuse dataset item that can be edited outside this repo.
 *
 * Strict: an unknown key is a typo'd harness knob. Stripping it silently would let
 * `failTool` sync as nothing, the forced INTERNAL_ERROR never fire, and the eval go
 * green without testing what it claims to test.
 */
export const WorkflowTestCaseValidator = z.strictObject({
    /** Unique test case ID */
    id: z.string().min(1),
    /** Category for grouping (e.g., "search-actors", "call-actor") */
    category: z.string().min(1),
    /** User query/prompt given to the agent */
    query: z.string().min(1),
    /** Requirements the judge scores the conversation against */
    reference: z.string().min(1),
    /** Maximum number of turns allowed (defaults to the config value) */
    maxTurns: z.number().int().positive().optional(),
    /** Tools to enable for this test (e.g., ["actors", "docs", "apify/rag-web-browser"]) */
    tools: z.array(z.string()).optional(),
    /**
     * Tool names the harness force-fails with a synthetic INTERNAL_ERROR carrying the real
     * report-problem nudge. Lets an eval deterministically throw a nudge-eligible error
     * that the live server + API cannot reproduce on demand. See mcp_client.ts.
     */
    failTools: z.array(z.string()).optional(),
});

export type WorkflowTestCase = z.infer<typeof WorkflowTestCaseValidator>;

const WorkflowTestCasesValidator = z
    .array(WorkflowTestCaseValidator)
    .refine((testCases) => new Set(testCases.map((testCase) => testCase.id)).size === testCases.length, {
        message: 'Test case ids must be unique',
    });

/**
 * Absolute path of the file a run reads.
 *
 * `--test-cases-path` is resolved against cwd, like any other CLI path argument.
 * Resolving here rather than at each use site is what keeps the read and the dataset
 * name pointing at one file: the shared reader resolves relative paths against
 * `evals/`, so an unresolved path would name one file and read another.
 */
export function resolveTestCasesPath(filePath?: string): string {
    return filePath ? path.resolve(filePath) : DEFAULT_TEST_CASES_PATH;
}

/**
 * Load workflow test cases, validating every case.
 *
 * Takes an absolute path from `resolveTestCasesPath`. A missing file surfaces as the
 * reader's own ENOENT, which already names the path.
 */
export function loadTestCases(testCasesPath: string): WorkflowTestCase[] {
    return WorkflowTestCasesValidator.parse(loadTestCasesShared(testCasesPath).testCases);
}
