import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { WAIT_SECS_MAX } from '../../src/tools/actors/actor_run_response.js';
import { buildActor } from '../../src/tools/deploy/build_actor.js';
import { buildActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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
const buildMock = vi.fn();
const actorMock = vi.fn(() => ({ get: getMock, build: buildMock }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

/** An Actor API document; `versions` carries the internal fields the tool must ignore. */
function mockActor(versionNumbers: string[] = ['0.1']) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        versions: versionNumbers.map((versionNumber) => ({
            versionNumber,
            sourceType: 'SOURCE_FILES',
            buildTag: 'latest',
        })),
    };
}

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
    return (await (buildActor as HelperTool).call(context)) as TextToolResult;
};

/** Calls the tool expecting a soft-fail result and returns its first text block plus the raw result. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await (buildActor as HelperTool).call(stubToolCallContext(args, stubClient));
    expectSoftFailInvalidInput(result);
    const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };
    return { text: content[0].text, structuredContent };
};

describe('build-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getMock.mockResolvedValue(mockActor());
        buildMock.mockResolvedValue(mockBuild());
    });

    it('has the expected tool name', () => {
        expect(buildActor.name).toBe(HELPER_TOOLS.ACTOR_BUILD);
    });

    it('builds the only version when versionNumber is omitted and returns the allowlisted build fields', async () => {
        const { content, structuredContent } = await callTool({ actor: 'john/my-actor' });

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        // The build call uses the resolved Actor ID, not the user-supplied selector.
        expect(actorMock).toHaveBeenCalledWith('actor-1');
        expect(buildMock).toHaveBeenCalledWith('0.1', { useCache: true, waitForFinish: WAIT_SECS_MAX });
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
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        // content: [0] data, [1] summary/nextStep; no Console link for an API token session.
        expect(content).toHaveLength(2);
        expect(content[1].text).toContain('Started build 0.1.12 of Actor actor-1 (version 0.1); status SUCCEEDED.');
    });

    it('builds the requested version when it exists', async () => {
        getMock.mockResolvedValue(mockActor(['0.1', '0.2']));

        const { content } = await callTool({ actor: 'actor-1', versionNumber: '0.2' });

        expect(buildMock).toHaveBeenCalledWith('0.2', expect.anything());
        expect(content[1].text).toContain('(version 0.2)');
    });

    it('forwards tag, useCache and waitSecs to the build call', async () => {
        await callTool({ actor: 'actor-1', tag: 'beta', useCache: false, waitSecs: 10 });

        expect(buildMock).toHaveBeenCalledWith('0.1', { tag: 'beta', useCache: false, waitForFinish: 10 });
    });

    it('adds the build Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = (await (buildActor as HelperTool).call({
            ...stubToolCallContext({ actor: 'actor-1' }, stubClient),
            apifyToken: 'apify_ui_test',
        })) as TextToolResult;
        const { content, structuredContent } = result;

        const consoleUrl = 'https://console.apify.com/actors/actor-1/builds/build-1';
        expect((structuredContent as { build: { apifyConsoleUrl?: string } }).build.apifyConsoleUrl).toBe(consoleUrl);
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        expectSchemaConformingStructuredContent(result, buildActorToolOutputSchema);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

        const result = await callTool({ actor: 'actor-1' });

        expect((buildActor as HelperTool).outputSchema).toBe(buildActorToolOutputSchema);
        expectSchemaConformingStructuredContent(result, buildActorToolOutputSchema);
    });

    it('returns a not-found error when the Actor does not exist', async () => {
        getMock.mockResolvedValue(undefined);

        const { text, structuredContent } = await callToolExpectingUserError({ actor: 'john/missing' });

        expect(text).toBe("Actor 'john/missing' not found.");
        expect(structuredContent).toBeUndefined();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('returns an error when the Actor has no versions', async () => {
        getMock.mockResolvedValue(mockActor([]));

        const { text } = await callToolExpectingUserError({ actor: 'actor-1' });

        expect(text).toBe("Actor 'actor-1' has no versions to build.");
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('asks for versionNumber when the Actor has several versions', async () => {
        getMock.mockResolvedValue(mockActor(['0.1', '0.2']));

        const { text } = await callToolExpectingUserError({ actor: 'actor-1' });

        expect(text).toBe('Specify versionNumber; this Actor has versions: 0.1, 0.2.');
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('lists the available versions when the requested one does not exist', async () => {
        getMock.mockResolvedValue(mockActor(['0.1', '0.2']));

        const { text } = await callToolExpectingUserError({ actor: 'actor-1', versionNumber: '1.0' });

        expect(text).toBe("Actor 'actor-1' has no version 1.0; available versions: 0.1, 0.2.");
        expect(buildMock).not.toHaveBeenCalled();
    });

    // A build number or tag is not a version; the lookup against the Actor's versions soft-fails it
    // instead of a regex, because the repo's AJV drops `pattern` (see `src/utils/ajv.ts`).
    it.each(['0.1.5', 'latest'])(
        'soft-fails versionNumber %s because it is not a MAJOR.MINOR version',
        async (versionNumber) => {
            const { text } = await callToolExpectingUserError({ actor: 'actor-1', versionNumber });

            expect(text).toBe(`Actor 'actor-1' has no version ${versionNumber}; available versions: 0.1.`);
            expect(buildMock).not.toHaveBeenCalled();
        },
    );

    it('rejects waitSecs above the cap and an empty actor via ajv validation', () => {
        const tool = buildActor as HelperTool;
        expect(tool.ajvValidate({ actor: 'actor-1', waitSecs: WAIT_SECS_MAX + 1 })).toBe(false);
        expect(tool.ajvValidate({ actor: '' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'actor-1' })).toBe(true);
    });

    it('marks useCache and waitSecs optional in the input schema because they have defaults', () => {
        expect((buildActor as HelperTool).inputSchema.required).toEqual(['actor']);
    });

    describe('description', () => {
        it('names get-actor-build only when that tool is in the session', () => {
            const tool = buildActor as HelperTool;
            expect(tool.description).toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
            expect(tool.buildDescription?.({ hasTool: () => false })).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });
    });

    describe('nextStep', () => {
        const summary = 'Started build 0.1.12 of Actor actor-1 (version 0.1); status';

        it('points a SUCCEEDED build at call-actor with the build number when that tool is loaded', async () => {
            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_CALL]);

            expect(content[1].text).toBe(
                `${summary} SUCCEEDED.\nRun the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to 0.1.12.`,
            );
        });

        it('points a SUCCEEDED build at call-actor with the tag when one was assigned', async () => {
            const { content } = await callTool({ actor: 'actor-1', tag: 'latest' }, [HELPER_TOOLS.ACTOR_CALL]);

            expect(content[1].text).toContain('set callOptions.build to latest.');
        });

        it('names no tool for a SUCCEEDED build when call-actor is not loaded', async () => {
            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(content[1].text).toBe(`${summary} SUCCEEDED.\nThe build is ready to run.`);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        });

        it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])(
            'points a %s build at get-actor-build for the log when that tool is loaded',
            async (status) => {
                buildMock.mockResolvedValue(mockBuild({ status }));

                const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

                expect(content[1].text).toBe(
                    `${summary} ${status}.\nFetch the build log with ${HELPER_TOOLS.ACTOR_BUILD_GET} (buildId build-1, lines 50) to see the error.`,
                );
            },
        );

        it('names no tool for a FAILED build when get-actor-build is not loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'FAILED' }));

            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(content[1].text).toBe(
                `${summary} FAILED.\nInspect the build log for the error, fix the source, and build again.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });

        it('points a still-running build at get-actor-build when that tool is loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

            expect(content[1].text).toBe(
                `${summary} RUNNING.\nCheck progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId build-1.`,
            );
        });

        it('names no tool for a still-running build when get-actor-build is not loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

            const { content } = await callTool({ actor: 'actor-1' }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(content[1].text).toBe(
                `${summary} RUNNING.\nThe build is still running; check its status again in a few seconds.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });
    });
});
