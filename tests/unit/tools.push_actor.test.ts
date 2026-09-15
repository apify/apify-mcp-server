import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_MULTIFILE_BYTES } from '@apify/consts';
import { createHmacSignatureAsync } from '@apify/utilities';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { WAIT_SECS_MAX } from '../../src/tools/actors/actor_run_response.js';
import { pushActor } from '../../src/tools/deploy/push_actor.js';
import { ACTOR_CONFIG_PATH } from '../../src/tools/deploy/source_files.js';
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
const storesGetOrCreateMock = vi.fn();
const setRecordMock = vi.fn();
const keyValueStoreMock = vi.fn(() => ({ setRecord: setRecordMock }));
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
    keyValueStores: () => ({ getOrCreate: storesGetOrCreateMock }),
    keyValueStore: keyValueStoreMock,
    baseUrl: 'https://api.apify.com/v2',
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
    expect(storesGetOrCreateMock).not.toHaveBeenCalled();
    expect(setRecordMock).not.toHaveBeenCalled();
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
        storesGetOrCreateMock.mockResolvedValue({ id: 'store-1', name: 'actor-actor-1-source' });
        setRecordMock.mockResolvedValue(undefined);
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
            sourceType: 'SOURCE_FILES',
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
            sourceType: 'SOURCE_FILES',
        });
        // The summary separates the files sent from the files the version holds after the merge.
        expect(content[1].text).toContain(
            'Pushed 1 file to john/my-actor version 0.0 (updated the version); the version now has 3 files.',
        );
    });

    it('creates the Actor at the requested version with the given build tag', async () => {
        actorGetMock.mockResolvedValue(undefined);

        const { structuredContent } = await callTool({
            files: [ACTOR_JSON, MAIN_JS],
            versionNumber: '1.0',
            buildTag: 'beta',
            build: false,
        });

        expect(actorsCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                versions: [expect.objectContaining({ versionNumber: '1.0', buildTag: 'beta' })],
            }),
        );
        expect(structuredContent).toMatchObject({ versionNumber: '1.0', buildTag: 'beta', created: true });
    });

    it('replaces the version files in replace mode and forwards the build tag', async () => {
        const { structuredContent } = await callTool({
            files: [ACTOR_JSON, MAIN_JS],
            mode: 'replace',
            buildTag: 'beta',
            build: false,
        });

        expect(versionUpdateMock).toHaveBeenCalledWith({
            sourceType: 'SOURCE_FILES',
            sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE],
            buildTag: 'beta',
        });
        expect(structuredContent).toMatchObject({ buildTag: 'beta', filesPushed: 2 });
    });

    it('creates the version with the given build tag', async () => {
        versionGetMock.mockResolvedValue(undefined);

        const { structuredContent } = await callTool({
            files: [ACTOR_JSON, MAIN_JS],
            versionNumber: '0.2',
            buildTag: 'beta',
            build: false,
        });

        expect(versionsCreateMock).toHaveBeenCalledWith(expect.objectContaining({ buildTag: 'beta' }));
        expect(structuredContent).toMatchObject({ versionNumber: '0.2', buildTag: 'beta' });
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

        it('matches the username prefix case-insensitively and returns the account spelling', async () => {
            const { structuredContent } = await callTool({
                actorName: 'John/my-actor',
                files: [MAIN_JS],
                build: false,
            });

            expect(actorMock).toHaveBeenCalledWith('john/my-actor');
            expect(structuredContent).toMatchObject({ actorName: 'john/my-actor' });
        });

        it('accepts the API form username~name and returns the username/name form', async () => {
            const { structuredContent } = await callTool({
                actorName: 'john~my-actor',
                files: [MAIN_JS],
                build: false,
            });

            expect(actorMock).toHaveBeenCalledWith('john/my-actor');
            expect(structuredContent).toMatchObject({ actorName: 'john/my-actor' });
        });

        it("refuses a tilde-separated username prefix that is not the caller's", async () => {
            const { text } = await callToolExpectingUserError({ actorName: 'jane~my-actor', files: [MAIN_JS] });

            expect(text).toBe("This tool pushes only to your own account (john); 'jane' names another account.");
            expect(actorGetMock).not.toHaveBeenCalled();
            expectNoWrite();
        });

        it('creates the Actor under its bare name when the username/name form is given', async () => {
            actorGetMock.mockResolvedValue(undefined);

            await callTool({ actorName: 'john/my-actor', files: [ACTOR_JSON], build: false });

            expect(actorsCreateMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-actor' }));
        });

        it("refuses a username prefix that is not the caller's", async () => {
            const { text } = await callToolExpectingUserError({ actorName: 'jane/my-actor', files: [MAIN_JS] });

            expect(text).toBe("This tool pushes only to your own account (john); 'jane' names another account.");
            expect(actorGetMock).not.toHaveBeenCalled();
            expectNoWrite();
        });
    });

    describe('source archive', () => {
        // One byte over the inline limit: 'é' is two utf8 bytes.
        const BIG_TEXT = `${'a'.repeat(MAX_MULTIFILE_BYTES - 1)}é`;
        const BIG_CONFIG = { path: ACTOR_CONFIG_PATH, content: BIG_TEXT };
        const ARCHIVE_URL = 'https://api.apify.com/v2/key-value-stores/store-1/records/version-0.0.zip';

        /** The entries of the uploaded zip, path to bytes, in zip order. */
        const uploadedZipEntries = () => {
            const [{ value }] = setRecordMock.mock.calls[0] as [{ value: Buffer }];
            return Object.fromEntries(
                Object.entries(unzipSync(value)).map(([name, bytes]) => [name, Buffer.from(bytes)]),
            );
        };

        it('uploads files over the limit as a zip and points the version at it', async () => {
            const result = await callTool({ files: [BIG_CONFIG, MAIN_JS], mode: 'replace', build: false });
            const { structuredContent, content } = result;

            expect(storesGetOrCreateMock).toHaveBeenCalledWith('actor-actor-1-source');
            expect(keyValueStoreMock).toHaveBeenCalledWith('store-1');
            expect(setRecordMock).toHaveBeenCalledWith({
                key: 'version-0.0.zip',
                value: expect.any(Buffer),
                contentType: 'application/zip',
            });
            const entries = uploadedZipEntries();
            expect(Object.keys(entries)).toEqual([ACTOR_CONFIG_PATH, 'src/main.js']);
            expect(entries[ACTOR_CONFIG_PATH].toString('utf8')).toBe(BIG_TEXT);
            expect(entries['src/main.js'].toString('utf8')).toBe(MAIN_JS.content);
            expect(versionUpdateMock).toHaveBeenCalledWith({ sourceType: 'TARBALL', tarballUrl: ARCHIVE_URL });
            expect(structuredContent).toMatchObject({ sourceType: 'TARBALL', filesPushed: 2 });
            expectSchemaConformingStructuredContent(result, pushActorToolOutputSchema);
            expect(content[1].text).toContain(
                'stored as a zip in key-value store actor-actor-1-source (record version-0.0.zip)',
            );
            expect(content[1].text).toContain('must send all files with mode replace');
        });

        it('decodes base64 files into the zip', async () => {
            const bytes = Buffer.from([0, 1, 2, 255]);

            await callTool({
                files: [BIG_CONFIG, { path: 'blob.bin', content: bytes.toString('base64'), encoding: 'base64' }],
                mode: 'replace',
                build: false,
            });

            expect(uploadedZipEntries()['blob.bin']).toEqual(bytes);
        });

        it('signs the archive URL when the store is restricted', async () => {
            storesGetOrCreateMock.mockResolvedValue({ id: 'store-1', urlSigningSecretKey: 'secret' });

            await callTool({ files: [BIG_CONFIG], mode: 'replace', build: false });

            const signature = await createHmacSignatureAsync('secret', 'version-0.0.zip');
            expect(versionUpdateMock).toHaveBeenCalledWith({
                sourceType: 'TARBALL',
                tarballUrl: `${ARCHIVE_URL}?signature=${signature}`,
            });
        });

        it('zips the merged set when the kept and pushed files together exceed the limit', async () => {
            const kept = { name: 'big.txt', format: 'TEXT', content: 'a'.repeat(MAX_MULTIFILE_BYTES - 5) };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [ACTOR_JSON_SOURCE, kept] }));

            const { structuredContent } = await callTool({ files: [MAIN_JS], build: false });

            expect(Object.keys(uploadedZipEntries())).toEqual([ACTOR_CONFIG_PATH, 'big.txt', 'src/main.js']);
            expect(versionUpdateMock).toHaveBeenCalledWith({ sourceType: 'TARBALL', tarballUrl: ARCHIVE_URL });
            expect(structuredContent).toMatchObject({ sourceType: 'TARBALL', filesPushed: 3 });
        });

        it('creates a new version pointing at the zip', async () => {
            versionGetMock.mockResolvedValue(undefined);

            await callTool({ files: [BIG_CONFIG], versionNumber: '0.2', buildTag: 'beta', build: false });

            expect(setRecordMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'version-0.2.zip' }));
            expect(versionsCreateMock).toHaveBeenCalledWith({
                versionNumber: '0.2',
                buildTag: 'beta',
                sourceType: 'TARBALL',
                tarballUrl: 'https://api.apify.com/v2/key-value-stores/store-1/records/version-0.2.zip',
            });
            expect(actorsCreateMock).not.toHaveBeenCalled();
        });

        it('creates a new Actor with an empty version first, then switches it to the zip', async () => {
            actorGetMock.mockResolvedValue(undefined);
            storesGetOrCreateMock.mockResolvedValue({ id: 'store-new' });

            const { structuredContent } = await callTool({ files: [BIG_CONFIG], build: false });

            expect(actorsCreateMock).toHaveBeenCalledWith({
                name: 'my-actor',
                versions: [{ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES', sourceFiles: [] }],
            });
            expect(actorsCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
                setRecordMock.mock.invocationCallOrder[0],
            );
            expect(storesGetOrCreateMock).toHaveBeenCalledWith('actor-actor-new-source');
            expect(actorMock).toHaveBeenCalledWith('actor-new');
            expect(versionUpdateMock).toHaveBeenCalledWith({
                sourceType: 'TARBALL',
                tarballUrl: 'https://api.apify.com/v2/key-value-stores/store-new/records/version-0.0.zip',
                buildTag: 'latest',
            });
            expect(structuredContent).toMatchObject({ created: true, sourceType: 'TARBALL', filesPushed: 1 });
        });

        it('reports the created Actor when storing its zip fails', async () => {
            actorGetMock.mockResolvedValue(undefined);
            setRecordMock.mockRejectedValue(new Error('upload failed'));

            const result = await callTool({ files: [BIG_CONFIG], build: false });

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe(
                'The Actor was created (ID actor-new), but storing its files failed: upload failed. Push again to fill version 0.0.',
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('classifies a 403 while filling a created Actor as an auth failure', async () => {
            actorGetMock.mockResolvedValue(undefined);
            storesGetOrCreateMock.mockRejectedValue(apiError(403));

            const result = await callTool({ files: [BIG_CONFIG], build: false });

            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.AUTH,
                    failureHttpStatus: 403,
                    actorId: 'actor-new',
                }),
            );
            expect(result.content[0].text).toMatch(
                /^The Actor was created \(ID actor-new\), but storing its files failed: Forbidden\. Push again/,
            );
        });

        it('maps a 403 from the source store of an existing Actor to the token error', async () => {
            storesGetOrCreateMock.mockRejectedValue(apiError(403));

            const result = await callTool({ files: [BIG_CONFIG], mode: 'replace', build: false });

            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH, failureHttpStatus: 403 }),
            );
            expect(result.content[0].text).toContain('or the key-value store a zipped push goes to');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('switches the requested version of a new Actor to the zip with the given build tag', async () => {
            actorGetMock.mockResolvedValue(undefined);

            await callTool({ files: [BIG_CONFIG], versionNumber: '1.0', buildTag: 'beta', build: false });

            expect(actorsCreateMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    versions: [{ versionNumber: '1.0', buildTag: 'beta', sourceType: 'SOURCE_FILES', sourceFiles: [] }],
                }),
            );
            expect(setRecordMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'version-1.0.zip' }));
            expect(versionMock).toHaveBeenCalledWith('1.0');
            expect(versionUpdateMock).toHaveBeenCalledWith({
                sourceType: 'TARBALL',
                tarballUrl: 'https://api.apify.com/v2/key-value-stores/store-1/records/version-1.0.zip',
                buildTag: 'beta',
            });
        });

        // The boundary is on utf8 bytes as the API receives them, not on characters.
        it('keeps a set of exactly the limit inline', async () => {
            const content = `${'a'.repeat(MAX_MULTIFILE_BYTES - 2)}é`;
            expect(Buffer.byteLength(content, 'utf8')).toBe(MAX_MULTIFILE_BYTES);

            const { structuredContent } = await callTool({
                files: [{ path: ACTOR_CONFIG_PATH, content }],
                mode: 'replace',
                build: false,
            });

            expect(setRecordMock).not.toHaveBeenCalled();
            expect(versionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'SOURCE_FILES' }));
            expect(structuredContent).toMatchObject({ sourceType: 'SOURCE_FILES' });
        });

        // The platform measures the base64 text, not the decoded bytes: 3 decoded bytes become 4 characters.
        it('measures base64 files by their encoded length', async () => {
            const atLimit = Buffer.alloc((MAX_MULTIFILE_BYTES / 4) * 3).toString('base64');
            expect(atLimit).toHaveLength(MAX_MULTIFILE_BYTES);
            await callTool({
                files: [{ path: ACTOR_CONFIG_PATH, content: atLimit, encoding: 'base64' }],
                mode: 'replace',
                build: false,
            });
            expect(setRecordMock).not.toHaveBeenCalled();

            const overLimit = Buffer.alloc((MAX_MULTIFILE_BYTES / 4) * 3 + 3).toString('base64');
            expect(overLimit).toHaveLength(MAX_MULTIFILE_BYTES + 4);
            await callTool({
                files: [{ path: ACTOR_CONFIG_PATH, content: overLimit, encoding: 'base64' }],
                mode: 'replace',
                build: false,
            });
            expect(setRecordMock).toHaveBeenCalledTimes(1);
        });

        // The platform counts a surrogate pair as 5 bytes where utf8 has 4; the tool counts the same way.
        it('measures astral characters the way the platform does', async () => {
            const content = `${'a'.repeat(MAX_MULTIFILE_BYTES - 4)}😀`;
            expect(Buffer.byteLength(content, 'utf8')).toBe(MAX_MULTIFILE_BYTES);

            await callTool({ files: [{ path: ACTOR_CONFIG_PATH, content }], mode: 'replace', build: false });

            expect(setRecordMock).toHaveBeenCalledTimes(1);
        });
    });

    it('refuses to merge onto a version that does not use source files', async () => {
        versionGetMock.mockResolvedValue(
            mockVersion({ sourceType: 'GIT_REPO', sourceFiles: undefined, gitRepoUrl: 'https://github.com/x/y' }),
        );

        const { text } = await callToolExpectingUserError({ files: [MAIN_JS] });

        expect(text).toBe(
            "Version 0.0 uses source type GIT_REPO, which mode 'merge' cannot add to; use mode 'replace' and send all files.",
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

    it.each(['YQ==', 'YWI='])('accepts padded base64 content %s', async (content) => {
        await callTool({ files: [{ path: 'blob.bin', content, encoding: 'base64' }], build: false });

        expect(versionUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceFiles: expect.arrayContaining([{ name: 'blob.bin', format: 'BASE64', content }]),
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

    it('returns the empty aborted response when the request signal is already aborted after the push', async () => {
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());
        const controller = new AbortController();
        controller.abort();

        const result = await (pushActor as HelperTool).call({
            ...stubToolCallContext({ actorName: 'my-actor', files: [MAIN_JS] }, stubClient),
            apifyToken: 'apify_ui_test',
            signal: controller.signal,
        });

        // The push is a completed write; only the build wait is cut short.
        expect(versionUpdateMock).toHaveBeenCalled();
        // Per MCP spec a cancelled request gets no response body, even though the build resolved.
        expect(result).toEqual({});
        // Nothing after the build call runs: no Console-link lookup for what would otherwise be a UI token session.
        expect(getUserInfoCached).not.toHaveBeenCalled();
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
                sourceType: 'SOURCE_FILES',
            });
            expectSchemaConformingStructuredContent(result, pushActorToolOutputSchema);
            expect(result.content[1].text).toBe(
                `${summary}\nThe files were pushed, but the build could not be started: Build quota exceeded. Retry the build with ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
        });

        it('names no tool in the retry hint when build-actor is not loaded', async () => {
            buildMock.mockRejectedValue(apiError(500, 'socket hang up'));

            const { content } = await callTool({ files: [MAIN_JS] }, [HELPER_TOOLS.ACTOR_PUSH]);

            expect(content[1].text).toBe(
                `${summary}\nThe files were pushed, but the build could not be started: socket hang up. Retry building this version to make it runnable.`,
            );
            expect(content[1].text).not.toContain(HELPER_TOOLS.ACTOR_BUILD);
        });

        it('reports a 403 on the build request as a build start failure, not as a permission error', async () => {
            buildMock.mockRejectedValue(apiError(403));

            const result = await callTool({ files: [MAIN_JS] });

            expect(result.isError).not.toBe(true);
            expect(result.content[1].text).toContain(
                'The files were pushed, but the build could not be started: Forbidden.',
            );
        });

        it('reports a non-API error from the build request as a build start failure', async () => {
            buildMock.mockRejectedValue(new TypeError('boom'));

            const result = await callTool({ files: [MAIN_JS] });

            expect(result.isError).not.toBe(true);
            expect(result.content[1].text).toContain(
                'The files were pushed, but the build could not be started: boom.',
            );
            expect(versionUpdateMock).toHaveBeenCalled();
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

        // The check is strict on purpose: Buffer.from skips bad characters, so wrapped or truncated
        // base64 would otherwise upload silently corrupted bytes.
        it.each([
            ['not base64!', 'invalid characters'],
            ['YWJj\n', 'a trailing newline'],
            ['YWJj ZA==', 'whitespace between quartets'],
            ['YWJ', 'an incomplete quartet'],
            ['YW=j', 'misplaced padding'],
        ])('rejects base64 content %j (%s)', async (content, _reason) => {
            const { text } = await callToolExpectingUserError({
                files: [{ path: 'blob.bin', content, encoding: 'base64' }],
            });

            expect(text).toBe("File 'blob.bin' has encoding base64 but its content is not valid base64.");
            expectNoWrite();
        });

        it('requires .actor/actor.json when creating the Actor', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS] });

            expect(text).toBe(ACTOR_CONFIG_MISSING_TEXT);
            expectNoWrite();
        });

        it('requires .actor/actor.json when replacing the files of an existing version', async () => {
            const { text } = await callToolExpectingUserError({ files: [MAIN_JS], mode: 'replace' });

            expect(text).toBe(ACTOR_CONFIG_MISSING_TEXT);
            expectNoWrite();
        });

        it('lists the existing versions when a replace would create a version without .actor/actor.json', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.0', '0.1']));
            versionGetMock.mockResolvedValue(undefined);

            const { text } = await callToolExpectingUserError({
                files: [MAIN_JS],
                versionNumber: '0.2',
                mode: 'replace',
            });

            expect(text).toBe(
                `Version 0.2 does not exist and would be created (this Actor has versions: 0.0, 0.1). ${ACTOR_CONFIG_MISSING_TEXT}`,
            );
            expectNoWrite();
        });

        it('requires .actor/actor.json when creating the Actor in replace mode', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const { text } = await callToolExpectingUserError({ files: [MAIN_JS], mode: 'replace' });

            expect(text).toBe(ACTOR_CONFIG_MISSING_TEXT);
            expectNoWrite();
        });

        it('accepts a merge that adds .actor/actor.json to a version that lacks it', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'old' }] }),
            );

            const { structuredContent } = await callTool({ files: [ACTOR_JSON, MAIN_JS], build: false });

            expect(versionUpdateMock).toHaveBeenCalledWith({
                sourceType: 'SOURCE_FILES',
                sourceFiles: [ACTOR_JSON_SOURCE, MAIN_JS_SOURCE],
            });
            expect(structuredContent).toMatchObject({ filesPushed: 2 });
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

        // The name rules come from `@apify/consts`, the ones the API applies; a bad name never reaches the API.
        describe('Actor name rules', () => {
            const ACTOR_NAME_RULE_TEXT =
                'Actor name must be 3 to 63 characters: letters, digits and dashes, not starting or ending with a dash.';

            it.each([
                { label: 'too short', actorName: 'ab' },
                { label: 'too long', actorName: 'a'.repeat(64) },
                { label: 'an underscore', actorName: 'my_scraper' },
                { label: 'a leading dash', actorName: '-scraper' },
                { label: 'a second separator', actorName: 'john/jane/my-actor' },
            ])('rejects an Actor name with $label without calling the API', async ({ actorName }) => {
                const { text } = await callToolExpectingUserError({ actorName, files: [ACTOR_JSON] });

                expect(text).toBe(ACTOR_NAME_RULE_TEXT);
                expect(userGetMock).not.toHaveBeenCalled();
                expectNoWrite();
            });

            it('rejects a username prefix with invalid characters without calling the API', async () => {
                const { text } = await callToolExpectingUserError({ actorName: 'jo!hn/my-actor', files: [ACTOR_JSON] });

                expect(text).toBe('Username prefix must be 3 to 30 letters, digits, dots, underscores or dashes.');
                expect(userGetMock).not.toHaveBeenCalled();
                expectNoWrite();
            });

            it('accepts a 63-character Actor name', async () => {
                const actorName = 'a'.repeat(63);

                await callTool({ actorName, files: [MAIN_JS], build: false });

                expect(actorMock).toHaveBeenCalledWith(`john/${actorName}`);
                expect(versionUpdateMock).toHaveBeenCalled();
            });

            it('accepts a username prefix with a dot in the tilde form', async () => {
                userGetMock.mockResolvedValue({ username: 'john.doe', id: 'user-secret' });

                const { structuredContent } = await callTool({
                    actorName: 'john.doe~my-actor',
                    files: [MAIN_JS],
                    build: false,
                });

                expect(actorMock).toHaveBeenCalledWith('john.doe/my-actor');
                expect(structuredContent).toMatchObject({ actorName: 'john.doe/my-actor' });
            });

            it('accepts the username/name form', async () => {
                await callTool({ actorName: 'john/my-actor', files: [MAIN_JS], build: false });

                expect(actorMock).toHaveBeenCalledWith('john/my-actor');
                expect(versionUpdateMock).toHaveBeenCalled();
            });
        });

        describe('versionNumber rules', () => {
            it.each(['0.1.5', '1', '1.2.3', ' 0.1'])(
                "rejects versionNumber '%s' without calling the API",
                async (versionNumber) => {
                    const { text } = await callToolExpectingUserError({ files: [ACTOR_JSON], versionNumber });

                    expect(text).toBe('Version number must be MAJOR.MINOR, for example 0.1');
                    expect(userGetMock).not.toHaveBeenCalled();
                    expectNoWrite();
                },
            );

            it.each(['0.1', '12.3'])("accepts versionNumber '%s'", async (versionNumber) => {
                versionGetMock.mockResolvedValue(mockVersion({ versionNumber }));

                const { structuredContent } = await callTool({ files: [MAIN_JS], versionNumber, build: false });

                expect(versionMock).toHaveBeenCalledWith(versionNumber);
                expect(structuredContent).toMatchObject({ versionNumber });
            });
        });

        it('rejects an empty file list, an empty name, an empty buildTag and waitSecs above the cap via ajv validation', () => {
            const tool = pushActor as HelperTool;
            expect(tool.ajvValidate({ actorName: 'my-actor', files: [] })).toBe(false);
            expect(tool.ajvValidate({ actorName: '', files: [MAIN_JS] })).toBe(false);
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
            'The token is not allowed to read or modify Actors in this account, or the key-value store a zipped push goes to; scoped tokens cannot include Actor write access. Use a token with full access.',
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
