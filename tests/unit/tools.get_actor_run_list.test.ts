import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorRunList } from '../../src/tools/runs/get_actor_run_list.js';
import { actorRunListOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const listMock = vi.fn();
const actorListMock = vi.fn();
const actorMock = vi.fn(() => ({ runs: () => ({ list: actorListMock }) }));

const stubClient = mockApifyClient({
    runs: () => ({ list: listMock }),
    actor: actorMock,
});

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

/** What the list endpoint rejects with when no Actor matches. */
function buildNotFoundError() {
    return Object.assign(new Error('Actor was not found'), { statusCode: 404 });
}

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

    describe('actorId lookup', () => {
        const callTool = async (args: Record<string, unknown>) =>
            (await (getActorRunList as HelperTool).call(stubToolCallContext(args, stubClient))) as TextToolResult;

        it('lists the runs of a bare name once, as the name of one of your own Actors', async () => {
            actorListMock.mockResolvedValue(MOCK_RUNS);

            const { structuredContent } = await callTool({ actorId: 'my-actor' });

            expect(actorMock.mock.calls).toEqual([['~my-actor']]);
            expect(actorListMock).toHaveBeenCalledTimes(1);
            expect(structuredContent).toEqual(MOCK_RUNS);
        });

        it('lists the runs of a bare value shaped like an ID as a name when no Actor has that ID', async () => {
            actorListMock.mockRejectedValueOnce(buildNotFoundError()).mockResolvedValueOnce(MOCK_RUNS);

            const { structuredContent } = await callTool({ actorId: 'myscraperversion2' });

            expect(actorMock.mock.calls).toEqual([['myscraperversion2'], ['~myscraperversion2']]);
            expect(structuredContent).toEqual(MOCK_RUNS);
        });

        it('lists an empty page for an ID without retrying it as a name', async () => {
            actorListMock.mockResolvedValue({ ...MOCK_RUNS, total: 0, count: 0, items: [] });

            await callTool({ actorId: 'qGXMy0NAkWsIIb9LZ' });

            expect(actorMock.mock.calls).toEqual([['qGXMy0NAkWsIIb9LZ']]);
        });

        it.each(['qGXMy0NAkWsIIb9LZ', 'john/my-actor', 'john~my-actor'])(
            'lists the runs of %s once, as given',
            async (actorId) => {
                actorListMock.mockResolvedValue(MOCK_RUNS);

                await callTool({ actorId });

                expect(actorMock.mock.calls).toEqual([[actorId]]);
            },
        );

        it.each([
            ['a bare name', 'missing', ['~missing']],
            ['a bare value shaped like an ID', 'myscraperversion2', ['myscraperversion2', '~myscraperversion2']],
            ['a full name', 'john/missing', ['john/missing']],
        ])('returns isError with a not-found message for %s that matches no Actor', async (_, actorId, lookups) => {
            actorListMock.mockRejectedValue(buildNotFoundError());

            const result = await (getActorRunList as HelperTool).call(stubToolCallContext({ actorId }, stubClient));
            const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

            expectSoftFailInvalidInput(result);
            expect(actorMock.mock.calls).toEqual(lookups.map((lookup) => [lookup]));
            expect(structuredContent).toBeUndefined();
            expect(content[0].text).toBe(
                `Actor '${actorId}' not found. The actorId argument takes an ID, a name (resolved against your own Actors), or a full name as username/name.`,
            );
        });
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

    // Regression: #1479 — the API reads limit=0 as no limit and returns up to 1,000 items.
    it.each([0, -1, 1.5, 11])('rejects limit %s via ajv validation', (limit) => {
        expect((getActorRunList as HelperTool).ajvValidate({ limit })).toBe(false);
    });

    it.each([{ limit: 1 }, { limit: 10 }, {}])('accepts %j via ajv validation', (args) => {
        expect((getActorRunList as HelperTool).ajvValidate(args)).toBe(true);
    });
});
