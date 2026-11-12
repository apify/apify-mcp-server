import { describe, expect, it, vi } from 'vitest';

import { searchApifyDocs } from '../../src/tools/docs/search_apify_docs.js';
import type { HelperTool } from '../../src/types.js';
import { searchDocsBySourceCached } from '../../src/utils/apify_docs.js';
import { mockApifyClient, stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

vi.mock('../../src/utils/apify_docs.js', () => ({
    searchDocsBySourceCached: vi.fn(),
}));

describe('search-apify-docs', () => {
    it.each([
        ['results', [{ url: 'https://docs.apify.com/platform/actors', content: 'Actors are serverless programs.' }]],
        ['no results', []],
    ])('mirrors structuredContent as JSON in the first text block (%s)', async (_, results) => {
        vi.mocked(searchDocsBySourceCached).mockResolvedValue(results);

        const result = (await (searchApifyDocs as HelperTool).call(
            stubToolCallContext({ query: 'actors' }, mockApifyClient()),
        )) as TextToolResult;

        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    });
});
