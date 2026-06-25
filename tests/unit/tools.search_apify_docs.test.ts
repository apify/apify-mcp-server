import { describe, expect, it, vi } from 'vitest';

import { DOCS_SNIPPET_MAX_LENGTH, HelperTools } from '../../src/const.js';
import { searchApifyDocsTool } from '../../src/tools/common/search_apify_docs.js';
import type { HelperTool } from '../../src/types.js';
import { searchDocsBySourceCached } from '../../src/utils/apify_docs.js';
import { stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

vi.mock('../../src/utils/apify_docs.js', () => ({
    searchDocsBySourceCached: vi.fn(),
}));

describe('search-apify-docs snippet cap', () => {
    it('clips an over-long snippet in both the text block and structuredContent', async () => {
        const longContent = 'c'.repeat(DOCS_SNIPPET_MAX_LENGTH + 2000);
        vi.mocked(searchDocsBySourceCached).mockResolvedValue([
            { url: 'https://docs.apify.com/platform/x', content: longContent },
        ]);

        const result = await (searchApifyDocsTool as HelperTool).call(
            stubToolCallContext({ docSource: 'apify', query: 'standby actor' }, {} as never),
        );
        const { content, structuredContent } = result as TextToolResult & {
            structuredContent: { results: { url: string; content?: string }[] };
        };

        const snippet = structuredContent.results[0].content as string;
        expect(snippet.length).toBeLessThan(longContent.length);
        expect(snippet).toContain(HelperTools.DOCS_FETCH);
        expect(snippet.startsWith('c'.repeat(DOCS_SNIPPET_MAX_LENGTH))).toBe(true);
        // The full untruncated content never reaches the text channel either.
        expect(content[0].text).not.toContain(longContent);
    });

    it('leaves a snippet within the cap untouched', async () => {
        const shortContent = 'short snippet';
        vi.mocked(searchDocsBySourceCached).mockResolvedValue([
            { url: 'https://docs.apify.com/platform/y', content: shortContent },
        ]);

        const result = await (searchApifyDocsTool as HelperTool).call(
            stubToolCallContext({ docSource: 'apify', query: 'whatever' }, {} as never),
        );
        const { structuredContent } = result as {
            structuredContent: { results: { content?: string }[] };
        };

        expect(structuredContent.results[0].content).toBe(shortContent);
    });
});
