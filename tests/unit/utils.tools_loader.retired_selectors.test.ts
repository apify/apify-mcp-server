import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { ApifyClient } from 'apify-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { ActorsMcpServer } from '../../src/index.js';
import type * as ToolsIndexModule from '../../src/tools/index.js';
import { SERVER_MODE } from '../../src/types.js';
import { getActors, getToolsForServerMode, toolNamesToInput } from '../../src/utils/tools_loader.js';

const RETIRED_SELECTORS = ['add-actor', 'experimental', 'preview'] as const;

vi.mock('../../src/tools/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsIndexModule>();
    return { ...actual, getActorsAsTools: vi.fn().mockResolvedValue({ tools: [], errors: [] }) };
});

const { getActorsAsTools } = await import('../../src/tools/index.js');
const getActorsAsToolsMock = vi.mocked(getActorsAsTools);
const apifyClient = new ApifyClient({ token: 'test-token' });

beforeEach(() => {
    getActorsAsToolsMock.mockClear();
});

describe('getActors()', () => {
    it.for(RETIRED_SELECTORS)('does not fetch retired selector "%s"', async (selector) => {
        const tools = await getActors({ tools: [selector] }, apifyClient);

        expect(tools).toEqual([]);
        expect(getActorsAsToolsMock).not.toHaveBeenCalled();
    });
});

describe('toolNamesToInput()', () => {
    it.for(RETIRED_SELECTORS)('drops retired selector "%s" during restore conversion', (selector) => {
        expect(toolNamesToInput([selector, HELPER_TOOLS.STORE_SEARCH])).toEqual({
            tools: [HELPER_TOOLS.STORE_SEARCH],
        });
    });
});

describe('getToolsForServerMode()', () => {
    it.for(RETIRED_SELECTORS)('loads nothing for retired selector "%s"', (selector) => {
        const toolNames = getToolsForServerMode({ tools: [selector] }, [], SERVER_MODE.DEFAULT).map(
            (tool) => tool.name,
        );

        expect(toolNames).toEqual([]);
    });

    it.for(RETIRED_SELECTORS)('ignores retired selector "%s" alongside docs', (selector) => {
        const toolNames = getToolsForServerMode({ tools: [selector, 'docs'] }, [], SERVER_MODE.DEFAULT).map(
            (tool) => tool.name,
        );

        expect(toolNames).toEqual([HELPER_TOOLS.DOCS_SEARCH, HELPER_TOOLS.DOCS_FETCH]);
    });
});

describe('ActorsMcpServer.loadToolsByName()', () => {
    it.for(RETIRED_SELECTORS)('drops restored retired selector "%s" without fetching', async (selector) => {
        const server = new ActorsMcpServer({
            setupSigintHandler: false,
            taskStore: new InMemoryTaskStore(),
            serverMode: SERVER_MODE.DEFAULT,
        });

        await server.loadToolsByName([selector], apifyClient);

        expect(getActorsAsToolsMock).not.toHaveBeenCalled();
        expect(server.listAllToolNames()).toEqual([]);
    });
});
