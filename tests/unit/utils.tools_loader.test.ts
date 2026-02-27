import { ApifyClient } from 'apify';
import { describe, expect, it } from 'vitest';

import { HelperTools } from '../../src/const.js';
import { loadToolsFromInput } from '../../src/utils/tools_loader.js';

describe('loadToolsFromInput explicit-empty semantics', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it('should not auto-add openai ui tools when tools are explicitly empty', async () => {
        const tools = await loadToolsFromInput({
            tools: [],
        }, apifyClient, 'openai');

        expect(tools).toHaveLength(0);
    });

    it('should not auto-add openai ui tools when actors are explicitly empty', async () => {
        const tools = await loadToolsFromInput({
            actors: [],
        }, apifyClient, 'openai');

        expect(tools).toHaveLength(0);
    });

    it('should keep openai ui tools and get-actor-run for non-empty selectors', async () => {
        const tools = await loadToolsFromInput({
            tools: ['docs'],
        }, apifyClient, 'openai');

        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain(HelperTools.DOCS_SEARCH);
        expect(toolNames).toContain(HelperTools.DOCS_FETCH);
        expect(toolNames).toContain(HelperTools.STORE_SEARCH_INTERNAL);
        expect(toolNames).toContain(HelperTools.ACTOR_GET_DETAILS_INTERNAL);
        expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET);
    });
});
