import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorBuild } from '../../src/tools/deploy/get_actor_build.js';
import { getActorBuildToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const getMock = vi.fn();
const buildMock = vi.fn(() => ({ get: getMock }));

const stubClient = { build: buildMock } as unknown as InternalToolArgs['apifyClient'];

/** A build API document with internal fields that the tool must not leak. */
function mockBuild(overrides: Record<string, unknown> = {}) {
    return {
        id: 'build-1',
        actId: 'actor-1',
        userId: 'user-secret',
        buildNumber: '0.1.12',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-09-01T10:00:00.000Z'),
        finishedAt: new Date('2026-09-01T10:01:00.000Z'),
        meta: { origin: 'API' },
        options: { useCache: true },
        inspectorId: 'inspector-secret',
        ...overrides,
    };
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (getActorBuild as HelperTool).call(context)) as TextToolResult;
};

describe('get-actor-build', () => {
    it('has the expected tool name', () => {
        expect(getActorBuild.name).toBe(HELPER_TOOLS.ACTOR_BUILD_GET);
    });

    it('returns only the allowlisted build fields', async () => {
        getMock.mockResolvedValue(mockBuild());

        const { content, structuredContent } = await callTool({ buildId: 'build-1' });

        expect(structuredContent).toEqual({
            build: {
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.1.12',
                status: 'SUCCEEDED',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: '2026-09-01T10:01:00.000Z',
            },
        });
        expect(buildMock).toHaveBeenCalledWith('build-1');
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        // content: [0] data, [1] summary/nextStep; no Console link for an API token session.
        expect(content).toHaveLength(2);
        expect(content[1].text).toContain('Build 0.1.12 of Actor actor-1 is SUCCEEDED.');
    });

    it('adds the build Console link for Console UI token sessions', async () => {
        getMock.mockResolvedValue(mockBuild());
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = (await (getActorBuild as HelperTool).call({
            ...stubToolCallContext({ buildId: 'build-1' }, stubClient),
            apifyToken: 'apify_ui_test',
        })) as TextToolResult;
        const { content, structuredContent } = result;

        const consoleUrl = 'https://console.apify.com/actors/actor-1/builds/build-1';
        expect((structuredContent as { build: { apifyConsoleUrl?: string } }).build.apifyConsoleUrl).toBe(consoleUrl);
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        expectSchemaConformingStructuredContent(result, getActorBuildToolOutputSchema);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        getMock.mockResolvedValue(mockBuild());

        const result = await callTool({ buildId: 'build-1' });

        expect((getActorBuild as HelperTool).outputSchema).toBe(getActorBuildToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorBuildToolOutputSchema);
    });

    it('emits conforming structuredContent while the build is running', async () => {
        getMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

        const result = await callTool({ buildId: 'build-1' });

        expect((result.structuredContent as { build: { finishedAt: unknown } }).build.finishedAt).toBeNull();
        expectSchemaConformingStructuredContent(result, getActorBuildToolOutputSchema);
    });

    it('returns a not-found error when the build does not exist', async () => {
        getMock.mockResolvedValue(undefined);

        const result = await (getActorBuild as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build' }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(buildMock).toHaveBeenCalledWith('missing-build');
        expect(content[0].text).toBe("Build with ID 'missing-build' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('rejects an empty or missing buildId via ajv validation', () => {
        const tool = getActorBuild as HelperTool;
        expect(tool.ajvValidate({ buildId: '' })).toBe(false);
        expect(tool.ajvValidate({})).toBe(false);
        expect(tool.ajvValidate({ buildId: 'build-1' })).toBe(true);
    });

    describe('nextStep', () => {
        it('points a SUCCEEDED build at call-actor when that tool is loaded', async () => {
            getMock.mockResolvedValue(mockBuild());

            const { content } = await callTool({ buildId: 'build-1' }, [HELPER_TOOLS.ACTOR_CALL]);

            expect(content[1].text).toBe(
                `Build 0.1.12 of Actor actor-1 is SUCCEEDED.\nRun the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to 0.1.12.`,
            );
        });

        it('names no tool for a SUCCEEDED build when call-actor is not loaded', async () => {
            getMock.mockResolvedValue(mockBuild());

            const { content } = await callTool({ buildId: 'build-1' }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

            expect(content[1].text).toBe('Build 0.1.12 of Actor actor-1 is SUCCEEDED.\nThe build is ready to run.');
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        });

        it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])(
            'points a %s build at get-actor-log when that tool is loaded',
            async (status) => {
                getMock.mockResolvedValue(mockBuild({ status }));

                const { content } = await callTool({ buildId: 'build-1' }, [HELPER_TOOLS.ACTOR_RUNS_LOG]);

                expect(content[1].text).toBe(
                    `Build 0.1.12 of Actor actor-1 is ${status}.\nRead the build log with ${HELPER_TOOLS.ACTOR_RUNS_LOG} using buildId build-1; pass lines 0 for the whole log.`,
                );
            },
        );

        it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])(
            'names no tool for a %s build when get-actor-log is not loaded',
            async (status) => {
                getMock.mockResolvedValue(mockBuild({ status }));

                const { content } = await callTool({ buildId: 'build-1' }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

                expect(content[1].text).toBe(
                    `Build 0.1.12 of Actor actor-1 is ${status}.\nEnable the runs tool category to read the build log, then fix the source and build again.`,
                );
                expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_RUNS_LOG);
            },
        );

        it('asks for a retry while the build is not terminal', async () => {
            getMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

            const { content } = await callTool({ buildId: 'build-1' });

            expect(content[1].text).toBe(
                'Build 0.1.12 of Actor actor-1 is RUNNING.\nCall this tool again in about 10 seconds.',
            );
        });
    });
});
