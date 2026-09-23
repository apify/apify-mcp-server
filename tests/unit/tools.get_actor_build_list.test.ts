import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorBuildList } from '../../src/tools/builds/get_actor_build_list.js';
import { getActorBuildListToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

const listMock = vi.fn();
const buildsMock = vi.fn(() => ({ list: listMock }));
const actorMock = vi.fn(() => ({ builds: buildsMock }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

/** A build list item as the API returns it, with internal fields that the tool must not leak. */
function mockBuild(overrides: Record<string, unknown> = {}) {
    return {
        id: 'build-1',
        actId: 'actor-1',
        userId: 'user-secret',
        buildNumber: '0.1.1',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-09-01T10:00:00.000Z'),
        finishedAt: new Date('2026-09-01T10:01:00.000Z'),
        usageTotalUsd: 0.02,
        meta: { origin: 'API' },
        ...overrides,
    };
}

function mockPage(items: ReturnType<typeof mockBuild>[], overrides: Record<string, unknown> = {}) {
    return { total: items.length, count: items.length, offset: 0, limit: 10, desc: true, items, ...overrides };
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (getActorBuildList as HelperTool).call(context)) as TextToolResult;
};

/** HELPER_TOOLS names found in `text`, with a boundary so `get-actor-build` does not match inside `get-actor-build-log`. */
function findToolNames(text: string): string[] {
    return Object.values(HELPER_TOOLS).filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text));
}

