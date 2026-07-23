import { ApifyClient } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import type * as ToolsIndexModule from '../../src/tools/index.js';
import { getActors } from '../../src/utils/tools_loader.js';

// 'preview', 'experimental', and 'add-actor' name neither a registry category nor a real
// internal tool anymore (all three were retired). Stub getActorsAsTools so a regression that
// misclassifies one of them as an Actor name shows up as an unexpected call here, instead of a
// live "Actor not found" fetch against the real Apify API.
vi.mock('../../src/tools/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ToolsIndexModule>();
    return { ...actual, getActorsAsTools: vi.fn().mockResolvedValue({ tools: [], errors: [] }) };
});

const { getActorsAsTools } = await import('../../src/tools/index.js');
const getActorsAsToolsMock = vi.mocked(getActorsAsTools);

describe('getActors() retired selectors', () => {
    const apifyClient = new ApifyClient({ token: 'test-token' });

    it.for(['preview', 'experimental', HELPER_TOOLS.ACTOR_ADD])(
        'resolves selector "%s" to no Actor tools without attempting an Actor fetch',
        async (selector) => {
            const tools = await getActors({ tools: [selector] }, apifyClient);

            expect(tools).toEqual([]);
            expect(getActorsAsToolsMock).not.toHaveBeenCalled();
        },
    );
});
