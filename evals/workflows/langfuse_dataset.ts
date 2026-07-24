/**
 * Langfuse dataset sync for workflow evaluations.
 *
 * The dataset `workflow-evals` mirrors test_cases.json. On every run we upsert
 * ALL test cases (by id) so the dataset stays complete regardless of the
 * --id/--category filters applied to the run itself.
 */

import type { LangfuseClient } from '@langfuse/client';

import type { WorkflowTestCase } from './test_cases_loader.js';

/** Name of the Langfuse dataset that mirrors test_cases.json. */
export const WORKFLOW_DATASET_NAME = 'workflow-evals';

/** Upsert request shape, derived from the client so we don't depend on @langfuse/core. */
type CreateDatasetItemRequest = Parameters<LangfuseClient['dataset']['createItem']>[0];

/**
 * Map a test case to a Langfuse dataset item upsert request. The test case id
 * is used as the item id, so re-syncing is idempotent (upsert in place). Pure.
 */
export function testCaseToDatasetItem(testCase: WorkflowTestCase): CreateDatasetItemRequest {
    return {
        datasetName: WORKFLOW_DATASET_NAME,
        id: testCase.id,
        input: { query: testCase.query },
        expectedOutput: testCase.reference ?? null,
        metadata: {
            category: testCase.category,
            ...(testCase.maxTurns !== undefined ? { maxTurns: testCase.maxTurns } : {}),
            ...(testCase.tools ? { tools: testCase.tools } : {}),
            ...(testCase.failTools ? { failTools: testCase.failTools } : {}),
        },
    };
}

/**
 * Ensure the dataset exists and upsert every test case into it.
 * Creating a dataset that already exists is a no-op (get-or-create); any error
 * there is logged and swallowed so a run is never blocked by dataset setup.
 */
export async function syncDataset(langfuse: LangfuseClient, testCases: WorkflowTestCase[]): Promise<void> {
    try {
        await langfuse.api.datasets.create({
            name: WORKFLOW_DATASET_NAME,
            description: 'Multi-turn workflow evals for the Apify MCP server (mirrors test_cases.json).',
        });
    } catch (error) {
        // Get-or-create: a duplicate name is expected on re-runs. Log and continue.
        // eslint-disable-next-line no-console
        console.warn(
            `⚠️  Dataset create returned an error (continuing): ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    for (const testCase of testCases) {
        await langfuse.dataset.createItem(testCaseToDatasetItem(testCase));
    }
}
