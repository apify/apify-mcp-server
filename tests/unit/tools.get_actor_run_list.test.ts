import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorRunList } from '../../src/tools/runs/get_actor_run_list.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { stubToolCallContext, type TextToolResult } from './helpers/tool_context.js';

const listMock = vi.fn();

vi.mock('../../src/apify_client.js', () => ({
    ApifyClient: vi.fn().mockImplementation(function () {
        return { runs: () => ({ list: listMock }) };
    }),
}));

const MOCK_RUNS = {
    total: 1,
    offset: 0,
    limit: 10,
    desc: false,
    count: 1,
    items: [
        {
            id: 'run-1',
            actId: 'act-1',
            status: 'SUCCEEDED',
            startedAt: '2026-05-12T09:18:27.527Z',
            finishedAt: '2026-05-12T09:19:01.000Z',
            defaultDatasetId: 'ds-1',
            defaultKeyValueStoreId: 'kv-1',
        },
    ],
};

// get_actor_run_list constructs its own ApifyClient from the token, so the injected client is unused.
const noClient = null as unknown as InternalToolArgs['apifyClient'];

describe('get-actor-run-list', () => {
    it('has the expected tool name', () => {
        expect(getActorRunList.name).toBe(HELPER_TOOLS.ACTOR_RUN_LIST_GET);
    });

    it('returns runs as JSON text, mirrors them in structuredContent, and declares an outputSchema', async () => {
        listMock.mockResolvedValue(MOCK_RUNS);

        const result = await (getActorRunList as HelperTool).call(stubToolCallContext({}, noClient));
        const { content } = result as TextToolResult;

        expect(JSON.parse(content[0].text)).toEqual(MOCK_RUNS);
        expect((result as TextToolResult).structuredContent).toEqual(MOCK_RUNS);
        expect((getActorRunList as HelperTool).outputSchema).toMatchObject({ type: 'object' });
    });

    it('forwards pagination and status filters to runs().list()', async () => {
        listMock.mockResolvedValue(MOCK_RUNS);

        await (getActorRunList as HelperTool).call(
            stubToolCallContext({ limit: 5, offset: 2, desc: true, status: 'SUCCEEDED' }, noClient),
        );

        expect(listMock).toHaveBeenCalledWith({ limit: 5, offset: 2, desc: true, status: 'SUCCEEDED' });
    });

    it('applies defaults (limit=10, offset=0, desc=false) when no params given', async () => {
        listMock.mockResolvedValue(MOCK_RUNS);

        await (getActorRunList as HelperTool).call(stubToolCallContext({}, noClient));

        expect(listMock).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, status: undefined });
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getActorRunList as HelperTool;
        expect(tool.ajvValidate({ limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ limit: 10 })).toBe(true);
    });
});
