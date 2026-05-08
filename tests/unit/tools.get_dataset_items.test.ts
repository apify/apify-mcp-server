import { describe, expect, it } from 'vitest';

import { getDatasetItems } from '../../src/tools/common/get_dataset_items.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';

/**
 * get-dataset-items returns a `structuredContent` payload that should match
 * the declared `datasetItemsOutputSchema`. The schema declares `limit` as
 * `{ type: 'number' }` and does not list it in `required`. When the caller
 * does not supply `limit`, the response must omit the key entirely rather
 * than carrying `limit: undefined` (issue #731).
 */

const MOCK_ITEMS = [{ first_number: 3, second_number: 4, sum: 7 }];

function stubApifyClient(returnTotal = 1): InternalToolArgs['apifyClient'] {
    return {
        dataset: (_id: string) => ({
            listItems: async (_opts: unknown) => ({
                items: MOCK_ITEMS,
                total: returnTotal,
            }),
        }),
    } as unknown as InternalToolArgs['apifyClient'];
}

function stubArgs(args: Record<string, unknown>): InternalToolArgs {
    return {
        args,
        apifyToken: 'test-token',
        apifyClient: stubApifyClient(),
        extra: {} as InternalToolArgs['extra'],
        mcpServer: {} as InternalToolArgs['mcpServer'],
        apifyMcpServer: { options: { paymentProvider: undefined } } as InternalToolArgs['apifyMcpServer'],
    } as InternalToolArgs;
}

describe('get-dataset-items structuredContent', () => {
    it('omits `limit` from structuredContent when caller did not provide one', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubArgs({ datasetId: 'ds-1' }),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).not.toHaveProperty('limit');
        expect(structuredContent.datasetId).toBe('ds-1');
        expect(structuredContent.itemCount).toBe(MOCK_ITEMS.length);
    });

    it('includes `limit` in structuredContent when caller provided one', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubArgs({ datasetId: 'ds-1', limit: 10 }),
        );
        const { structuredContent } = result as { structuredContent: Record<string, unknown> };

        expect(structuredContent).toHaveProperty('limit', 10);
    });

    it('survives a JSON serialization round-trip without exposing undefined', async () => {
        const result = await (getDatasetItems as HelperTool).call(
            stubArgs({ datasetId: 'ds-1' }),
        );
        const { structuredContent } = result as { structuredContent: unknown };

        const reparsed = JSON.parse(JSON.stringify(structuredContent)) as Record<string, unknown>;
        expect(reparsed).not.toHaveProperty('limit');
    });
});
