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
const logGetMock = vi.fn();
const buildMock = vi.fn(() => ({ get: getMock, log: () => ({ get: logGetMock }) }));

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

const numberedLog = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext(args, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (getActorBuild as HelperTool).call(context)) as TextToolResult;
};

describe('get-actor-build', () => {
    it('has the expected tool name', () => {
        expect(getActorBuild.name).toBe(HELPER_TOOLS.ACTOR_BUILD_GET);
    });

    it('returns the allowlisted build fields and the requested number of trailing log lines', async () => {
        getMock.mockResolvedValue(mockBuild());
        logGetMock.mockResolvedValue(`${numberedLog(20)}\n`);

        const { content, structuredContent } = await callTool({ buildId: 'build-1', lines: 3 });

        expect(structuredContent).toEqual({
            build: {
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.1.12',
                status: 'SUCCEEDED',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: '2026-09-01T10:01:00.000Z',
            },
            logTail: ['line 18', 'line 19', 'line 20'],
        });
        expect(buildMock).toHaveBeenCalledWith('build-1');
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        // content: [0] data, [1] summary/nextStep; no Console link for an API token session.
        expect(content).toHaveLength(2);
        expect(content[1].text).toContain('Build 0.1.12 of Actor actor-1 is SUCCEEDED.');
    });

    it('adds the build Console link for Console UI token sessions', async () => {
        getMock.mockResolvedValue(mockBuild());
        logGetMock.mockResolvedValue('');
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = (await (getActorBuild as HelperTool).call({
            ...stubToolCallContext({ buildId: 'build-1', lines: 0 }, stubClient),
            apifyToken: 'apify_ui_test',
        })) as TextToolResult;
        const { content, structuredContent } = result;

        const consoleUrl = 'https://console.apify.com/actors/actor-1/builds/build-1';
        expect((structuredContent as { build: { apifyConsoleUrl?: string } }).build.apifyConsoleUrl).toBe(consoleUrl);
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        expectSchemaConformingStructuredContent(result, getActorBuildToolOutputSchema);
    });

    it('returns the default 20 trailing lines when lines is omitted', async () => {
        getMock.mockResolvedValue(mockBuild());
        logGetMock.mockResolvedValue(numberedLog(50));

        const { structuredContent } = await callTool({ buildId: 'build-1' });

        expect((structuredContent as { logTail: string[] }).logTail).toHaveLength(20);
    });

    it('returns the entire log when lines is 0', async () => {
        getMock.mockResolvedValue(mockBuild());
        logGetMock.mockClear();
        logGetMock.mockResolvedValue(numberedLog(50));

        const { structuredContent } = await callTool({ buildId: 'build-1', lines: 0 });

        const { logTail } = structuredContent as { logTail: string[] };
        expect(logGetMock).toHaveBeenCalledTimes(1);
        expect(logTail).toHaveLength(50);
        expect(logTail[0]).toBe('line 1');
        expect(logTail[49]).toBe('line 50');
    });

    it('returns an empty log tail when the log is missing', async () => {
        getMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));
        logGetMock.mockResolvedValue(undefined);

        const result = await callTool({ buildId: 'build-1', lines: 5 });

        expect((result.structuredContent as { logTail: string[] }).logTail).toEqual([]);
        expectSchemaConformingStructuredContent(result, getActorBuildToolOutputSchema);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        getMock.mockResolvedValue(mockBuild());
        logGetMock.mockResolvedValue(numberedLog(5));

        const result = await callTool({ buildId: 'build-1', lines: 5 });

        expect((getActorBuild as HelperTool).outputSchema).toBe(getActorBuildToolOutputSchema);
        expectSchemaConformingStructuredContent(result, getActorBuildToolOutputSchema);
    });

    it('returns a not-found error when the build does not exist', async () => {
        getMock.mockResolvedValue(undefined);

        const result = await (getActorBuild as HelperTool).call(
            stubToolCallContext({ buildId: 'missing-build', lines: 5 }, stubClient),
        );
        const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };

        expectSoftFailInvalidInput(result);
        expect(buildMock).toHaveBeenCalledWith('missing-build');
        expect(content[0].text).toBe("Build with ID 'missing-build' not found.");
        expect(structuredContent).toBeUndefined();
    });

    it('rejects lines above 50 and an empty buildId via ajv validation', () => {
        const tool = getActorBuild as HelperTool;
        expect(tool.ajvValidate({ buildId: 'build-1', lines: 51 })).toBe(false);
        expect(tool.ajvValidate({ buildId: '', lines: 5 })).toBe(false);
        expect(tool.ajvValidate({ buildId: 'build-1' })).toBe(true);
    });

    describe('nextStep', () => {
        it('points a SUCCEEDED build at call-actor when that tool is loaded', async () => {
            getMock.mockResolvedValue(mockBuild());
            logGetMock.mockResolvedValue('');

            const { content } = await callTool({ buildId: 'build-1' }, [HELPER_TOOLS.ACTOR_CALL]);

            expect(content[1].text).toBe(
                `Build 0.1.12 of Actor actor-1 is SUCCEEDED.\nRun the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to 0.1.12.`,
            );
        });

        it('names no tool for a SUCCEEDED build when call-actor is not loaded', async () => {
            getMock.mockResolvedValue(mockBuild());
            logGetMock.mockResolvedValue('');

            const { content } = await callTool({ buildId: 'build-1' }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

            expect(content[1].text).toBe('Build 0.1.12 of Actor actor-1 is SUCCEEDED.\nThe build is ready to run.');
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        });

        it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])(
            'tells the model to read the log for a %s build',
            async (status) => {
                getMock.mockResolvedValue(mockBuild({ status }));
                logGetMock.mockResolvedValue('Error: build failed\n');

                const { content } = await callTool({ buildId: 'build-1' });

                expect(content[1].text).toBe(
                    `Build 0.1.12 of Actor actor-1 is ${status}.\nRead the log tail for the error, fix the source, and build again.`,
                );
            },
        );

        it('asks for a retry while the build is not terminal', async () => {
            getMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));
            logGetMock.mockResolvedValue('');

            const { content } = await callTool({ buildId: 'build-1' });

            expect(content[1].text).toBe(
                'Build 0.1.12 of Actor actor-1 is RUNNING.\nCall this tool again in about 10 seconds.',
            );
        });
    });
});
