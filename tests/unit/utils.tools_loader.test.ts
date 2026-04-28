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

    it('should not pair widgets whose base tool was not selected (apps mode, tools: ["docs"])', async () => {
        const tools = await loadToolsFromInput({
            tools: ['docs'],
        }, apifyClient, 'apps');

        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain(HelperTools.DOCS_SEARCH);
        expect(toolNames).toContain(HelperTools.DOCS_FETCH);
        // get-actor-run is auto-injected in apps mode, so its widget pairs with it
        expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET);
        expect(toolNames).toContain(HelperTools.ACTOR_RUNS_GET_WIDGET);
        // Widgets whose base tools are not in the selection must NOT appear
        expect(toolNames).not.toContain(HelperTools.STORE_SEARCH_WIDGET);
        expect(toolNames).not.toContain(HelperTools.ACTOR_GET_DETAILS_WIDGET);
        expect(toolNames).not.toContain(HelperTools.ACTOR_CALL_WIDGET);
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

    it('should classify widget tool names as internal tools, not actor IDs', () => {
        expect(toolNamesToInput([HelperTools.STORE_SEARCH_WIDGET])).toEqual({
            tools: [HelperTools.STORE_SEARCH_WIDGET],
        });
    });
});

describe('loadToolsFromInput explicit widget selection', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it('should resolve an explicit widget name to the widget tool in apps mode', async () => {
        const tools = await loadToolsFromInput(
            { tools: [HelperTools.STORE_SEARCH_WIDGET] },
            apifyClient,
            'apps',
        );
        const toolNames = tools.map((t) => t.name);
        expect(toolNames).toContain(HelperTools.STORE_SEARCH_WIDGET);
        // Actor names must NOT include the widget name
        expect(toolNames.filter((n) => n === HelperTools.STORE_SEARCH_WIDGET)).toHaveLength(1);
    });
});