describe('get-actor-build-list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('has the expected tool name', () => {
        expect(getActorBuildList.name).toBe(HELPER_TOOLS.ACTOR_BUILD_LIST_GET);
    });

    it('returns only the allowlisted page and build fields', async () => {
        listMock.mockResolvedValue(mockPage([mockBuild()]));

        const { content, structuredContent } = await callTool({ actor: 'john/my-actor' });

        expect(structuredContent).toEqual({
            total: 1,
            count: 1,
            offset: 0,
            limit: 10,
            desc: true,
            items: [
                {
                    id: 'build-1',
                    actorId: 'actor-1',
                    buildNumber: '0.1.1',
                    status: 'SUCCEEDED',
                    startedAt: '2026-09-01T10:00:00.000Z',
                    finishedAt: '2026-09-01T10:01:00.000Z',
                },
            ],
        });
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        // content: [0] data, [1] summary with its next step.
        expect(content).toHaveLength(2);
        expect(content[1].text).toBe(
            `Actor john/my-actor has 1 builds; showing 1 from offset 0.\nCheck a build with ${HELPER_TOOLS.ACTOR_BUILD_GET} using its buildId.`,
        );
    });

    it('sends the defaults (offset 0, limit 10, newest first) to the Actor build list', async () => {
        listMock.mockResolvedValue(mockPage([mockBuild()]));

        await callTool({ actor: 'john/my-actor' });

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(buildsMock).toHaveBeenCalledWith();
        expect(listMock).toHaveBeenCalledWith({ offset: 0, limit: 10, desc: true });
    });

    it('forwards explicit offset, limit and desc', async () => {
        listMock.mockResolvedValue(mockPage([mockBuild()], { total: 30, offset: 20, limit: 5, desc: false }));

        const { content } = await callTool({ actor: 'actor-1', offset: 20, limit: 5, desc: false });

        expect(listMock).toHaveBeenCalledWith({ offset: 20, limit: 5, desc: false });
        expect(content[1].text).toContain('Actor actor-1 has 30 builds; showing 1 from offset 20.');
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        listMock.mockResolvedValue(mockPage([mockBuild(), mockBuild({ id: 'build-2', status: 'FAILED' })]));

        const result = await callTool({ actor: 'actor-1' });

        expect((getActorBuildList as HelperTool).outputSchema).toBe(getActorBuildListToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorBuildListToolOutputSchema);
    });

    it('returns null dates for a build that has not started or finished, conforming to the outputSchema', async () => {
        listMock.mockResolvedValue(
            mockPage([mockBuild({ status: 'READY', startedAt: undefined, finishedAt: undefined })]),
        );

        const result = await callTool({ actor: 'actor-1' });

        expect((result.structuredContent as { items: Record<string, unknown>[] }).items[0]).toMatchObject({
            startedAt: null,
            finishedAt: null,
        });
        expectSchemaConformingStructuredContent(result, getActorBuildListToolOutputSchema);
    });

    it('returns an empty page with a summary and no next step', async () => {
        listMock.mockResolvedValue(mockPage([]));

        const result = await callTool({ actor: 'actor-1' });

        expect(result.content[1].text).toBe('Actor actor-1 has 0 builds; showing 0 from offset 0.');
        expectSchemaConformingStructuredContent(result, getActorBuildListToolOutputSchema);
    });

    it('returns a not-found error when the Actor does not exist', async () => {
        listMock.mockRejectedValue(Object.assign(new Error('Actor was not found'), { statusCode: 404 }));

        const result = await (getActorBuildList as HelperTool).call(
            stubToolCallContext({ actor: 'missing' }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(actorMock).toHaveBeenCalledWith('missing');
        expect(content[0].text).toBe("Actor 'missing' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('rethrows non-404 errors from the build list', async () => {
        const serverError = Object.assign(new Error('Internal server error'), { statusCode: 500 });
        listMock.mockRejectedValue(serverError);

        await expect(callTool({ actor: 'actor-1' })).rejects.toBe(serverError);
    });

    describe('input validation', () => {
        it('rejects an empty or missing actor via ajv validation', () => {
            const tool = getActorBuildList as HelperTool;
            expect(tool.ajvValidate({ actor: '' })).toBe(false);
            expect(tool.ajvValidate({})).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1' })).toBe(true);
        });

        it('rejects limit outside 1..10 or not an integer via ajv validation', () => {
            const tool = getActorBuildList as HelperTool;
            expect(tool.ajvValidate({ actor: 'actor-1', limit: 0 })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', limit: 11 })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', limit: 2.5 })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', limit: 1 })).toBe(true);
            expect(tool.ajvValidate({ actor: 'actor-1', limit: 10 })).toBe(true);
        });

        it('rejects a negative or fractional offset via ajv validation', () => {
            const tool = getActorBuildList as HelperTool;
            expect(tool.ajvValidate({ actor: 'actor-1', offset: -1 })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', offset: 1.5 })).toBe(false);
            expect(tool.ajvValidate({ actor: 'actor-1', offset: 0 })).toBe(true);
        });

        it('keeps only actor required in the input schema', () => {
            expect(getActorBuildList.inputSchema.required).toEqual(['actor']);
        });
    });

    describe('nextStep', () => {
        it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])(
            'points a %s build at get-actor-build-log when that tool is loaded',
            async (status) => {
                listMock.mockResolvedValue(mockPage([mockBuild({ id: 'build-9', buildNumber: '0.1.9', status })]));

                const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD_LOG]);

                expect(content[1].text).toBe(
                    `Actor actor-1 has 1 builds; showing 1 from offset 0.\nRead why build 0.1.9 failed with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId build-9.`,
                );
            },
        );

        it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])(
            'names no tool for a %s build when get-actor-build-log is not loaded',
            async (status) => {
                listMock.mockResolvedValue(mockPage([mockBuild({ id: 'build-9', buildNumber: '0.1.9', status })]));

                // get-actor-build is loaded but is not the log tool; the hint must not fall back to it.
                const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

                expect(content[1].text).toBe(
                    'Actor actor-1 has 1 builds; showing 1 from offset 0.\nRead the log of build 0.1.9 (ID build-9) to see why it failed.',
                );
            },
        );

        it('points at the first failed build of a newest-first page', async () => {
            listMock.mockResolvedValue(
                mockPage([
                    mockBuild({ id: 'build-4', buildNumber: '0.1.4', status: 'SUCCEEDED' }),
                    mockBuild({ id: 'build-3', buildNumber: '0.1.3', status: 'FAILED' }),
                    mockBuild({ id: 'build-2', buildNumber: '0.1.2', status: 'ABORTED' }),
                ]),
            );

            const { content } = await callTool({ actor: 'actor-1' });

            expect(content[1].text).toContain(
                `Read why build 0.1.3 failed with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId build-3.`,
            );
        });

        it('points at the last failed build of an oldest-first page', async () => {
            listMock.mockResolvedValue(
                mockPage(
                    [
                        mockBuild({ id: 'build-2', buildNumber: '0.1.2', status: 'ABORTED' }),
                        mockBuild({ id: 'build-3', buildNumber: '0.1.3', status: 'TIMED-OUT' }),
                        mockBuild({ id: 'build-4', buildNumber: '0.1.4', status: 'SUCCEEDED' }),
                    ],
                    { desc: false },
                ),
            );

            const { content } = await callTool({ actor: 'actor-1', desc: false });

            expect(content[1].text).toContain(
                `Read why build 0.1.3 failed with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId build-3.`,
            );
        });

        it('names no tool when the page has no failed build and get-actor-build is not loaded', async () => {
            listMock.mockResolvedValue(mockPage([mockBuild(), mockBuild({ id: 'build-2', status: 'RUNNING' })]));

            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD_LOG]);

            expect(content[1].text).toBe('Actor actor-1 has 2 builds; showing 2 from offset 0.');
        });

        it.each([
            ['a failed build', 'FAILED'],
            ['no failed build', 'SUCCEEDED'],
        ])('names no tool that is not loaded for a page with %s', async (_label, status) => {
            listMock.mockResolvedValue(mockPage([mockBuild({ status })]));

            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD_LIST_GET]);

            expect(findToolNames(content[1].text)).toEqual([]);
        });
    });

    describe('description', () => {
        const tool = getActorBuildList as HelperTool;
        const renderDescription = (...present: string[]) => tool.buildDescription?.(only(...present)) ?? '';

        it('names get-actor-build and get-actor-build-log only when those tools are in the session', () => {
            const withBoth = renderDescription(HELPER_TOOLS.ACTOR_BUILD_GET, HELPER_TOOLS.ACTOR_BUILD_LOG);
            expect(withBoth).toContain(
                `Check a build with ${HELPER_TOOLS.ACTOR_BUILD_GET} by passing its id as buildId.`,
            );
            expect(withBoth).toContain(
                `Read why a build failed with ${HELPER_TOOLS.ACTOR_BUILD_LOG} by passing its id as buildId.`,
            );
            expect(tool.description).toBe(withBoth);

            const withoutSiblings = renderDescription(HELPER_TOOLS.ACTOR_BUILD_LIST_GET);
            expect(findToolNames(withoutSiblings)).toEqual([]);

            const onlyLog = renderDescription(HELPER_TOOLS.ACTOR_BUILD_LOG);
            expect(findToolNames(onlyLog)).toEqual([HELPER_TOOLS.ACTOR_BUILD_LOG]);
        });

        it('says the list covers every status', () => {
            expect(tool.description).toContain('Lists builds in every status; there is no status filter.');
        });
    });
});
