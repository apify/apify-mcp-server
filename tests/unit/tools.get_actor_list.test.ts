import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorList } from '../../src/tools/actors/get_actor_list.js';
import { actorListOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { ALL_TOOLS_PRESENT } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    only,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const listMock = vi.fn();
const actorsMock = vi.fn(() => ({ list: listMock }));

const stubClient = { actors: actorsMock } as unknown as InternalToolArgs['apifyClient'];

/** An item of `GET /v2/acts`, with a field the tool must not pass through. */
function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        name: 'my-actor',
        username: 'alice',
        title: 'My Actor',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        modifiedAt: new Date('2026-09-02T10:00:00.000Z'),
        stats: { totalRuns: 3, lastRunStartedAt: new Date('2026-09-03T10:00:00.000Z') },
        userId: 'user-secret',
        ...overrides,
    };
}

function mockList(overrides: Record<string, unknown> = {}) {
    return { total: 1, count: 1, offset: 0, limit: 10, desc: true, items: [mockActor()], ...overrides };
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (getActorList as HelperTool).call(context)) as TextToolResult;
};

/** Every tool name that appears in the text blocks, matched on name boundaries. */
function namedTools(result: TextToolResult): string[] {
    const text = result.content.map((block) => block.text).join('\n');
    return Object.values(HELPER_TOOLS).filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text));
}

describe('get-actor-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('has the expected tool name', () => {
        expect(getActorList.name).toBe(HELPER_TOOLS.ACTOR_LIST_GET);
    });

    it('returns only the allowlisted Actor fields with ISO dates', async () => {
        listMock.mockResolvedValue(mockList());

        const { content, structuredContent } = await callTool({});

        expect(structuredContent).toEqual({
            total: 1,
            count: 1,
            offset: 0,
            limit: 10,
            desc: true,
            items: [
                {
                    id: 'actor-1',
                    name: 'my-actor',
                    fullName: 'alice/my-actor',
                    title: 'My Actor',
                    createdAt: '2026-09-01T10:00:00.000Z',
                    modifiedAt: '2026-09-02T10:00:00.000Z',
                    lastRunStartedAt: '2026-09-03T10:00:00.000Z',
                },
            ],
        });
        // content: [0] the data, [1] summary and next step.
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content[1].text).toBe(
            'Your account has 1 Actor; showing 1 from offset 0.\n' +
                `Use ${HELPER_TOOLS.ACTOR_GET_DETAILS} with an Actor's fullName to see its input schema and README.`,
        );
    });

    it("lists the account's own Actors with the default paging", async () => {
        listMock.mockResolvedValue(mockList());

        await callTool({});

        expect(actorsMock).toHaveBeenCalledWith();
        expect(listMock).toHaveBeenCalledWith({ my: true, offset: 0, limit: 10, desc: true });
    });

    it('forwards offset, limit and desc', async () => {
        listMock.mockResolvedValue(mockList({ offset: 5, limit: 20, desc: false, items: [] }));

        await callTool({ offset: 5, limit: 20, desc: false });

        expect(listMock).toHaveBeenCalledWith({ my: true, offset: 5, limit: 20, desc: false });
    });

    it('returns null for a missing title and for an Actor that never ran', async () => {
        listMock.mockResolvedValue(mockList({ items: [mockActor({ title: undefined, stats: { totalRuns: 0 } })] }));

        const result = await callTool({});
        const { items } = result.structuredContent as { items: { title: unknown; lastRunStartedAt: unknown }[] };

        expect(items[0].title).toBeNull();
        expect(items[0].lastRunStartedAt).toBeNull();
        expectSchemaConformingStructuredContent(result, actorListOutputSchema);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        listMock.mockResolvedValue(mockList());

        const result = await callTool({});

        expect((getActorList as HelperTool).outputSchema).toBe(actorListOutputSchema);
        expectSchemaConformingStructuredContent(result, actorListOutputSchema);
    });

    it('points at the next page while more Actors remain', async () => {
        listMock.mockResolvedValue(
            mockList({ total: 25, count: 2, items: [mockActor(), mockActor({ id: 'actor-2', name: 'other' })] }),
        );

        const result = await callTool({});

        expect(result.content[1].text).toBe(
            'Your account has 25 Actors; showing 2 from offset 0.\n' +
                'Call this tool again with offset=2 to fetch the next page.',
        );
        expect(namedTools(result)).toEqual([]);
    });

    it(`names no tool on the last page when ${HELPER_TOOLS.ACTOR_GET_DETAILS} is not loaded`, async () => {
        listMock.mockResolvedValue(mockList());

        const result = await callTool({}, [HELPER_TOOLS.ACTOR_LIST_GET]);

        expect(result.content[1].text).toBe('Your account has 1 Actor; showing 1 from offset 0.\nNo more pages.');
        expect(namedTools(result)).toEqual([]);
    });

    it('returns an empty list for an account without Actors, naming no tool', async () => {
        listMock.mockResolvedValue(mockList({ total: 0, count: 0, items: [] }));

        const result = await callTool({});

        expect(result.structuredContent).toMatchObject({ total: 0, count: 0, items: [] });
        expect(result.content[1].text).toBe('Your account has 0 Actors; showing 0 from offset 0.\nNo more pages.');
        expect(namedTools(result)).toEqual([]);
        expectSchemaConformingStructuredContent(result, actorListOutputSchema);
    });

    it('returns an empty page for an offset past the last Actor', async () => {
        listMock.mockResolvedValue(mockList({ total: 3, count: 0, offset: 5, items: [] }));

        const result = await callTool({ offset: 5 });

        expect(result.content[1].text).toBe('Your account has 3 Actors; showing 0 from offset 5.\nNo more pages.');
    });

    it('rethrows API errors', async () => {
        const apiError = Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
        listMock.mockRejectedValue(apiError);

        await expect(callTool({})).rejects.toBe(apiError);
    });

    it('validates offset and limit against the API bounds', () => {
        const tool = getActorList as HelperTool;
        expect(tool.ajvValidate({})).toBe(true);
        expect(tool.ajvValidate({ offset: 0, limit: 1 })).toBe(true);
        expect(tool.ajvValidate({ limit: 20 })).toBe(true);
        expect(tool.ajvValidate({ limit: 21 })).toBe(false);
        expect(tool.ajvValidate({ limit: 0 })).toBe(false);
        expect(tool.ajvValidate({ limit: 1.5 })).toBe(false);
        expect(tool.ajvValidate({ offset: -1 })).toBe(false);
    });

    it('keeps every field optional in the input schema', () => {
        expect(getActorList.inputSchema.required ?? []).toEqual([]);
    });

    it('names fetch-actor-details and search-actors in the description only when they are served', () => {
        const full = getActorList.buildDescription!(ALL_TOOLS_PRESENT);
        const alone = getActorList.buildDescription!(only(HELPER_TOOLS.ACTOR_LIST_GET));

        expect(getActorList.description).toBe(full);
        expect(full).toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(full).toContain(HELPER_TOOLS.STORE_SEARCH);
        expect(alone).not.toContain(HELPER_TOOLS.ACTOR_GET_DETAILS);
        expect(alone).not.toContain(HELPER_TOOLS.STORE_SEARCH);
    });
});
