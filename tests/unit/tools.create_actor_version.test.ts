import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../src/const.js';
import { createActorVersion } from '../../src/tools/source/create_actor_version.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { buildFilesRevision, buildUrlRevision } from '../../src/tools/source/source_files.js';
import { createActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockUserInfo,
    only,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const actorGetMock = vi.fn();
const versionGetMock = vi.fn();
const versionsCreateMock = vi.fn();
const buildMock = vi.fn();
const versionMock = vi.fn(() => ({ get: versionGetMock }));
const actorMock = vi.fn(() => ({
    get: actorGetMock,
    version: versionMock,
    versions: () => ({ create: versionsCreateMock }),
    build: buildMock,
}));

const stubClient = {
    actor: actorMock,
    baseUrl: 'https://api.example.test/v2',
} as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON = { path: '.actor/actor.json', content: '{"actorSpecification": 1}' };
const DOCKERFILE = { path: 'Dockerfile', content: 'FROM apify/actor-node:20\n' };
const MAIN_JS = { path: 'src/main.js', content: 'console.log(1);\n' };

const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
/** Stored the way Console and `apify push` store them: a BASE64 text file, a folder entry, and a path stored twice. */
const STORED_FILES = [
    { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content },
    { name: 'src/main.js', format: 'BASE64', content: Buffer.from('old\n').toString('base64') },
    { name: 'assets', folder: true },
    { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') },
    { name: './src/main.js', format: 'TEXT', content: MAIN_JS.content },
];

const TOOL_NAMES = Object.values(HELPER_TOOLS);

type CreateVersionOutput = {
    actorId: string;
    fullName: string;
    versionNumber: string;
    sourceType: string;
    buildTag?: string;
    revision: string;
    files: { path: string; sizeBytes: number; hash: string; format: string }[];
    copiedFromVersion?: string;
    secretEnvVarsNotCopied?: string[];
    warnings: string[];
    build?: Record<string, unknown>;
    buildError?: string;
};

type CreateVersionResult = TextToolResult & {
    structuredContent: CreateVersionOutput;
    toolTelemetry?: ToolTelemetrySnapshot;
};

function mockActor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'actor-1',
        userId: 'user-1',
        name: 'my-actor',
        username: 'john',
        versions: [{ versionNumber: '0.1', sourceType: 'SOURCE_FILES', buildTag: 'latest' }],
        ...overrides,
    };
}

