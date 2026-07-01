import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { CODE_DOCS_PAGE_NAMES } from '../../src/tools/actors/code_docs_content.js';
import { getCodeDocs } from '../../src/tools/actors/get_code_docs.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

type DocsResult = TextToolResult & { structuredContent?: { page: string; content: string } };

async function getPage(args: Record<string, unknown>): Promise<DocsResult> {
    const client = {} as unknown as InternalToolArgs['apifyClient'];
    return (await (getCodeDocs as HelperTool).call(stubToolCallContext(args, client))) as DocsResult;
}

describe('get-code-docs', () => {
    it('defaults to the overview page and indexes the other pages', async () => {
        const result = await getPage({});

        expect(result.structuredContent?.page).toBe('overview');
        const text = result.content.map((c) => c.text).join('\n');
        expect(text).toContain('Code Mode');
        for (const name of CODE_DOCS_PAGE_NAMES) {
            if (name !== 'overview') expect(text).toContain(name);
        }
    });

    it('returns each named page with non-empty content', async () => {
        for (const page of CODE_DOCS_PAGE_NAMES) {
            const result = await getPage({ page });
            expect(result.structuredContent?.page).toBe(page);
            expect((result.structuredContent?.content ?? '').length).toBeGreaterThan(50);
        }
    });

    it('api page lists the apify binding namespaces', async () => {
        const result = await getPage({ page: 'api' });
        const text = result.content.map((c) => c.text).join('\n');
        expect(text).toContain('apify.actor.');
        expect(text).toContain('apify.dataset.');
        expect(text).toContain('apify.kvs.');
    });

    it('overview recommends logging storage IDs to avoid re-running the Actor', async () => {
        const result = await getPage({});
        const text = result.content.map((c) => c.text).join('\n');
        expect(text).toContain('defaultDatasetId');
    });

    it("overview tells the agent to fetch each Actor's details for its schemas", async () => {
        const result = await getPage({});
        const text = result.content.map((c) => c.text).join('\n');
        expect(text).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
    });
});
