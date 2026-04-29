import { ApifyClient } from 'apify-client';
import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { loadToolsFromInput, toolNamesToInput } from '../../src/utils/tools_loader.js';

describe('loadToolsFromInput explicit-empty semantics', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it('should not auto-add apps ui tools when tools are explicitly empty', async () => {
        const tools = await loadToolsFromInput({
            tools: [],
        }, apifyClient, 'apps');

        expect(tools).toHaveLength(0);
    });

    it('should not auto-add apps ui tools when actors are explicitly empty', async () => {
        const tools = await loadToolsFromInput({
            actors: [],
        }, apifyClient, 'apps');

        expect(tools).toHaveLength(0);
    });

    it('should keep apps ui tools and get-actor-run for non-empty selectors', async () => {
        const tools = await loadToolsFromInput({
            tools: ['docs'],
        }, apifyClient, 'apps');

        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain(HelperTools.DOCS_SEARCH);
        expect(toolNames).toContain(HelperTools.DOCS_FETCH);
        expect(toolNames).toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
        expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET);
    });
});

describe('toolNamesToInput', () => {
    it('should keep internal tool names in tools and move actor names to actors', () => {
        expect(toolNamesToInput([
            HelperTools.STORE_SEARCH,
            'apify/rag-web-browser',
        ])).toEqual({
            tools: [HelperTools.STORE_SEARCH],
            actors: ['apify/rag-web-browser'],
        });
    });

    it('should suppress default categories when restoring only actor tools', () => {
        expect(toolNamesToInput(['apify/rag-web-browser'])).toEqual({
            tools: [],
            actors: ['apify/rag-web-browser'],
        });
    });
});