/** The version to copy, as the API returns it to the owner: a secret comes back with its value removed. */
function mockSourceVersion(overrides: Record<string, unknown> = {}) {
    return {
        versionNumber: '0.1',
        buildTag: 'latest',
        sourceType: 'SOURCE_FILES',
        envVars: [
            { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
            { name: 'API_KEY', isSecret: true, valueHash: 'abc123' },
            { name: 'REGION', value: 'eu' },
        ],
        // A copy of its own, so a POST body that equals STORED_FILES was not changed in place.
        sourceFiles: structuredClone(STORED_FILES),
        ...overrides,
    };
}

function sha256Prefix(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function apiError(status: number, message: string, type = 'some-error'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

async function callTool(
    args: Record<string, unknown>,
    loadedToolNames?: string[],
    signal?: AbortSignal,
): Promise<CreateVersionResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2', ...args }, stubClient);
    const withTools = loadedToolNames === undefined ? context : { ...context, loadedToolNames };
    const withSignal = signal === undefined ? withTools : { ...withTools, signal };
    return (await (createActorVersion as HelperTool).call(withSignal)) as CreateVersionResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>, loadedToolNames?: string[]) {
    const result = await callTool(args, loadedToolNames);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
}

/** The body of the one version POST the call sent. */
function getPostBody(): Record<string, unknown> {
    expect(versionsCreateMock).toHaveBeenCalledTimes(1);
    return versionsCreateMock.mock.calls[0][0] as Record<string, unknown>;
}

function expectNoToolNamed(text: string) {
    for (const name of TOOL_NAMES) expect(text).not.toContain(name);
}

describe('create-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: 'user-1' }));
        actorGetMock.mockResolvedValue(mockActor());
        versionGetMock.mockResolvedValue(mockSourceVersion());
        versionsCreateMock.mockImplementation(async (body: Record<string, unknown>) => body);
        buildMock.mockResolvedValue({
            id: 'build-1',
            actId: 'actor-1',
            buildNumber: '0.2.1',
            status: 'READY',
            startedAt: new Date('2026-09-01T10:00:00.000Z'),
        });
    });

    it('is a non-destructive, non-idempotent, closed-world tool without payment', () => {
        expect(createActorVersion.name).toBe(HELPER_TOOLS.ACTOR_VERSION_CREATE);
        expect(createActorVersion.annotations).toEqual({
            title: 'Create Actor version',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        });
        expect((createActorVersion as HelperTool).paymentRequired).toBeUndefined();
    });

    describe('description', () => {
        const { buildDescription } = createActorVersion as HelperTool;

        it('names update-actor-version and get-actor-build only when the session has them', () => {
            const full =
                buildDescription?.(only(HELPER_TOOLS.ACTOR_VERSION_UPDATE, HELPER_TOOLS.ACTOR_BUILD_GET)) ?? '';
            expect(full).toBe(createActorVersion.description);
            expect(full).toContain(`To change an existing version, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`);
            expect(full).toContain(`to fill later with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`);
            expect(full).toContain(`Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`);
            const bare = buildDescription?.(only()) ?? '';
            for (const name of TOOL_NAMES.filter((tool) => tool !== HELPER_TOOLS.ACTOR_VERSION_CREATE)) {
                expect(bare).not.toContain(name);
            }
            expect(bare).toContain('an empty version with no files, to fill later.');
        });

        it('uses plain punctuation and names no tool in the input schema', () => {
            expect(createActorVersion.description).not.toMatch(/[–—]/);
            const schemaText = JSON.stringify(createActorVersion.inputSchema);
            for (const name of TOOL_NAMES) expect(schemaText).not.toContain(name);
        });
    });

    describe('copyFromVersion', () => {
        it('sends the stored files exactly as read, formats and folder entries included', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(versionMock).toHaveBeenCalledWith('0.1');
            const body = getPostBody();
            expect(body.sourceType).toBe('SOURCE_FILES');
            expect(body.sourceFiles).toStrictEqual(STORED_FILES);
            const sent = body.sourceFiles as { name: string; format?: string; folder?: boolean }[];
            expect(sent[1].format).toBe('BASE64');
            expect(sent).toContainEqual({ name: 'assets', folder: true });
            expect(body.versionNumber).toBe('0.2');
        });

        it('returns the manifest and revision get-actor-version gives, with no content', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });
            const files = [
                {
                    path: '.actor/actor.json',
                    sizeBytes: ACTOR_JSON.content.length,
                    hash: sha256Prefix(ACTOR_JSON.content),
                    format: 'TEXT',
                },
                {
                    path: 'assets/logo.png',
                    sizeBytes: LOGO_BYTES.length,
                    hash: sha256Prefix(LOGO_BYTES),
                    format: 'BASE64',
                },
                // The last entry for a path wins, as the build writes them in order.
                {
                    path: 'src/main.js',
                    sizeBytes: MAIN_JS.content.length,
                    hash: sha256Prefix(MAIN_JS.content),
                    format: 'TEXT',
                },
            ];
            expect(result.structuredContent.files).toEqual(files);
            expect(result.structuredContent.revision).toBe(buildFilesRevision(files));
            expect(result.structuredContent.copiedFromVersion).toBe('0.1');

            const read = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.1', paths: [] }, stubClient),
            )) as TextToolResult & { structuredContent: { revision: string; files: unknown[] } };
            expect(result.structuredContent.revision).toBe(read.structuredContent.revision);
            expect(result.structuredContent.files).toEqual(read.structuredContent.files);

            const output = result.content.map(({ text }) => text).join('\n');
            expect(output).not.toContain(MAIN_JS.content);
            expect(output).not.toContain(LOGO_BYTES.toString('base64'));
            expect(output).not.toContain('b2xkCg==');
        });

        it('copies the non-secret env vars with their values and lists the secret ones', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(getPostBody().envVars).toEqual([
                { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
                { name: 'REGION', value: 'eu', isSecret: false },
            ]);
            expect(result.structuredContent.secretEnvVarsNotCopied).toEqual(['API_KEY']);
            expect(result.content[1].text).toContain('Copied 2 environment variables with their values.');
            expect(result.content[1].text).toContain(
                'These secret environment variables were not copied, because their values cannot be read: API_KEY. ' +
                    'Set them on version 0.2 yourself, for example in Apify Console.',
            );
            expect(result.content.map(({ text }) => text).join('\n')).not.toContain('abc123');
        });

        it('sends no env vars and lists no secrets for a version without them', async () => {
            versionGetMock.mockResolvedValue(mockSourceVersion({ envVars: undefined }));
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(getPostBody()).not.toHaveProperty('envVars');
            expect(result.structuredContent).not.toHaveProperty('secretEnvVarsNotCopied');
            expect(result.content[1].text).not.toContain('environment variable');
        });

        it('keeps applyEnvVarsToBuild', async () => {
            versionGetMock.mockResolvedValue(mockSourceVersion({ applyEnvVarsToBuild: true }));
            await callTool({ copyFromVersion: '0.1' });
            expect(getPostBody().applyEnvVarsToBuild).toBe(true);
        });

        it('does not copy the build tag of the source version', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(getPostBody()).not.toHaveProperty('buildTag');
            expect(result.structuredContent).not.toHaveProperty('buildTag');
            expect(result.content[1].text).toContain('no build tag, so its builds do not move tags such as latest');
        });

        it('copies a Git URL with its stored credentials, which are never shown', async () => {
            const gitRepoUrl = 'https://user:s3cret@github.com/john/repo.git#main:actor';
            versionGetMock.mockResolvedValue(
                mockSourceVersion({ sourceType: 'GIT_REPO', gitRepoUrl, sourceFiles: undefined }),
            );
            const result = await callTool({ copyFromVersion: '0.1' });
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(getPostBody()).toEqual(
                expect.objectContaining({ versionNumber: '0.2', sourceType: 'GIT_REPO', gitRepoUrl }),
            );
            expect(getPostBody()).not.toHaveProperty('sourceFiles');
            expect(result.structuredContent.sourceType).toBe('GIT_REPO');
            expect(result.structuredContent.files).toEqual([]);
            expect(result.structuredContent.revision).toBe(
                buildUrlRevision('GIT_REPO', 'https://github.com/john/repo.git#main:actor'),
            );
            expect(result.structuredContent.warnings).toEqual([
                'The credentials stored with the URL of version 0.1 were copied too; they are not shown.',
            ]);
            const output = result.content.map(({ text }) => text).join('\n');
            expect(output).toContain('building from the Git repository https://github.com/john/repo.git#main:actor');
            expect(output).not.toContain('s3cret');
        });

        it('copies a GitHub gist URL', async () => {
            const gitHubGistUrl = 'https://gist.github.com/john/abc123';
            versionGetMock.mockResolvedValue(
                mockSourceVersion({ sourceType: 'GITHUB_GIST', gitHubGistUrl, sourceFiles: undefined }),
            );
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(getPostBody()).toEqual(expect.objectContaining({ sourceType: 'GITHUB_GIST', gitHubGistUrl }));
            expect(result.structuredContent.revision).toBe(buildUrlRevision('GITHUB_GIST', gitHubGistUrl));
            expect(result.structuredContent.warnings).toEqual([]);
            expect(result.content[1].text).toContain(`building from the GitHub gist ${gitHubGistUrl}`);
        });

        it('refuses a zip-stored (TARBALL) version before any write', async () => {
            versionGetMock.mockResolvedValue(
                mockSourceVersion({
                    sourceType: 'TARBALL',
                    tarballUrl: 'https://x.test/a.zip',
                    sourceFiles: undefined,
                }),
            );
            const text = await callToolExpectingUserError({ copyFromVersion: '0.1' });
            expect(text).toBe(
                'Version 0.1 of john/my-actor is stored as a zip (TARBALL), and this tool cannot copy zip-stored ' +
                    'versions yet. Give the source as files or gitRepoUrl instead. Or upload your local project ' +
                    'folder (not the stored zip) with the Apify CLI and a build tag no other version uses: apify ' +
                    'push --version 0.2 --build-tag wip-0-2. Without --build-tag, apify push takes the tag from ' +
                    '.actor/actor.json, often latest, and it builds right away.',
            );
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });

        it('refuses a version whose source the API hid, or an unknown source type', async () => {
            versionGetMock.mockResolvedValue(mockSourceVersion({ sourceFiles: undefined }));
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toBe(
                'Version 0.1 of john/my-actor came back without its source, so it cannot be copied.',
            );
            versionGetMock.mockResolvedValue(mockSourceVersion({ sourceType: 'SOURCE_CODE' }));
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toBe(
                'Version 0.1 of john/my-actor has source type SOURCE_CODE, which this tool cannot copy.',
            );
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });

        it('refuses a copyFromVersion the Actor does not have, listing its versions', async () => {
            const text = await callToolExpectingUserError({ copyFromVersion: '0.9' });
            expect(text).toBe("Actor 'john/my-actor' has no version 0.9; available versions: 0.1.");
            expect(versionGetMock).not.toHaveBeenCalled();
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });

        it('refuses a source version that is gone by the time it is read', async () => {
            versionGetMock.mockResolvedValue(undefined);
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toBe(
                'Actor john/my-actor has no version 0.1.',
            );
        });
    });

    describe('files and gitRepoUrl', () => {
        it('creates a version from files in one POST', async () => {
            const result = await callTool({ files: [MAIN_JS, ACTOR_JSON, DOCKERFILE], buildTag: 'beta' });
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(actorMock).toHaveBeenCalledWith('actor-1');
            expect(getPostBody()).toEqual({
                versionNumber: '0.2',
                buildTag: 'beta',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content },
                    { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content },
                    { name: 'Dockerfile', format: 'TEXT', content: DOCKERFILE.content },
                ],
            });
            const files = [ACTOR_JSON, DOCKERFILE, MAIN_JS].map(({ path, content }) => ({
                path,
                sizeBytes: content.length,
                hash: sha256Prefix(content),
                format: 'TEXT',
            }));
            expect(result.structuredContent).toEqual({
                actorId: 'actor-1',
                fullName: 'john/my-actor',
                versionNumber: '0.2',
                sourceType: 'SOURCE_FILES',
                buildTag: 'beta',
                revision: buildFilesRevision(files),
                files,
                warnings: [],
            });
            expect(result.content[1].text).toBe(
                `Created version 0.2 of john/my-actor from 3 files, build tag beta, revision ${buildFilesRevision(files)}.\n` +
                    `The version has no build yet, so it cannot run until it is built. Build it with ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
        });

        it('applies the create-actor file rules', async () => {
            expect(await callToolExpectingUserError({ files: [MAIN_JS, DOCKERFILE] })).toContain(
                'files must include .actor/actor.json',
            );
            expect(await callToolExpectingUserError({ files: [ACTOR_JSON, { path: '../x.js', content: 'x' }] })).toBe(
                "files[1] path ../x.js has a '..' segment.",
            );
            expect(
                await callToolExpectingUserError({
                    files: [ACTOR_JSON, MAIN_JS, { path: './src/main.js', content: '' }],
                }),
            ).toBe('files has src/main.js more than once.');
            expect(
                await callToolExpectingUserError({ files: [ACTOR_JSON, { path: 'a.png', content: 'not base64!' }] }),
            ).toContain('files[1] content for a.png has encoding base64, but its content is not valid base64');
            expect(
                await callToolExpectingUserError({ files: [ACTOR_JSON, { path: 'a'.repeat(256), content: 'x' }] }),
            ).toBe('files[1] path is over 255 characters.');
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('refuses more than 2 MiB of content before any request, naming update-actor-version only when loaded', async () => {
            const files = [ACTOR_JSON, { path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024) }];
            expect(await callToolExpectingUserError({ files })).toContain(
                `Create the version with fewer files, then add the rest in later calls with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`,
            );
            const bare = await callToolExpectingUserError({ files }, [HELPER_TOOLS.ACTOR_VERSION_CREATE]);
            expect(bare).toContain('Create the version with fewer files, then add the rest in later calls.');
            expectNoToolNamed(bare);
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('warns about a missing Dockerfile and empty files', async () => {
            const result = await callTool({ files: [ACTOR_JSON, { path: 'src/empty.js', content: '' }] });
            expect(result.structuredContent.warnings).toEqual([
                expect.stringContaining('No Dockerfile found'),
                'These files are empty, and the build skips empty files, so they will not exist in the build: src/empty.js.',
            ]);
        });

        it('creates a version built from Git, never showing the credentials', async () => {
            const gitRepoUrl = 'https://user:token@github.com/john/repo.git#main';
            const result = await callTool({ gitRepoUrl });
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(getPostBody()).toEqual({ versionNumber: '0.2', sourceType: 'GIT_REPO', gitRepoUrl });
            expect(result.structuredContent.revision).toBe(
                buildUrlRevision('GIT_REPO', 'https://github.com/john/repo.git#main'),
            );
            expect(result.content[1].text).toContain('from the Git repository https://github.com/john/repo.git#main');
            expect(result.content.map(({ text }) => text).join('\n')).not.toContain('token@');
        });
    });

    describe('empty version', () => {
        it('creates a version with an empty file list', async () => {
            const result = await callTool({});
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(getPostBody()).toEqual({ versionNumber: '0.2', sourceType: 'SOURCE_FILES', sourceFiles: [] });
            expect(result.structuredContent.files).toEqual([]);
            expect(result.structuredContent.revision).toBe(buildFilesRevision([]));
            expect(result.content[1].text).toBe(
                `Created version 0.2 of john/my-actor with no files, no build tag, so its builds do not move tags such as latest, revision ${buildFilesRevision([])}.\n` +
                    `The version has no files yet: add them with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}, then build it.`,
            );
            const bare = await callTool({}, [HELPER_TOOLS.ACTOR_VERSION_CREATE]);
            expect(bare.content[1].text).toContain('The version has no files yet: add them, then build it.');
            expectNoToolNamed(bare.content[1].text);
        });

        it('refuses autoBuild for an empty version before any request', async () => {
            expect(await callToolExpectingUserError({ autoBuild: true })).toBe(
                'An empty version has nothing to build. Give copyFromVersion, files, or gitRepoUrl, or leave out autoBuild.',
            );
            expect(actorMock).not.toHaveBeenCalled();
        });
    });

    describe('input rules', () => {
        it('refuses more than one source', async () => {
            const expected = 'Give at most one of copyFromVersion, files, or gitRepoUrl.';
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1', files: [ACTOR_JSON] })).toBe(expected);
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1', gitRepoUrl: 'https://x' })).toBe(
                expected,
            );
            expect(await callToolExpectingUserError({ files: [ACTOR_JSON], gitRepoUrl: 'https://x' })).toBe(expected);
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('leaves the versionNumber format to the platform and returns its message', async () => {
            versionsCreateMock.mockRejectedValue(apiError(400, 'Version number must be in MAJOR.MINOR format'));
            const result = await callTool({ versionNumber: '0.1.2' });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Version number must be in MAJOR.MINOR format');
        });

        it('caps files at 500 in the input schema', () => {
            const files = Array.from({ length: 501 }, (_, index) => ({ path: `f${index}.txt`, content: 'x' }));
            expect(createActorVersion.ajvValidate({ actor: 'john/my-actor', versionNumber: '0.2', files })).toBe(false);
        });

        it('refuses a versionNumber the Actor already has, suggesting a free one first', async () => {
            const text = await callToolExpectingUserError({ versionNumber: '0.1', files: [ACTOR_JSON] });
            expect(text).toBe(
                'john/my-actor already has version 0.1, and this tool never changes an existing version. ' +
                    'Its versions: 0.1. Pick another versionNumber, such as 0.2. ' +
                    `If you meant to change version 0.1 itself, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`,
            );
            const bare = await callToolExpectingUserError({ versionNumber: '0.1' }, [
                HELPER_TOOLS.ACTOR_VERSION_CREATE,
            ]);
            expect(bare).toBe(
                'john/my-actor already has version 0.1, and this tool never changes an existing version. ' +
                    'Its versions: 0.1. Pick another versionNumber, such as 0.2.',
            );
            expectNoToolNamed(bare);
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });

        it('suggests a number after the highest version', async () => {
            actorGetMock.mockResolvedValue(
                mockActor({
                    versions: [
                        { versionNumber: '1.99', sourceType: 'SOURCE_FILES' },
                        { versionNumber: '0.1', sourceType: 'SOURCE_FILES' },
                        { versionNumber: '1.2', sourceType: 'SOURCE_FILES' },
                    ],
                }),
            );
            const text = await callToolExpectingUserError({ versionNumber: '0.1' });
            expect(text).toContain('Its versions: 1.99, 0.1, 1.2. Pick another versionNumber, such as 2.0.');
        });

        it('refuses a versionNumber that a racing call created first, listing it among the versions', async () => {
            versionsCreateMock.mockRejectedValue(
                apiError(403, 'Version with this number already exists', 'version-already-exists'),
            );
            const text = await callToolExpectingUserError({ files: [ACTOR_JSON] });
            expect(text).toBe(
                'john/my-actor already has version 0.2, and this tool never changes an existing version. ' +
                    'Its versions: 0.1, 0.2. Pick another versionNumber, such as 0.3. ' +
                    `If you meant to change version 0.2 itself, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`,
            );
        });
    });

    describe('Standby', () => {
        const STANDBY_WARNING =
            'Creating this version turned on Standby for the whole Actor, because its .actor/actor.json sets ' +
            'usesStandbyMode and Standby was off. Turn it off again in Apify Console if it should stay off.';
        const standbyConfig = {
            path: '.actor/actor.json',
            content: '{"actorSpecification": 1, "usesStandbyMode": true}',
        };

        it('warns when a copied actor.json turns Standby on for the Actor', async () => {
            versionGetMock.mockResolvedValue(
                mockSourceVersion({
                    sourceFiles: [{ name: '.actor/actor.json', format: 'TEXT', content: standbyConfig.content }],
                }),
            );
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(result.structuredContent.warnings).toEqual([STANDBY_WARNING]);
            expect(result.content[1].text).toContain(STANDBY_WARNING);
        });

        it('warns when sent files turn Standby on, and not when Standby is already on', async () => {
            const result = await callTool({ files: [standbyConfig, DOCKERFILE] });
            expect(result.structuredContent.warnings).toEqual([STANDBY_WARNING]);
            actorGetMock.mockResolvedValue(mockActor({ actorStandby: { isEnabled: true } }));
            const enabled = await callTool({ files: [standbyConfig, DOCKERFILE] });
            expect(enabled.structuredContent.warnings).toEqual([]);
        });

        it('does not warn for an actor.json without usesStandbyMode, or one stored as BASE64', async () => {
            const result = await callTool({ files: [ACTOR_JSON, DOCKERFILE] });
            expect(result.structuredContent.warnings).toEqual([]);
            versionGetMock.mockResolvedValue(
                mockSourceVersion({
                    sourceFiles: [
                        {
                            name: '.actor/actor.json',
                            format: 'BASE64',
                            content: Buffer.from(standbyConfig.content).toString('base64'),
                        },
                    ],
                }),
            );
            const copied = await callTool({ copyFromVersion: '0.1' });
            expect(copied.structuredContent.warnings).toEqual([]);
        });
    });

    describe('buildTag and autoBuild', () => {
        it('sends buildTag only when given', async () => {
            await callTool({ files: [ACTOR_JSON, DOCKERFILE] });
            expect(getPostBody()).not.toHaveProperty('buildTag');
            vi.clearAllMocks();
            await callTool({ copyFromVersion: '0.1', buildTag: 'latest' });
            expect(getPostBody().buildTag).toBe('latest');
        });

        it('starts a build without waiting and points at get-actor-build', async () => {
            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true });
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(buildMock).toHaveBeenCalledWith('0.2', { useCache: true });
            expect(result.structuredContent.build).toEqual({
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.2.1',
                status: 'READY',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: null,
            });
            expect(result.content[1].text).toContain(
                `Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId build-1`,
            );
        });

        it('starts no build without autoBuild', async () => {
            await callTool({ copyFromVersion: '0.1' });
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('reports a build that failed to start with the version still created', async () => {
            buildMock.mockRejectedValue(apiError(402, 'Not enough credit'));
            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true });
            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(versionsCreateMock).toHaveBeenCalledTimes(1);
            expect(result.structuredContent.buildError).toBe('Not enough credit');
            expect(result.content[1].text).toContain(
                `The version was created, but the build could not be started: Not enough credit. Start it again with ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
            const bare = await callTool({ copyFromVersion: '0.1', autoBuild: true }, [
                HELPER_TOOLS.ACTOR_VERSION_CREATE,
            ]);
            expect(bare.content[1].text).toContain('Start the build again to make this version runnable.');
            expectNoToolNamed(bare.content[1].text);
        });

        it('names build-actor after a create without autoBuild only when loaded', async () => {
            const bare = await callTool({ files: [ACTOR_JSON, DOCKERFILE] }, [HELPER_TOOLS.ACTOR_VERSION_CREATE]);
            expect(bare.content[1].text).toContain('The version has no build yet, so it cannot run until it is built.');
            expectNoToolNamed(bare.content[1].text);
        });
    });

    describe('cancellation', () => {
        it('sends nothing when the request is cancelled during the reads', async () => {
            const controller = new AbortController();
            versionGetMock.mockImplementation(async () => {
                controller.abort();
                return mockSourceVersion();
            });
            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true }, undefined, controller.signal);
            expect(result).toEqual({});
            expect(versionsCreateMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('starts no build when the request is cancelled during the POST', async () => {
            const controller = new AbortController();
            versionsCreateMock.mockImplementation(async (body: Record<string, unknown>) => {
                controller.abort();
                return body;
            });
            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true }, undefined, controller.signal);
            expect(result).toEqual({});
            expect(versionsCreateMock).toHaveBeenCalledTimes(1);
            expect(buildMock).not.toHaveBeenCalled();
        });
    });

    describe('ownership', () => {
        it('refuses a session without a token before any request', async () => {
            const context = {
                ...stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2' }, stubClient),
                apifyToken: '',
            };
            const result = (await (createActorVersion as HelperTool).call(context)) as CreateVersionResult;
            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
            expect(result.content[0].text).toBe(
                "Changing an Actor's source needs an Apify API token, and this session has none.",
            );
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('refuses an Actor that does not exist or a bare name', async () => {
            actorGetMock.mockResolvedValue(undefined);
            expect(await callToolExpectingUserError({ actor: 'my-actor' })).toBe(
                'Actor my-actor not found. Give its ID or its full name, username/name; a name without the username is not enough.',
            );
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });

        it('refuses when the account cannot be confirmed', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
            expect(versionGetMock).not.toHaveBeenCalled();
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });

        it("refuses someone else's Actor", async () => {
            actorGetMock.mockResolvedValue(mockActor({ userId: 'someone-else' }));
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toBe(
                'john/my-actor is not in your account; this tool changes only your own Actors.',
            );
            expect(versionGetMock).not.toHaveBeenCalled();
            expect(versionsCreateMock).not.toHaveBeenCalled();
        });
    });

    describe('API errors', () => {
        it('returns a 4xx from the POST as the API message', async () => {
            versionsCreateMock.mockRejectedValue(
                apiError(403, 'The Actor can have at most 10 versions.', 'too-many-versions'),
            );
            const result = await callTool({ copyFromVersion: '0.1' });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('The Actor can have at most 10 versions.');
        });

        it('rethrows a 5xx', async () => {
            versionsCreateMock.mockRejectedValue(apiError(500, 'Internal'));
            await expect(callTool({ copyFromVersion: '0.1' })).rejects.toThrow('Internal');
        });
    });
});
