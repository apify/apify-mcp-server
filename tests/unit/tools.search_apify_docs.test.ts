import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_STATUS } from '../../src/const.js';
import { searchApifyDocs } from '../../src/tools/docs/search_apify_docs.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { searchDocsBySourceCached } from '../../src/utils/apify_docs.js';

vi.mock('../../src/utils/apify_docs.js', () => ({ searchDocsBySourceCached: vi.fn(async () => []) }));

async function callWithQuery(query: string) {
    return await (searchApifyDocs as HelperTool).call({ args: { query } } as unknown as InternalToolArgs);
}

describe('search-apify-docs query length', () => {
    beforeEach(() => {
        vi.mocked(searchDocsBySourceCached).mockClear();
    });

    it.each([
        ['512 ASCII characters', 'a'.repeat(512)],
        ['200 three-byte characters', 'あ'.repeat(200)],
    ])('rejects a query of %s as a user error without calling Algolia', async (_label, query) => {
        const result = await callWithQuery(query);

        expect(result).toMatchObject({ isError: true, toolTelemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL } });
        expect(searchDocsBySourceCached).not.toHaveBeenCalled();
    });

    it('searches with a query of 511 bytes', async () => {
        const query = 'a'.repeat(511);

        await callWithQuery(query);

        expect(searchDocsBySourceCached).toHaveBeenCalledWith('apify', query);
    });
});
