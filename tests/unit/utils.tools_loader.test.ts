import { ApifyClient } from 'apify-client';
import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type { ToolEntry } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';
import {
    AUTO_INJECTED_TOOLS,
    getToolsForServerMode,
    loadToolsFromInput,
    toolNamesToInput,
} from '../../src/utils/tools_loader.js';

const AUTO_INJECTED_TOOL_NAMES = AUTO_INJECTED_TOOLS.map((t) => t.name);

describe('loadToolsFromInput explicit-empty semantics', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it('should not auto-add apps ui tools when tools are explicitly empty', async () => {
        const tools = await loadToolsFromInput(
            {
                tools: [],
            },
            apifyClient,
            'apps',
        );

        expect(tools).toHaveLength(0);
    });

    it('should not auto-add apps ui tools when actors are explicitly empty', async () => {
        const tools = await loadToolsFromInput(
            {
                actors: [],
            },
            apifyClient,
            'apps',
        );

        expect(tools).toHaveLength(0);
    });

    it('should not pair widgets whose base tool was not selected (apps mode, tools: ["docs"])', async () => {
        const tools = await loadToolsFromInput(
            {
                tools: ['docs'],
            },
            apifyClient,
            'apps',
        );

        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain(HELPER_TOOLS.DOCS_SEARCH);
        expect(toolNames).toContain(HELPER_TOOLS.DOCS_FETCH);
        // get-actor-run is not requested and not triggered by call-actor, so no widgets appear
        expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
        expect(toolNames).not.toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
        expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
        expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL_WIDGET);
    });
});

describe('toolNamesToInput', () => {
    it('should keep internal tool names in tools and move actor names to actors', () => {
        expect(toolNamesToInput([HELPER_TOOLS.STORE_SEARCH, 'apify/rag-web-browser'])).toEqual({
            tools: [HELPER_TOOLS.STORE_SEARCH],
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
        expect(toolNamesToInput([HELPER_TOOLS.STORE_SEARCH_WIDGET])).toEqual({
            tools: [HELPER_TOOLS.STORE_SEARCH_WIDGET],
        });
    });
});

describe('loadToolsFromInput auto-injection of storage tools', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it('auto-injects storage and abort tools when call-actor is in the default tool set', async () => {
        const tools = await loadToolsFromInput({}, apifyClient);
        const toolNames = tools.map((t) => t.name);

        expect(toolNames).toContain(HELPER_TOOLS.ACTOR_CALL);
        expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        for (const name of AUTO_INJECTED_TOOL_NAMES) expect(toolNames).toContain(name);

        const callIndex = toolNames.indexOf(HELPER_TOOLS.ACTOR_CALL);
        const runIndex = toolNames.indexOf(HELPER_TOOLS.ACTOR_RUNS_GET);
        const datasetIndex = toolNames.indexOf(HELPER_TOOLS.DATASET_GET_ITEMS);
        const kvIndex = toolNames.indexOf(HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET);
        const abortIndex = toolNames.indexOf(HELPER_TOOLS.ACTOR_RUNS_ABORT);
        expect(callIndex).toBeLessThan(runIndex);
        expect(runIndex).toBeLessThan(datasetIndex);
        expect(datasetIndex).toBeLessThan(kvIndex);
        expect(kvIndex).toBeLessThan(abortIndex);
    });

    it('does not auto-inject storage or abort tools when no actor-touching tools are present', async () => {
        const tools = await loadToolsFromInput({ tools: ['docs'] }, apifyClient);
        const toolNames = tools.map((t) => t.name);

        expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        for (const name of AUTO_INJECTED_TOOL_NAMES) expect(toolNames).not.toContain(name);
    });

    it('does not duplicate auto-injected tools when the storage category is also explicitly selected', async () => {
        const tools = await loadToolsFromInput({ tools: ['actors', 'storage', 'runs'] }, apifyClient);
        const toolNames = tools.map((t) => t.name);
        for (const name of AUTO_INJECTED_TOOL_NAMES) {
            expect(toolNames.filter((n) => n === name)).toHaveLength(1);
        }
    });

    it('auto-injects storage tools when get-actor-run is present without call-actor (runs-only session)', async () => {
        const tools = await loadToolsFromInput({ tools: ['runs'] }, apifyClient);
        const toolNames = tools.map((t) => t.name);

        expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
        expect(toolNames).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        for (const name of AUTO_INJECTED_TOOL_NAMES) expect(toolNames).toContain(name);
    });

    it.each(['default', 'apps'] as const)(
        'auto-injects get-actor-run when only direct actor tools are present (%s mode)',
        (mode) => {
            const actorTool = {
                type: TOOL_TYPE.ACTOR,
                name: 'apify--rag-web-browser',
                actorFullName: 'apify/rag-web-browser',
            } as unknown as ToolEntry;
            const tools = getToolsForServerMode({ actors: ['apify/rag-web-browser'], tools: [] }, [actorTool], mode);
            const toolNames = tools.map((t) => t.name);

            expect(toolNames).toContain('apify--rag-web-browser');
            expect(toolNames).toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
            for (const name of AUTO_INJECTED_TOOL_NAMES) expect(toolNames).toContain(name);
        },
    );
});

describe('getToolsForServerMode report-problem default injection', () => {
    // report-problem lives in the `dev` category but is injected into the default (no-selectors)
    // candidate set. Server-side servability gating is applied later in composeToolsForClient; here
    // we only assert membership of the candidate set. See getToolsForServerMode in tools_loader.ts.
    it('includes report-problem in the default set when no tools= selector is given', () => {
        const toolNames = getToolsForServerMode({}, [], 'default').map((t) => t.name);
        expect(toolNames).toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it('excludes report-problem under an explicit tools=storage selector', () => {
        const toolNames = getToolsForServerMode({ tools: ['storage'] }, [], 'default').map((t) => t.name);
        expect(toolNames).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it('includes report-problem via the dev category selector (tools=dev)', () => {
        const toolNames = getToolsForServerMode({ tools: ['dev'] }, [], 'default').map((t) => t.name);
        expect(toolNames).toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });

    it('excludes report-problem in add-actor-only mode', () => {
        const toolNames = getToolsForServerMode({ enableAddingActors: true }, [], 'default').map((t) => t.name);
        expect(toolNames).not.toContain(HELPER_TOOLS.PROBLEM_REPORT);
    });
});

describe('loadToolsFromInput explicit widget selection', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it('should resolve an explicit widget name to the widget tool in apps mode', async () => {
        const tools = await loadToolsFromInput({ tools: [HELPER_TOOLS.STORE_SEARCH_WIDGET] }, apifyClient, 'apps');
        const toolNames = tools.map((t) => t.name);
        expect(toolNames).toContain(HELPER_TOOLS.STORE_SEARCH_WIDGET);
    });

    it('should not duplicate the widget when both base and widget are explicitly selected', async () => {
        const tools = await loadToolsFromInput(
            { tools: [HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.STORE_SEARCH_WIDGET] },
            apifyClient,
            'apps',
        );
        const toolNames = tools.map((t) => t.name);
        // Base selected explicitly + widget selected explicitly + pairing pass would push widget again.
        // The de-dup pass must collapse to exactly one widget entry.
        expect(toolNames.filter((n) => n === HELPER_TOOLS.STORE_SEARCH_WIDGET)).toHaveLength(1);
        expect(toolNames.filter((n) => n === HELPER_TOOLS.STORE_SEARCH)).toHaveLength(1);
    });
});
