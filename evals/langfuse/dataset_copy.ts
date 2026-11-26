/** One-way copy of eval case files into a hosted Langfuse dataset. */

import type { LangfuseClient } from '@langfuse/client';

import type { McpAgentItem } from './dataset.js';

/**
 * Makes the dataset hold exactly the given cases as its active items, so a run can be linked
 * to it. The case files are the source: a hosted edit is overwritten.
 *
 * Each case is written under its case id; Langfuse updates an item in place when the id exists.
 * Then every active item whose id is not among the cases is archived. Writes run one at a time
 * and the first failure rejects; a failed case write rejects before anything is archived.
 *
 * Must resolve before the experiment starts: an item whose id is not in the dataset yet runs
 * outside the dataset run and outside its `pass_rate`.
 */
export async function copyCasesToDataset(
    langfuse: LangfuseClient,
    datasetName: string,
    items: McpAgentItem[],
): Promise<{ datasetId: string; archivedIds: string[] }> {
    const dataset = await langfuse.dataset.get(datasetName, { fetchItemsPageSize: 100 });

    const writeItem = async (
        item: { id: string; input?: unknown; expectedOutput?: unknown; metadata?: unknown },
        status: 'ACTIVE' | 'ARCHIVED',
    ) => {
        const { id, input, metadata } = item;
        // Langfuse keeps the hosted `expectedOutput` when the write omits it or sends null, and
        // clears it on an empty string. Without this a tool-call case would keep a reference
        // someone added in the UI, and the item validator rejects a tool-call item that has one.
        const expectedOutput = item.expectedOutput ?? '';
        try {
            await langfuse.api.datasetItems.create({ datasetName, id, input, expectedOutput, metadata, status });
        } catch (error) {
            throw new Error(
                `Copying case "${id}" to dataset "${datasetName}" failed: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    };

    for (const item of items) await writeItem(item, 'ACTIVE');

    const caseIds = new Set(items.map((item) => item.id));
    const staleItems = dataset.items.filter((hosted) => hosted.status === 'ACTIVE' && !caseIds.has(hosted.id));
    for (const hosted of staleItems) await writeItem(hosted, 'ARCHIVED');

    return { datasetId: dataset.id, archivedIds: staleItems.map((hosted) => hosted.id) };
}
