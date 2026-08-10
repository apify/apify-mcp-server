/**
 * Langfuse dataset mapping for workflow evaluations.
 *
 * A dataset item is what a run executes: `input.query` is the agent prompt,
 * `expectedOutput` is what the judge scores against, and `metadata` carries the
 * harness knobs (a DatasetItem offers nowhere else to put them). Nothing is
 * duplicated between the three, so editing an item in the Langfuse UI changes
 * the next run.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';

import { DEFAULT_TEST_CASES_PATH, WorkflowTestCaseValidator } from './test_cases_loader.js';
import type { WorkflowTestCase } from './test_cases_loader.js';

/** Name of the Langfuse dataset that mirrors test_cases.json. */
export const WORKFLOW_DATASET_NAME = 'workflow-evals';

/** Item shape returned by the client, derived so we don't depend on @langfuse/core. */
export type DatasetItem = Awaited<ReturnType<LangfuseClient['dataset']['createItem']>>;

const WorkflowItemValidator = z.object({
    id: z.string().min(1),
    input: z.object({ query: z.string().min(1) }),
    expectedOutput: z.string().min(1),
    metadata: WorkflowTestCaseValidator.omit({ id: true, query: true, reference: true }),
});

/** The parts of a dataset item a run reads. */
export type WorkflowItem = z.infer<typeof WorkflowItemValidator>;

/**
 * Validate a dataset item before anything depends on its shape. The item is JSON
 * that round-tripped through Langfuse and can be edited in its UI, so an
 * unchecked cast here would surface as a TypeError mid-run, after LLM spend.
 */
export function parseWorkflowItem(item: unknown): WorkflowItem {
    const parsed = WorkflowItemValidator.safeParse(item);
    if (!parsed.success) {
        const id = (item as { id?: string } | null)?.id ?? '(unknown)';
        throw new Error(`Dataset item "${id}" is not a usable workflow test case: ${parsed.error.message}`);
    }
    return parsed.data;
}

/**
 * A test cases file other than the canonical one gets its own dataset. A scratch
 * file reusing the canonical ids would otherwise overwrite the inputs of every run
 * already recorded against the shared dataset.
 *
 * Takes the absolute path from `resolveTestCasesPath`: the identity of the file,
 * not the spelling of the argument, is what decides. Explicitly passing the default
 * path therefore stays on the canonical dataset, and two scratch files sharing a
 * basename in different directories get different datasets (hence the path hash).
 */
export function resolveDatasetName(testCasesPath: string): string {
    if (testCasesPath === DEFAULT_TEST_CASES_PATH) return WORKFLOW_DATASET_NAME;
    const digest = createHash('sha1').update(testCasesPath).digest('hex').slice(0, 8);
    return `${WORKFLOW_DATASET_NAME}-${path.basename(testCasesPath, '.json')}-${digest}`;
}

/**
 * Dataset item id for a test case id.
 *
 * Item ids are unique per project and cannot be reused across datasets, so a
 * scratch dataset carrying the canonical ids would re-parent the canonical items
 * instead of isolating anything. Non-canonical datasets namespace their items;
 * the canonical dataset keeps bare test case ids so its existing items and their
 * run history survive.
 */
export function resolveItemId(datasetName: string, testCaseId: string): string {
    return datasetName === WORKFLOW_DATASET_NAME ? testCaseId : `${datasetName}:${testCaseId}`;
}

/**
 * Get-or-create the dataset and upsert every test case into it, keyed by test case id.
 *
 * Returns the created items. They already carry the id, datasetId, input,
 * expectedOutput and metadata that `experiment.run` needs, so the caller never
 * has to fetch the dataset back. Errors are left to throw: a 401 or a wrong base
 * URL must stop the run, not be downgraded to a warning.
 */
export async function syncDataset(
    langfuse: LangfuseClient,
    datasetName: string,
    testCases: WorkflowTestCase[],
): Promise<DatasetItem[]> {
    // eslint-disable-next-line no-console
    console.log(`📇 Syncing ${testCases.length} test case(s) into dataset "${datasetName}"...`);

    await langfuse.api.datasets.create({
        name: datasetName,
        description: 'Multi-turn workflow evals for the Apify MCP server (mirrors test_cases.json).',
    });

    // There is no batch item endpoint, so concurrency is the only lever here.
    return Promise.all(
        testCases.map(async ({ id, query, reference, ...knobs }) =>
            langfuse.dataset.createItem({
                datasetName,
                id: resolveItemId(datasetName, id),
                input: { query },
                expectedOutput: reference,
                metadata: knobs,
            }),
        ),
    );
}
