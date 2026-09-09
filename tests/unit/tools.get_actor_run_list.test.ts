import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorRunList } from '../../src/tools/runs/get_actor_run_list.js';
import { actorRunListOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const listMock = vi.fn();
const actorListMock = vi.fn();
const actorMock = vi.fn(() => ({ runs: () => ({ list: actorListMock }) }));

const stubClient = {
    runs: () => ({ list: listMock }),
    actor: actorMock,
} as unknown as InternalToolArgs['apifyClient'];

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

describe('get-actor-run-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('has the expected tool name', () => {
        expect(getActorRunList.name).toBe(HELPER_TOOLS.ACTOR_RUN_LIST_GET);
    });

    it('returns runs as JSON text, mirrors them in structuredContent, and declares an outputSchema', async () => {
        listMock.mockResolvedValue(MOCK_RUNS);

        const result = await (getActorRunList as HelperTool).call(stubToolCallContext({}, stubClient));
        const { content } = result as TextToolResult;

        expect(JSON.parse(content[0].text)).toEqual(MOCK_RUNS);
        expect((result as TextToolResult).structuredContent).toEqual(MOCK_RUNS);
        expect((getActorRunList as HelperTool).outputSchema).toMatchObject({ type: 'object' });
        expectSchemaConformingStructuredContent(result, actorRunListOutputSchema);
    });

    it('forwards pagination and status filters to runs().list()', async () => {
        listMock.mockResolvedValue(MOCK_RUNS);

        await (getActorRunList as HelperTool).call(
            stubToolCallContext({ limit: 5, offset: 2, desc: true, status: 'SUCCEEDED' }, stubClient),
        );

        expect(listMock).toHaveBeenCalledWith({ limit: 5, offset: 2, desc: true, status: 'SUCCEEDED' });
        expect(actorMock).not.toHaveBeenCalled();
    });

    it('applies defaults (limit=10, offset=0, desc=false) when no params given', async () => {
        listMock.mockResolvedValue(MOCK_RUNS);

        await (getActorRunList as HelperTool).call(stubToolCallContext({}, stubClient));

        expect(listMock).toHaveBeenCalledWith({ limit: 10, offset: 0, desc: false, status: undefined });
    });

    it('lists through actor(actorId).runs().list() with the same options when actorId is given', async () => {
        actorListMock.mockResolvedValue(MOCK_RUNS);

        const result = await (getActorRunList as HelperTool).call(
            stubToolCallContext({ actorId: 'apify/web-scraper', limit: 1, desc: true, status: 'FAILED' }, stubClient),
        );

        expect(actorMock).toHaveBeenCalledWith('apify/web-scraper');
        expect(actorListMock).toHaveBeenCalledWith({ limit: 1, offset: 0, desc: true, status: 'FAILED' });
        expect(listMock).not.toHaveBeenCalled();
        expect((result as TextToolResult).structuredContent).toEqual(MOCK_RUNS);
        expectSchemaConformingStructuredContent(result, actorRunListOutputSchema);
    });

    it('returns isError with a not-found message when the Actor does not exist', async () => {
        actorListMock.mockRejectedValue(Object.assign(new Error('Actor was not found'), { statusCode: 404 }));

        const result = await (getActorRunList as HelperTool).call(
            stubToolCallContext({ actorId: 'missing' }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(structuredContent).toBeUndefined();
        expect(content[0].text).toContain("Actor 'missing' not found");
    });

    it('rethrows non-404 errors from the Actor run list', async () => {
        const serverError = Object.assign(new Error('Internal server error'), { statusCode: 500 });
        actorListMock.mockRejectedValue(serverError);

        await expect(
            (getActorRunList as HelperTool).call(stubToolCallContext({ actorId: 'act-1' }, stubClient)),
        ).rejects.toBe(serverError);
    });

    it('rejects an empty actorId via ajv validation', () => {
        const tool = getActorRunList as HelperTool;
        expect(tool.ajvValidate({ actorId: '' })).toBe(false);
        expect(tool.ajvValidate({ actorId: 'act-1' })).toBe(true);
        expect(tool.ajvValidate({})).toBe(true);
    });

    it('rejects limit above 10 via ajv validation', () => {
        const tool = getActorRunList as HelperTool;
        expect(tool.ajvValidate({ limit: 11 })).toBe(false);
        expect(tool.ajvValidate({ limit: 10 })).toBe(true);
    });
});
