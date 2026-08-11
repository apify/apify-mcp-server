/**
 * Langfuse dataset mapping for workflow evaluations.
 *
 * The dataset is the source of truth and nothing here writes to it. An item's
 * `input.query` is the agent prompt, `expectedOutput` is what the judge scores against,
 * and `metadata` carries the harness knobs.
 */

import type { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';

/** Name of the Langfuse dataset holding the workflow test cases. */
export const WORKFLOW_DATASET_NAME = 'workflow-evals';

/** Item shape returned by the client, derived so we don't depend on @langfuse/core. */
export type DatasetItem = Awaited<ReturnType<LangfuseClient['dataset']['get']>>['items'][number];

/**
 * The harness knobs, which live in item metadata.
 *
 * Strict: items are edited in the Langfuse UI, and a silently stripped typo (e.g.
 * `failTool`) turns off the behavior a case tests while the case still passes.
 */
const WorkflowMetadataValidator = z.strictObject({
    /** Grouping key, e.g. "search-actors". What `--category` matches on. */
    category: z.string().min(1),
    /** Defaults to the config value */
    maxTurns: z.number().int().positive().optional(),
    /** Tools to enable, e.g. ["actors", "docs", "apify/rag-web-browser"] */
    tools: z.array(z.string()).optional(),
    /** Tools the harness force-fails with a synthetic INTERNAL_ERROR. See mcp_client.ts. */
    failTools: z.array(z.string()).optional(),
});

const WorkflowItemValidator = z.object({
    id: z.string().min(1),
    input: z.object({ query: z.string().min(1) }),
    expectedOutput: z.string().min(1),
    metadata: WorkflowMetadataValidator,
});

/** The parts of a dataset item a run reads. */
export type WorkflowItem = z.infer<typeof WorkflowItemValidator>;

/** Flat view of an item: what the CLI filters on and what the snapshot file holds. */
export type WorkflowTestCase = z.infer<typeof WorkflowMetadataValidator> & {
    id: string;
    query: string;
    reference: string;
};

/** A dataset item plus its flat view, so the shared filter helpers apply directly. */
export type WorkflowCase = WorkflowTestCase & { item: DatasetItem };

/**
 * Validate a dataset item before anything depends on its shape. It is UI-editable JSON,
 * so an unchecked cast would surface as a TypeError mid-run, after LLM spend.
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
 * Flatten an item into a test case. Keys are written out rather than spread so absent
 * knobs stay absent and the exported snapshot keeps a stable key order for diffing.
 */
export function toWorkflowTestCase(item: unknown): WorkflowTestCase {
    const { id, input, expectedOutput, metadata } = parseWorkflowItem(item);
    return {
        id,
        category: metadata.category,
        query: input.query,
        reference: expectedOutput,
        ...(metadata.maxTurns !== undefined && { maxTurns: metadata.maxTurns }),
        ...(metadata.tools !== undefined && { tools: metadata.tools }),
        ...(metadata.failTools !== undefined && { failTools: metadata.failTools }),
    };
}

/**
 * Every active case in the dataset, sorted by id.
 *
 * `dataset.get` returns archived items too, and archiving in the UI is how a case is
 * retired. Validating all items up front fails a malformed one before any LLM spend.
 */
export async function fetchWorkflowCases(langfuse: LangfuseClient, datasetName: string): Promise<WorkflowCase[]> {
    const dataset = await langfuse.dataset.get(datasetName, { fetchItemsPageSize: 100 });

    return dataset.items
        .filter((item) => item.status === 'ACTIVE')
        .map((item) => ({ ...toWorkflowTestCase(item), item }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
