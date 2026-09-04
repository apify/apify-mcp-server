import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { WAIT_SECS_MAX } from '../../src/tools/actors/actor_run_response.js';
import { pushActorSource } from '../../src/tools/deploy/push_actor_source.js';
import { MULTIFILE_SOURCE_MAX_BYTES } from '../../src/tools/deploy/source_files.js';
import { pushActorSourceToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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

const userGetMock = vi.fn();
const actorGetMock = vi.fn();
const versionGetMock = vi.fn();
const versionUpdateMock = vi.fn();
const versionsCreateMock = vi.fn();
const actorsCreateMock = vi.fn();
const buildMock = vi.fn();
const versionMock = vi.fn(() => ({ get: versionGetMock, update: versionUpdateMock }));
const actorMock = vi.fn(() => ({
    get: actorGetMock,
    version: versionMock,
    versions: () => ({ create: versionsCreateMock }),
    build: buildMock,
}));

const stubClient = {
    user: () => ({ get: userGetMock }),
    actor: actorMock,
    actors: () => ({ create: actorsCreateMock }),
} as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON = { path: '.actor/actor.json', content: '{"actorSpecification": 1, "name": "my-actor"}' };
const MAIN_JS = { path: 'src/main.js', content: 'console.log("hi");' };
const ACTOR_JSON_SOURCE = { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content };
const MAIN_JS_SOURCE = { name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content };

/** An Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor() {
    return { id: 'actor-1', userId: 'user-secret', name: 'my-actor', username: 'john', versions: [] };
}

/** An existing SOURCE_FILES version with a file the pushed set overwrites and one it does not. */
function mockVersion(overrides: Record<string, unknown> = {}) {
    return {
        versionNumber: '0.0',
        buildTag: 'beta',
        sourceType: 'SOURCE_FILES',
        envVars: [{ name: 'SECRET', value: 'x', isSecret: true }],
        sourceFiles: [
            ACTOR_JSON_SOURCE,
            { name: 'src/main.js', format: 'TEXT', content: 'old' },
            { name: 'README.md', format: 'TEXT', content: '# Old' },
        ],
        ...overrides,
    };
}

/** A build API document with internal fields that the tool must not leak. */
function mockBuild(overrides: Record<string, unknown> = {}) {
    return {
        id: 'build-1',
        actId: 'actor-1',
        userId: 'user-secret',
        buildNumber: '0.0.3',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-09-01T10:00:00.000Z'),
        finishedAt: new Date('2026-09-01T10:01:00.000Z'),
        meta: { origin: 'API' },
        ...overrides,
    };
}

function apiError(status: number): ApifyApiError {
    return new ApifyApiError(
        { data: { error: { type: 'forbidden', message: 'Forbidden' } }, status } as AxiosResponse,
        1,
    );
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext({ actorName: 'my-actor', ...args }, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (pushActorSource as HelperTool).call(context)) as TextToolResult;
};

/** Calls the tool expecting a soft-fail result and returns its first text block plus the raw result. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await (pushActorSource as HelperTool).call(
        stubToolCallContext({ actorName: 'my-actor', ...args }, stubClient),
    );
    expectSoftFailInvalidInput(result);
    const { content, structuredContent } = result as TextToolResult & { structuredContent?: unknown };
    return { text: content[0].text, structuredContent };
};

const expectNoWrite = () => {
    expect(actorsCreateMock).not.toHaveBeenCalled();
    expect(versionUpdateMock).not.toHaveBeenCalled();
    expect(versionsCreateMock).not.toHaveBeenCalled();
    expect(buildMock).not.toHaveBeenCalled();
};

describe('push-actor-source', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userGetMock.mockResolvedValue({ username: 'john', id: 'user-secret' });
        actorGetMock.mockResolvedValue(mockActor());
        versionGetMock.mockResolvedValue(mockVersion());
        versionUpdateMock.mockResolvedValue(mockVersion());
        versionsCreateMock.mockResolvedValue(mockVersion());
        actorsCreateMock.mockResolvedValue({ ...mockActor(), id: 'actor-new' });
        buildMock.mockResolvedValue(mockBuild());
    });

    it('has the expected tool name', () => {
        expect(pushActorSource.name).toBe(HELPER_TOOLS.ACTOR_SOURCE_PUSH);
    });

    it('creates the Actor with the files inline when it does not exist, then builds it', async () => {
        actorGetMock.mockResolvedValue(undefined);
        buildMock.mockResolvedValue(mockBuild({ actId: 'actor-new' }));

        const { content, structuredContent } = await callTool({ files: [ACTOR_JSON, MAIN_JS] });

        expect(actorMock).toHaveBeenCalledWith('john/my-actor');
        expect(actorsCreateMock).toHaveBeenCalledWith({
            name: 'my-actor',
            versions: [
                {
                    versionNumber: '0.0',
                    buildTag: 'latest',
                    sourceType: 'SOURCE_FILES',
                    sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE],
                },
            ],
        });
        expect(versionUpdateMock).not.toHaveBeenCalled();
        expect(versionsCreateMock).not.toHaveBeenCalled();
        // The build uses the created Actor's ID and no tag: the version's buildTag applies.
        expect(actorMock).toHaveBeenCalledWith('actor-new');
        expect(buildMock).toHaveBeenCalledWith('0.0', { useCache: true, waitForFinish: WAIT_SECS_MAX });
        expect(structuredContent).toEqual({
            actorId: 'actor-new',
            actorName: 'john/my-actor',
            created: true,
            versionNumber: '0.0',
            buildTag: 'latest',
            filesPushed: 2,
            build: {
                id: 'build-1',
                actorId: 'actor-new',
                buildNumber: '0.0.3',
                status: 'SUCCEEDED',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: '2026-09-01T10:01:00.000Z',
            },
        });
        expect(JSON.parse(content[0].text)).toEqual(structuredContent);
        expect(content).toHaveLength(2);
        expect(content[1].text).toContain('Pushed 2 files to john/my-actor version 0.0 (created the Actor).');
        expect(JSON.stringify(structuredContent)).not.toContain('user-secret');
    });

    it('merges into an existing version by default, keeping unlisted files and overwriting same-name ones', async () => {
        const newMain = { path: 'src/main.js', content: 'new' };

        const { content, structuredContent } = await callTool({ files: [newMain], build: false });

        expect(versionMock).toHaveBeenCalledWith('0.0');
        // Existing files first, in their order, then the pushed ones; no envVars so the version keeps its own.
        expect(versionUpdateMock).toHaveBeenCalledWith({
            sourceType: 'SOURCE_FILES',
            sourceFiles: [
                ACTOR_JSON_SOURCE,
                { name: 'README.md', format: 'TEXT', content: '# Old' },
                { name: 'src/main.js', format: 'TEXT', content: 'new' },
            ],
        });
        expect(actorsCreateMock).not.toHaveBeenCalled();
        expect(versionsCreateMock).not.toHaveBeenCalled();
        expect(structuredContent).toEqual({
            actorId: 'actor-1',
            actorName: 'john/my-actor',
            created: false,
            versionNumber: '0.0',
            buildTag: 'beta',
            filesPushed: 3,
        });
        expect(content[1].text).toContain('Pushed 3 files to john/my-actor version 0.0 (updated the version).');
    });

    it('replaces the version files in replace mode and forwards the build tag', async () => {
        const { structuredContent } = await callTool({
            files: [ACTOR_JSON, MAIN_JS],
            mode: 'replace',
            buildTag: 'latest',
            build: false,
        });

        expect(versionUpdateMock).toHaveBeenCalledWith({
            sourceType: 'SOURCE_FILES',
            sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE],
            buildTag: 'latest',
        });
        expect(structuredContent).toMatchObject({ buildTag: 'latest', filesPushed: 2 });
    });

    it('creates the version when the Actor exists but the version does not', async () => {
        versionGetMock.mockResolvedValue(undefined);

        const { content, structuredContent } = await callTool({
            files: [ACTOR_JSON, MAIN_JS],
            versionNumber: '0.2',
            build: false,
        });

        expect(versionMock).toHaveBeenCalledWith('0.2');
        expect(versionsCreateMock).toHaveBeenCalledWith({
            versionNumber: '0.2',
            buildTag: 'latest',
            sourceType: 'SOURCE_FILES',
            sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE],
        });
        expect(versionUpdateMock).not.toHaveBeenCalled();
        expect(actorsCreateMock).not.toHaveBeenCalled();
        expect(structuredContent).toMatchObject({
            actorId: 'actor-1',
            created: false,
            versionNumber: '0.2',
            buildTag: 'latest',
            filesPushed: 2,
        });
        expect(content[1].text).toContain('Pushed 2 files to john/my-actor version 0.2 (created the version).');
    });

    it('refuses to merge onto a version that does not use source files', async () => {
        versionGetMock.mockResolvedValue(
            mockVersion({ sourceType: 'GIT_REPO', sourceFiles: undefined, gitRepoUrl: 'https://github.com/x/y' }),
        );

        const { text } = await callToolExpectingUserError({ files: [MAIN_JS] });

        expect(text).toBe(
            "Version 0.0 uses source type GIT_REPO; use mode 'replace' to overwrite it with source files.",
        );
        expectNoWrite();
    });

    it('overwrites a version that does not use source files in replace mode', async () => {
        versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', sourceFiles: undefined }));

        await callTool({ files: [ACTOR_JSON, MAIN_JS], mode: 'replace', build: false });

        expect(versionUpdateMock).toHaveBeenCalledWith({
            sourceType: 'SOURCE_FILES',
            sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE],
        });
    });

    it('normalizes paths to POSIX paths relative to the Actor root', async () => {
        await callTool({
            files: [
                { path: './.actor/actor.json', content: ACTOR_JSON.content },
                { path: '/src\\.//main.js', content: MAIN_JS.content },
            ],
            mode: 'replace',
            build: false,
        });

        expect(versionUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({ sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE] }),
        );
    });

    it('maps a base64 file to the BASE64 format', async () => {
        const png = { path: 'assets/logo.png', content: Buffer.from('binary').toString('base64'), encoding: 'base64' };

        await callTool({ files: [png], build: false });

        expect(versionUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceFiles: expect.arrayContaining([
                    { name: 'assets/logo.png', format: 'BASE64', content: png.content },
                ]),
            }),
        );
    });

    it('skips the build when build is false', async () => {
        const result = await callTool({ files: [MAIN_JS], build: false });

        expect(buildMock).not.toHaveBeenCalled();
        expect(result.structuredContent).not.toHaveProperty('build');
        expectSchemaConformingStructuredContent(result, pushActorSourceToolOutputSchema);
    });

    it('forwards waitSecs to the build call', async () => {
        await callTool({ files: [MAIN_JS], waitSecs: 10 });

        expect(buildMock).toHaveBeenCalledWith('0.0', { useCache: true, waitForFinish: 10 });
    });

    it('adds the build Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = (await (pushActorSource as HelperTool).call({
            ...stubToolCallContext({ actorName: 'my-actor', files: [MAIN_JS] }, stubClient),
            apifyToken: 'apify_ui_test',
        })) as TextToolResult;
        const { content, structuredContent } = result;

        const consoleUrl = 'https://console.apify.com/actors/actor-1/builds/build-1';
        expect((structuredContent as { build: { apifyConsoleUrl?: string } }).build.apifyConsoleUrl).toBe(consoleUrl);
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        expectSchemaConformingStructuredContent(result, pushActorSourceToolOutputSchema);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

        const result = await callTool({ files: [MAIN_JS] });

        expect((pushActorSource as HelperTool).outputSchema).toBe(pushActorSourceToolOutputSchema);
        expectSchemaConformingStructuredContent(result, pushActorSourceToolOutputSchema);
    });

    describe('validation', () => {
        it('rejects a path with a .. segment', async () => {
            const { text } = await callToolExpectingUserError({
                files: [ACTOR_JSON, { path: '../etc/passwd', content: 'x' }],
            });

            expect(text).toBe("File path '../etc/passwd' must not contain '..' segments.");
            expectNoWrite();
            expect(userGetMock).not.toHaveBeenCalled();
        });

        it('rejects a path that is empty after normalization', async () => {
            const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON, { path: './', content: 'x' }] });

            expect(text).toBe("File path './' is empty after normalization.");
            expectNoWrite();
        });

        it('rejects a path that names a directory', async () => {
            const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON, { path: 'src/', content: 'x' }] });

            expect(text).toBe("File path 'src/' must name a file, not a directory.");
            expectNoWrite();
        });

        it('rejects duplicate paths after normalization', async () => {
            const { text } = await callToolExpectingUserError({
                files: [ACTOR_JSON, MAIN_JS, { path: 'src/./main.js', content: 'again' }],
            });

            expect(text).toBe("File path 'src/main.js' is listed more than once.");
            expectNoWrite();
        });

        it('rejects files whose decoded size exceeds 3 MiB', async () => {
            const { text } = await callToolExpectingUserError({
                files: [ACTOR_JSON, { path: 'big.txt', content: 'a'.repeat(MULTIFILE_SOURCE_MAX_BYTES) }],
            });

            expect(text).toContain(`the limit is ${MULTIFILE_SOURCE_MAX_BYTES} bytes (3 MiB)`);
            expect(text).toContain('Use the Apify CLI (apify push) for larger projects.');
            expectNoWrite();
        });

        it('counts the decoded length of base64 files toward the limit', async () => {
            const content = Buffer.alloc(MULTIFILE_SOURCE_MAX_BYTES).toString('base64');

            await callTool({ files: [{ path: 'blob.bin', content, encoding: 'base64' }], build: false });

            expect(versionUpdateMock).toHaveBeenCalled();
        });

        it('requires .actor/actor.json when creating the Actor', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS] });

            expect(text).toBe('The files must include .actor/actor.json; the platform needs it to build the Actor.');
            expectNoWrite();
        });

        it('requires .actor/actor.json in replace mode before any API call', async () => {
            const { text } = await callToolExpectingUserError({ files: [MAIN_JS], mode: 'replace' });

            expect(text).toBe('The files must include .actor/actor.json; the platform needs it to build the Actor.');
            expectNoWrite();
            expect(userGetMock).not.toHaveBeenCalled();
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('requires .actor/actor.json when creating a version', async () => {
            versionGetMock.mockResolvedValue(undefined);

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS], versionNumber: '0.2' });

            expect(text).toBe('The files must include .actor/actor.json; the platform needs it to build the Actor.');
            expectNoWrite();
        });

        // The repo's AJV drops `pattern` (see `src/utils/ajv.ts`), so the regex fields soft-fail in the tool.
        it('soft-fails an Actor name that is not DNS-safe', async () => {
            const { text } = await callToolExpectingUserError({ actorName: 'my_actor', files: [ACTOR_JSON] });

            expect(text).toBe(
                'actorName: Actor name may contain only letters, digits and dashes, and cannot start or end with a dash',
            );
            expectNoWrite();
        });

        it('soft-fails a versionNumber that is not MAJOR.MINOR', async () => {
            const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON], versionNumber: '0.1.5' });

            expect(text).toBe('versionNumber: Version number must be MAJOR.MINOR, for example 0.1');
            expectNoWrite();
        });

        it('rejects an empty file list, a short name and waitSecs above the cap via ajv validation', () => {
            const tool = pushActorSource as HelperTool;
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [] })).toBe(false);
            expect(tool.ajvValidate({ actorName: 'ab', files: [MAIN_JS] })).toBe(false);
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [MAIN_JS], waitSecs: WAIT_SECS_MAX + 1 })).toBe(
                false,
            );
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [MAIN_JS] })).toBe(true);
        });

        it('marks the fields with defaults optional in the input schema', () => {
            expect((pushActorSource as HelperTool).inputSchema.required).toEqual(['actorName', 'files']);
        });
    });

    it.each([
        ['version update', versionUpdateMock],
        ['Actor lookup', actorGetMock],
    ])('maps a 403 from the %s to a permission error', async (_label, mock) => {
        mock.mockRejectedValue(apiError(403));

        const result = await callTool({ files: [MAIN_JS] });

        expect(result.isError).toBe(true);
        expect(result.toolTelemetry).toEqual(
            expect.objectContaining({
                toolStatus: TOOL_STATUS.SOFT_FAIL,
                failureCategory: FAILURE_CATEGORY.AUTH,
                failureHttpStatus: 403,
            }),
        );
        expect(result.content[0].text).toBe(
            'The token is not allowed to read or modify Actors in this account; scoped tokens cannot. Use a token with full Actor access.',
        );
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('rethrows other API errors', async () => {
        versionUpdateMock.mockRejectedValue(apiError(500));

        await expect(callTool({ files: [MAIN_JS] })).rejects.toBeInstanceOf(ApifyApiError);
    });

    describe('description', () => {
        it('names build-actor and get-actor-build only when those tools are in the session', () => {
            const tool = pushActorSource as HelperTool;
            expect(tool.description).toContain(HELPER_TOOLS.ACTOR_BUILD);
            expect(tool.description).toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
            const withoutSiblings = tool.buildDescription?.({ hasTool: () => false });
            expect(withoutSiblings).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
            expect(withoutSiblings).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });
    });

    describe('nextStep', () => {
        const summary = 'Pushed 3 files to john/my-actor version 0.0 (updated the version).';

        it('points at build-actor when the build was skipped and that tool is loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS], build: false }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(content[1].text).toBe(
                `${summary}\nTrigger a build with ${HELPER_TOOLS.ACTOR_BUILD} to make this version runnable.`,
            );
        });

        it('names no tool when the build was skipped and build-actor is not loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS], build: false }, [HELPER_TOOLS.ACTOR_SOURCE_PUSH]);

            expect(content[1].text).toBe(`${summary}\nBuild this version to make it runnable.`);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });

        it("points a SUCCEEDED build at call-actor with the version's build tag when that tool is loaded", async () => {
            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_CALL]);

            expect(content[1].text).toBe(
                `${summary}\nRun the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to beta.`,
            );
        });

        it('names no tool for a SUCCEEDED build when call-actor is not loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_SOURCE_PUSH]);

            expect(content[1].text).toBe(`${summary}\nThe build is ready to run.`);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        });

        it('points a FAILED build at get-actor-build for the log when that tool is loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'FAILED' }));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

            expect(content[1].text).toBe(
                `${summary}\nFetch the build log with ${HELPER_TOOLS.ACTOR_BUILD_GET} (buildId build-1, lines 50) to see the error.`,
            );
        });

        it('names no tool for a still-running build when get-actor-build is not loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_SOURCE_PUSH]);

            expect(content[1].text).toBe(
                `${summary}\nThe build is still running; check its status again in a few seconds.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });
    });
});
