import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { WAIT_SECS_MAX } from '../../src/tools/actors/actor_run_response.js';
import { pushActor } from '../../src/tools/deploy/push_actor.js';
import { MULTIFILE_SOURCE_MAX_BYTES } from '../../src/tools/deploy/source_files.js';
import { pushActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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
const ACTOR_CONFIG_MISSING_TEXT = 'The files must include .actor/actor.json; the platform needs it to build the Actor.';

/** An Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor(versionNumbers: string[] = ['0.0']) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        versions: versionNumbers.map((versionNumber) => ({ versionNumber, sourceType: 'SOURCE_FILES' })),
    };
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

function apiError(status: number, message = 'Forbidden'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: 'forbidden', message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext({ actorName: 'my-actor', ...args }, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (pushActor as HelperTool).call(context)) as TextToolResult;
};

/** Calls the tool expecting a soft-fail result and returns its first text block plus the raw result. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await (pushActor as HelperTool).call(
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

describe('push-actor', () => {
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
        expect(pushActor.name).toBe(HELPER_TOOLS.ACTOR_PUSH);
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
        expect(content[1].text).toContain(
            'Pushed 2 files to john/my-actor version 0.0 (created the Actor); the version now has 2 files.',
        );
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
        // The summary separates the files sent from the files the version holds after the merge.
        expect(content[1].text).toContain(
            'Pushed 1 file to john/my-actor version 0.0 (updated the version); the version now has 3 files.',
        );
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
        expect(content[1].text).toContain(
            'Pushed 2 files to john/my-actor version 0.2 (created version 0.2); the version now has 2 files.',
        );
    });

    describe('versionNumber resolution', () => {
        it('pushes to the only version of an existing Actor when versionNumber is omitted', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1']));
            versionGetMock.mockResolvedValue(mockVersion({ versionNumber: '0.1' }));

            const { structuredContent } = await callTool({ files: [MAIN_JS], build: false });

            expect(versionMock).toHaveBeenCalledWith('0.1');
            expect(versionUpdateMock).toHaveBeenCalled();
            expect(versionsCreateMock).not.toHaveBeenCalled();
            expect(structuredContent).toMatchObject({ versionNumber: '0.1' });
        });

        it('asks for versionNumber when the Actor has several versions', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS] });

            expect(text).toBe('Specify versionNumber; this Actor has versions: 0.1, 0.2.');
            expect(versionGetMock).not.toHaveBeenCalled();
            expectNoWrite();
        });

        it('creates version 0.0 when the Actor exists but has no versions and versionNumber is omitted', async () => {
            actorGetMock.mockResolvedValue(mockActor([]));
            versionGetMock.mockResolvedValue(undefined);

            const { structuredContent } = await callTool({ files: [ACTOR_JSON, MAIN_JS], build: false });

            expect(versionsCreateMock).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: '0.0' }));
            expect(structuredContent).toMatchObject({ versionNumber: '0.0' });
        });

        it('pushes to the requested version when the Actor has several', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));
            versionGetMock.mockResolvedValue(mockVersion({ versionNumber: '0.2' }));

            const { structuredContent } = await callTool({ files: [MAIN_JS], versionNumber: '0.2', build: false });

            expect(versionMock).toHaveBeenCalledWith('0.2');
            expect(structuredContent).toMatchObject({ versionNumber: '0.2' });
        });
    });

    describe('actorName', () => {
        it('accepts the username/name form returned as actorName and pushes to the same Actor', async () => {
            const { structuredContent } = await callTool({
                actorName: 'john/my-actor',
                files: [MAIN_JS],
                build: false,
            });

            expect(actorMock).toHaveBeenCalledWith('john/my-actor');
            expect(structuredContent).toMatchObject({ actorName: 'john/my-actor' });
        });

        it('creates the Actor under its bare name when the username/name form is given', async () => {
            actorGetMock.mockResolvedValue(undefined);

            await callTool({ actorName: 'john/my-actor', files: [ACTOR_JSON], build: false });

            expect(actorsCreateMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-actor' }));
        });

        it("refuses a username prefix that is not the caller's", async () => {
            const { text } = await callToolExpectingUserError({ actorName: 'jane/my-actor', files: [MAIN_JS] });

            expect(text).toBe(
                "This tool pushes only to your own account (john); 'jane/my-actor' names another account.",
            );
            expect(actorGetMock).not.toHaveBeenCalled();
            expectNoWrite();
        });
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
                { path: 'src\\.//main.js', content: MAIN_JS.content },
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
        expectSchemaConformingStructuredContent(result, pushActorToolOutputSchema);
    });

    it('forwards waitSecs to the build call', async () => {
        await callTool({ files: [MAIN_JS], waitSecs: 10 });

        expect(buildMock).toHaveBeenCalledWith('0.0', { useCache: true, waitForFinish: 10 });
    });

    it('adds the build Console link for Console UI token sessions', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

        const result = (await (pushActor as HelperTool).call({
            ...stubToolCallContext({ actorName: 'my-actor', files: [MAIN_JS] }, stubClient),
            apifyToken: 'apify_ui_test',
        })) as TextToolResult;
        const { content, structuredContent } = result;

        const consoleUrl = 'https://console.apify.com/actors/actor-1/builds/build-1';
        expect((structuredContent as { build: { apifyConsoleUrl?: string } }).build.apifyConsoleUrl).toBe(consoleUrl);
        expect(content).toHaveLength(3);
        expect(content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        expectSchemaConformingStructuredContent(result, pushActorToolOutputSchema);
    });

    it('emits structuredContent that validates against the outputSchema', async () => {
        buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

        const result = await callTool({ files: [MAIN_JS] });

        expect((pushActor as HelperTool).outputSchema).toBe(pushActorToolOutputSchema);
        expectSchemaConformingStructuredContent(result, pushActorToolOutputSchema);
    });

    describe('build start failure', () => {
        const summary =
            'Pushed 1 file to john/my-actor version 0.0 (updated the version); the version now has 3 files.';

        it('returns the push result in a normal response when the build request fails', async () => {
            buildMock.mockRejectedValue(apiError(500, 'Build quota exceeded'));

            const result = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(result.isError).not.toBe(true);
            expect(versionUpdateMock).toHaveBeenCalled();
            expect(result.structuredContent).toEqual({
                actorId: 'actor-1',
                actorName: 'john/my-actor',
                created: false,
                versionNumber: '0.0',
                buildTag: 'beta',
                filesPushed: 3,
            });
            expectSchemaConformingStructuredContent(result, pushActorToolOutputSchema);
            expect(result.content[1].text).toBe(
                `${summary}\nThe files were pushed, but the build could not be started: Build quota exceeded Retry the build with ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
        });

        it('names no tool in the retry hint when build-actor is not loaded', async () => {
            buildMock.mockRejectedValue(new Error('socket hang up'));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_PUSH]);

            expect(content[1].text).toBe(
                `${summary}\nThe files were pushed, but the build could not be started: socket hang up Retry building this version to make it runnable.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });
    });

    describe('validation', () => {
        it.each(['../etc/passwd', 'src/../../etc/passwd', 'src\\..\\x', 'a/./../b'])(
            'rejects the path %s because it contains a .. segment',
            async (path) => {
                const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON, { path, content: 'x' }] });

                expect(text).toBe(`File path '${path}' must not contain '..' segments.`);
                expectNoWrite();
                expect(userGetMock).not.toHaveBeenCalled();
            },
        );

        it.each(['/abs/file.js', 'C:\\x'])('rejects the absolute path %s', async (path) => {
            const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON, { path, content: 'x' }] });

            expect(text).toBe(`File path '${path}' must be relative to the Actor root, not absolute.`);
            expectNoWrite();
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

        it('rejects base64 content that is not valid base64', async () => {
            const { text } = await callToolExpectingUserError({
                files: [{ path: 'blob.bin', content: 'not base64!', encoding: 'base64' }],
            });

            expect(text).toBe("File 'blob.bin' has encoding base64 but its content is not valid base64.");
            expectNoWrite();
        });

        // The boundary is on decoded bytes, not characters: 'é' is two utf8 bytes.
        it('accepts files whose decoded size is exactly the limit', async () => {
            const content = `${'a'.repeat(MULTIFILE_SOURCE_MAX_BYTES - 2)}é`;
            expect(Buffer.byteLength(content, 'utf8')).toBe(MULTIFILE_SOURCE_MAX_BYTES);

            await callTool({ files: [{ path: 'big.txt', content }], build: false });

            expect(versionUpdateMock).toHaveBeenCalled();
        });

        it('rejects files whose decoded size exceeds the limit by one byte', async () => {
            const content = `${'a'.repeat(MULTIFILE_SOURCE_MAX_BYTES - 1)}é`;
            expect(Buffer.byteLength(content, 'utf8')).toBe(MULTIFILE_SOURCE_MAX_BYTES + 1);

            const { text } = await callToolExpectingUserError({ files: [{ path: 'big.txt', content }] });

            expect(text).toBe(
                `The files total ${MULTIFILE_SOURCE_MAX_BYTES + 1} bytes; the limit is ${MULTIFILE_SOURCE_MAX_BYTES} bytes (3 MiB). Use the Apify CLI (apify push) for larger projects.`,
            );
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

            expect(text).toBe(ACTOR_CONFIG_MISSING_TEXT);
            expectNoWrite();
        });

        it('requires .actor/actor.json in replace mode before any API call', async () => {
            const { text } = await callToolExpectingUserError({ files: [MAIN_JS], mode: 'replace' });

            expect(text).toBe(ACTOR_CONFIG_MISSING_TEXT);
            expectNoWrite();
            expect(userGetMock).not.toHaveBeenCalled();
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('requires .actor/actor.json when merging into a version that lacks it too', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'old' }] }),
            );

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS] });

            expect(text).toBe(ACTOR_CONFIG_MISSING_TEXT);
            expectNoWrite();
        });

        it('lists the existing versions when a merge would create a version without .actor/actor.json', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.0', '0.1']));
            versionGetMock.mockResolvedValue(undefined);

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS], versionNumber: '0.2' });

            expect(text).toBe(
                `Version 0.2 does not exist and would be created (this Actor has versions: 0.0, 0.1). ${ACTOR_CONFIG_MISSING_TEXT}`,
            );
            expectNoWrite();
        });

        // The repo's AJV drops `pattern` (see `src/utils/ajv.ts`), so the regex fields soft-fail in the tool.
        it.each(['my_actor', 'john/my_actor', 'john/jane/my-actor', '-my-actor'])(
            'soft-fails the Actor name %s',
            async (actorName) => {
                const { text } = await callToolExpectingUserError({ actorName, files: [ACTOR_JSON] });

                expect(text).toBe(
                    'actorName: Actor name must be 3 to 63 letters, digits and dashes, cannot start or end with a dash, and may be prefixed with your username and a slash',
                );
                expectNoWrite();
            },
        );

        it('soft-fails a versionNumber that is not MAJOR.MINOR', async () => {
            const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON], versionNumber: '0.1.5' });

            expect(text).toBe('versionNumber: Version number must be MAJOR.MINOR, for example 0.1');
            expectNoWrite();
        });

        it('rejects an empty file list, a short name, an empty buildTag and waitSecs above the cap via ajv validation', () => {
            const tool = pushActor as HelperTool;
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [] })).toBe(false);
            expect(tool.ajvValidate({ actorName: 'ab', files: [MAIN_JS] })).toBe(false);
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [MAIN_JS], buildTag: '' })).toBe(false);
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [MAIN_JS], waitSecs: WAIT_SECS_MAX + 1 })).toBe(
                false,
            );
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [MAIN_JS] })).toBe(true);
        });

        it('requires only actorName and files in the input schema', () => {
            expect((pushActor as HelperTool).inputSchema.required).toEqual(['actorName', 'files']);
        });
    });

    it.each([
        ['user lookup', userGetMock],
        ['Actor lookup', actorGetMock],
        ['version update', versionUpdateMock],
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
        it('names build-actor, call-actor and get-actor-build only when those tools are in the session', () => {
            const tool = pushActor as HelperTool;
            expect(tool.description).toContain(
                `Pass the returned actorId as actor to ${HELPER_TOOLS.ACTOR_BUILD} and ${HELPER_TOOLS.ACTOR_CALL}.`,
            );
            expect(tool.description).toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
            const withoutSiblings = tool.buildDescription?.({ hasTool: () => false });
            expect(withoutSiblings).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
            expect(withoutSiblings).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
            expect(withoutSiblings).not.toContain(HELPER_TOOLS.ACTOR_CALL);
            expect(withoutSiblings).not.toContain('Pass the returned actorId');
        });

        it('names only the loaded actorId taker', () => {
            const onlyCall = (pushActor as HelperTool).buildDescription?.({
                hasTool: (name) => name === HELPER_TOOLS.ACTOR_CALL,
            });
            expect(onlyCall).toContain(`Pass the returned actorId as actor to ${HELPER_TOOLS.ACTOR_CALL}.`);
            expect(onlyCall).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });
    });

    describe('nextStep', () => {
        const summary =
            'Pushed 1 file to john/my-actor version 0.0 (updated the version); the version now has 3 files.';

        it('points at build-actor when the build was skipped and that tool is loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS], build: false }, [HELPER_TOOLS.ACTOR_BUILD]);

            expect(content[1].text).toBe(
                `${summary}\nTrigger a build with ${HELPER_TOOLS.ACTOR_BUILD} to make this version runnable.`,
            );
        });

        it('names no tool when the build was skipped and build-actor is not loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS], build: false }, [HELPER_TOOLS.ACTOR_PUSH]);

            expect(content[1].text).toBe(`${summary}\nBuild this version to make it runnable.`);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });

        it('points a SUCCEEDED build at call-actor with the build number when that tool is loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_CALL]);

            expect(content[1].text).toBe(
                `${summary}\nRun the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to 0.0.3.`,
            );
        });

        it('names no tool for a SUCCEEDED build when call-actor is not loaded', async () => {
            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_PUSH]);

            expect(content[1].text).toBe(`${summary}\nThe build is ready to run.`);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_CALL);
        });

        it('points a FAILED build at get-actor-build-log when that tool is loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'FAILED' }));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_BUILD_LOG]);

            expect(content[1].text).toBe(
                `${summary}\nRead the build log with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId build-1; pass lines 0 for the whole log.`,
            );
        });

        it('names no tool for a FAILED build when get-actor-build-log is not loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'FAILED' }));

            // get-actor-build is loaded but is not the log tool; the hint must not fall back to it.
            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

            expect(content[1].text).toBe(
                `${summary}\nRead the build log for the error, fix the source, and build again.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD_LOG);
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });

        it('points a still-running build at get-actor-build when that tool is loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_BUILD_GET]);

            expect(content[1].text).toBe(
                `${summary}\nCheck progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId build-1 (it waits up to ${WAIT_SECS_MAX} seconds per call).`,
            );
        });

        it('names no tool for a still-running build when get-actor-build is not loaded', async () => {
            buildMock.mockResolvedValue(mockBuild({ status: 'RUNNING', finishedAt: undefined }));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_PUSH]);

            expect(content[1].text).toBe(
                `${summary}\nThe build is still running; check its status again in a few seconds.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD_GET);
        });
    });
});
