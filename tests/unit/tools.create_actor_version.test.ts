import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { createActorVersion } from '../../src/tools/source/create_actor_version.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { buildFilesRevision } from '../../src/tools/source/source_files.js';
import { createActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const actorGetMock = vi.fn();
const versionsCreateMock = vi.fn();
const buildMock = vi.fn();
// The Actor client's methods that change the Actor or one of its versions, which this tool never calls.
const otherWriteMocks = { update: vi.fn(), delete: vi.fn(), version: vi.fn() };
const actorMock = vi.fn(() => ({
    get: actorGetMock,
    versions: () => ({ create: versionsCreateMock }),
    build: buildMock,
    ...otherWriteMocks,
}));
// The build client, which only waiting for a build uses.
const buildClientMock = vi.fn();

const stubClient = { actor: actorMock, build: buildClientMock } as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON = { path: '.actor/actor.json', content: '{"actorSpecification": 1}' };
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

type CreateVersionOutput = {
    actorId: string;
    fullName: string;
    versionNumber: string;
    revision: string;
    files: { path: string; sizeBytes: number; hash: string }[];
    warnings?: string[];
    build?: Record<string, unknown>;
    buildError?: string;
};

type CreateVersionResult = TextToolResult & {
    structuredContent: CreateVersionOutput;
    toolTelemetry?: ToolTelemetrySnapshot;
};

/** The version to copy, as the Actor GET returns it to the owner: a secret comes back with its value removed. */
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

/** The Actor GET, which carries the versions with their files and env vars. */
function mockActorRead(versionOverrides: Record<string, unknown> = {}) {
    actorGetMock.mockResolvedValue({
        id: 'actor-1',
        name: 'my-actor',
        username: 'john',
        versions: [mockSourceVersion(versionOverrides)],
    });
}

function sha256Prefix(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** `attempt` counts apify-client's tries of the request, retries included. */
function apiError(status: number, message: string, type = 'some-error', attempt = 1): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, attempt);
}

async function callTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<CreateVersionResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2', ...args }, stubClient);
    const withSignal = signal === undefined ? context : { ...context, signal };
    return (await (createActorVersion as HelperTool).call(withSignal)) as CreateVersionResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>) {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    expect(versionsCreateMock).not.toHaveBeenCalled();
    return result.content[0].text;
}

/** The body of the one version POST the call sent. */
function getPostBody(): Record<string, unknown> {
    expect(versionsCreateMock).toHaveBeenCalledTimes(1);
    return versionsCreateMock.mock.calls[0][0] as Record<string, unknown>;
}

function expectNoOtherWrite() {
    for (const [name, mock] of Object.entries(otherWriteMocks)) {
        expect(mock, name).not.toHaveBeenCalled();
    }
}

describe('create-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockActorRead();
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

    it('requires the actor and versionNumber, and refuses an empty files list or copyFromVersion', () => {
        const tool = createActorVersion as HelperTool;

        expect(tool.inputSchema.required).toEqual(['actor', 'versionNumber']);
        expect(tool.ajvValidate({ actor: 'john/my-actor', copyFromVersion: '0.1' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'john/my-actor', versionNumber: '0.2', files: [] })).toBe(false);
        expect(tool.ajvValidate({ actor: 'john/my-actor', versionNumber: '0.2', copyFromVersion: '' })).toBe(false);
        expect(tool.ajvValidate({ actor: 'john/my-actor', versionNumber: '0.2', copyFromVersion: '0.1' })).toBe(true);
    });

    it.each([
        ['files', { files: [ACTOR_JSON] }],
        ['a copy', { copyFromVersion: '0.1' }],
    ])('only POSTs a new version to the Actor it resolved, for %s', async (_, args) => {
        await callTool(args);

        expect(actorMock.mock.calls).toEqual([['john/my-actor'], ['actor-1']]);
        expect(actorGetMock).toHaveBeenCalledTimes(1);
        expect(versionsCreateMock).toHaveBeenCalledTimes(1);
        expectNoOtherWrite();
        expect(buildMock).not.toHaveBeenCalled();
    });

    describe('copyFromVersion', () => {
        it('sends the stored files exactly as read, formats and folder entries included', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(actorMock).toHaveBeenCalledWith('actor-1');
            const body = getPostBody();
            expect(body.versionNumber).toBe('0.2');
            expect(body.sourceType).toBe('SOURCE_FILES');
            expect(body.sourceFiles).toStrictEqual(STORED_FILES);
        });

        it('returns the manifest and revision get-actor-version gives, with no content', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });
            const read = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.1' }, stubClient),
            )) as { structuredContent: { revision: string; files: unknown[] } };

            // The last entry for a path wins, as the build writes them in order.
            const files = [
                {
                    path: '.actor/actor.json',
                    sizeBytes: ACTOR_JSON.content.length,
                    hash: sha256Prefix(ACTOR_JSON.content),
                },
                { path: 'assets/logo.png', sizeBytes: LOGO_BYTES.length, hash: sha256Prefix(LOGO_BYTES) },
                { path: 'src/main.js', sizeBytes: MAIN_JS.content.length, hash: sha256Prefix(MAIN_JS.content) },
            ];
            expect(result.structuredContent).toEqual({
                actorId: 'actor-1',
                fullName: 'john/my-actor',
                versionNumber: '0.2',
                revision: buildFilesRevision(files),
                files,
            });
            expect(result.structuredContent.revision).toBe(read.structuredContent.revision);
            expect(result.structuredContent.files).toEqual(read.structuredContent.files);
            expect(result.content[1].text).toBe(
                'Created version 0.2 of john/my-actor.\nBuild the version to run these files.',
            );
            expect(result.content.map(({ text }) => text).join('\n')).not.toContain(LOGO_BYTES.toString('base64'));
        });

        it('copies the non-secret env vars and applyEnvVarsToBuild, never the build tag', async () => {
            mockActorRead({ applyEnvVarsToBuild: true });

            const result = await callTool({ copyFromVersion: '0.1' });

            expect(getPostBody()).toStrictEqual({
                versionNumber: '0.2',
                sourceType: 'SOURCE_FILES',
                sourceFiles: STORED_FILES,
                envVars: [
                    { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
                    { name: 'REGION', value: 'eu' },
                ],
                applyEnvVarsToBuild: true,
            });
            // No env var reaches the output, and neither does the secret's name or hash.
            expect(JSON.stringify(result)).not.toMatch(/API_KEY|abc123|LOG_LEVEL|REGION/);
        });

        it('never copies a secret env var, even one that comes back with its value', async () => {
            mockActorRead({
                envVars: [
                    { name: 'API_KEY', value: 'secret-value', isSecret: true },
                    { name: 'REGION', value: 'eu' },
                ],
            });

            const result = await callTool({ copyFromVersion: '0.1' });

            expect(getPostBody().envVars).toStrictEqual([{ name: 'REGION', value: 'eu' }]);
            expect(JSON.stringify(result)).not.toMatch(/API_KEY|secret-value/);
        });

        it('copies the files and env vars of the version it names, not of another version', async () => {
            const copiedFiles = [
                { name: 'main.py', format: 'TEXT', content: 'print(3)\n' },
                { name: 'data', folder: true },
                { name: 'data/seed.bin', format: 'BASE64', content: 'AAE=' },
            ];
            // The copied version sits between two others, so a copy of the first or the last sends another body.
            actorGetMock.mockResolvedValue({
                id: 'actor-1',
                name: 'my-actor',
                username: 'john',
                versions: [
                    mockSourceVersion({ applyEnvVarsToBuild: false }),
                    mockSourceVersion({
                        versionNumber: '0.3',
                        buildTag: 'beta',
                        envVars: [
                            { name: 'MODE', value: 'test' },
                            { name: 'TOKEN', isSecret: true, valueHash: 'def456' },
                        ],
                        applyEnvVarsToBuild: true,
                        sourceFiles: structuredClone(copiedFiles),
                    }),
                    mockSourceVersion({ versionNumber: '0.5', applyEnvVarsToBuild: false }),
                ],
            });

            const result = await callTool({ copyFromVersion: '0.3' });

            expect(getPostBody()).toStrictEqual({
                versionNumber: '0.2',
                sourceType: 'SOURCE_FILES',
                sourceFiles: copiedFiles,
                envVars: [{ name: 'MODE', value: 'test' }],
                applyEnvVarsToBuild: true,
            });
            expect(result.structuredContent.files.map(({ path }) => path)).toEqual(['data/seed.bin', 'main.py']);
        });

        it.each([false, undefined])(
            'copies applyEnvVarsToBuild %s as the version has it',
            async (applyEnvVarsToBuild) => {
                mockActorRead({ applyEnvVarsToBuild });

                await callTool({ copyFromVersion: '0.1' });

                expect(getPostBody().applyEnvVarsToBuild).toBe(applyEnvVarsToBuild);
            },
        );

        it.each<{ outcome: string; version: Record<string, unknown>; text: string }>([
            {
                outcome: 'a GIT_REPO version, naming its URL without credentials',
                version: {
                    sourceType: 'GIT_REPO',
                    gitRepoUrl: 'https://oauth2:secret-token@gitlab.com/john/repo.git#main',
                },
                text: 'Version 0.1 of john/my-actor has its files in the Git repository https://gitlab.com/john/repo.git#main, not stored on Apify, so this tool cannot work on them; use the repository.',
            },
            {
                outcome: 'a GITHUB_GIST version, naming its URL without credentials',
                version: {
                    sourceType: 'GITHUB_GIST',
                    gitHubGistUrl: 'https://gist.github.com/john/abc123?secret=secret-query',
                },
                text: 'Version 0.1 of john/my-actor has its files in the GitHub gist https://gist.github.com/john/abc123, not stored on Apify, so this tool cannot work on them; use the gist.',
            },
            {
                outcome: 'a TARBALL version without naming its URL',
                version: {
                    sourceType: 'TARBALL',
                    tarballUrl:
                        'https://api.example.test/v2/key-value-stores/s/records/version-0.1.zip?signature=secret',
                },
                text: 'Version 0.1 of john/my-actor is stored as a zip archive (apify push does this for sources over 3 MiB), and this tool cannot work on zip-stored versions yet.',
            },
        ])('refuses $outcome, with no POST', async ({ version, text }) => {
            // The version keeps the files it had as SOURCE_FILES, which must not be copied.
            mockActorRead(version);

            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(text);
            expect(JSON.stringify(result)).not.toMatch(/secret|oauth2|example|key-value-stores/);
            expect(versionsCreateMock).not.toHaveBeenCalled();
            expectNoOtherWrite();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('refuses a version whose source the API hides', async () => {
            mockActorRead({ sourceFiles: undefined });

            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toBe(
                "Version 0.1 of john/my-actor came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.",
            );
        });

        it('refuses a copyFromVersion the Actor does not have', async () => {
            expect(await callToolExpectingUserError({ copyFromVersion: '0.9' })).toBe(
                "Actor 'john/my-actor' has no version 0.9; available versions: 0.1.",
            );
        });
    });

    describe('files', () => {
        it('creates a version from files in one POST, with no env vars', async () => {
            const result = await callTool({
                files: [MAIN_JS, ACTOR_JSON, { path: 'assets/logo.png', content: 'AA==' }],
            });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(getPostBody()).toEqual({
                versionNumber: '0.2',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content },
                    { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content },
                    { name: 'assets/logo.png', format: 'BASE64', content: 'AA==' },
                ],
            });
            expect(result.structuredContent.files.map(({ path }) => path)).toEqual([
                '.actor/actor.json',
                'assets/logo.png',
                'src/main.js',
            ]);
        });

        it('returns the manifest and revision get-actor-version gives for the files it sent', async () => {
            const readme = '# My Actor\n';
            const result = await callTool({
                files: [
                    { path: './src//main.js', content: MAIN_JS.content },
                    ACTOR_JSON,
                    { path: 'assets/logo.png', content: LOGO_BYTES.toString('base64') },
                    { path: 'README.md', content: Buffer.from(readme).toString('base64'), encoding: 'base64' },
                ],
            });
            // The path is stored normalized, the way get-actor-version lists it.
            expect(getPostBody().sourceFiles).toStrictEqual([
                { name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content },
                { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content },
                { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') },
                { name: 'README.md', format: 'BASE64', content: Buffer.from(readme).toString('base64') },
            ]);
            actorGetMock.mockResolvedValue({
                id: 'actor-1',
                name: 'my-actor',
                username: 'john',
                versions: [
                    { versionNumber: '0.2', sourceType: 'SOURCE_FILES', sourceFiles: getPostBody().sourceFiles },
                ],
            });
            const read = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', versionNumber: '0.2' }, stubClient),
            )) as { structuredContent: { revision: string; files: unknown[] } };

            const files = [
                {
                    path: '.actor/actor.json',
                    sizeBytes: ACTOR_JSON.content.length,
                    hash: sha256Prefix(ACTOR_JSON.content),
                },
                { path: 'README.md', sizeBytes: readme.length, hash: sha256Prefix(readme) },
                { path: 'assets/logo.png', sizeBytes: LOGO_BYTES.length, hash: sha256Prefix(LOGO_BYTES) },
                { path: 'src/main.js', sizeBytes: MAIN_JS.content.length, hash: sha256Prefix(MAIN_JS.content) },
            ];
            expect(result.structuredContent.files).toEqual(files);
            expect(result.structuredContent.revision).toBe(buildFilesRevision(files));
            expect(result.structuredContent.revision).toBe(read.structuredContent.revision);
            expect(result.structuredContent.files).toEqual(read.structuredContent.files);
        });

        it('warns about empty files, which the build skips', async () => {
            const result = await callTool({ files: [ACTOR_JSON, { path: 'src/__init__.py', content: '' }] });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: src/__init__.py.',
            ]);
        });

        it.each<[string, Record<string, unknown>[], string]>([
            [
                'a path outside the Actor root',
                [MAIN_JS, { path: '../x.js', content: 'x' }],
                'files[1] (../x.js) has a path outside the Actor root; give one relative to it, such as src/main.js.',
            ],
            [
                'an absolute path',
                [{ path: '/src/main.js', content: 'x' }],
                'files[0] (/src/main.js) has a path outside the Actor root; give one relative to it, such as src/main.js.',
            ],
            [
                'a folder path',
                [{ path: 'src/', content: 'x' }],
                'files[0] (src/) has a path that names a folder, not a file.',
            ],
            [
                'the same path twice',
                [MAIN_JS, { path: './src/main.js', content: '2' }],
                'files[1] (./src/main.js) repeats the path src/main.js; send each file once.',
            ],
            [
                'a file under another file',
                [{ path: 'src', content: 'x' }, MAIN_JS],
                'files[1] (src/main.js) collides with src; one path cannot be both a file and a folder.',
            ],
            [
                'text sent to a binary extension',
                [{ path: 'assets/a.png', content: 'hello world' }],
                'files[0] (assets/a.png) has content that is not valid base64; send binary content as base64, or text with encoding utf8.',
            ],
            [
                'text with a lone UTF-16 surrogate',
                [{ path: 'src/a.js', content: 'smile \uD83D' }],
                'files[0] (src/a.js) has text with a lone UTF-16 surrogate, which UTF-8 cannot store.',
            ],
        ])('refuses %s, and creates nothing', async (_, files, text) => {
            expect(await callToolExpectingUserError({ files, autoBuild: true })).toBe(text);
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('refuses a call with neither files nor copyFromVersion before any request', async () => {
            expect(await callToolExpectingUserError({})).toBe('Give either files or copyFromVersion.');
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('refuses both files and copyFromVersion before any request', async () => {
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1', files: [ACTOR_JSON] })).toBe(
                'Give either files or copyFromVersion.',
            );
            expect(actorMock).not.toHaveBeenCalled();
        });
    });

    it.each([
        ['files', { files: [ACTOR_JSON] }],
        // The copied version has the build tag latest.
        ['a copy', { copyFromVersion: '0.1' }],
    ])('sends buildTag only when given, for %s', async (_, args) => {
        await callTool({ ...args, buildTag: 'beta' });
        expect(getPostBody().buildTag).toBe('beta');
        vi.clearAllMocks();

        await callTool(args);
        expect(getPostBody()).not.toHaveProperty('buildTag');
    });

    describe('Actor and API errors', () => {
        it('reports a missing Actor', async () => {
            actorGetMock.mockResolvedValue(undefined);

            expect(await callToolExpectingUserError({ actor: 'my-actor', files: [ACTOR_JSON] })).toBe(
                "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
            );
        });

        it.each([
            ['files', { files: [ACTOR_JSON] }],
            ['a copy of that version', { copyFromVersion: '0.1' }],
        ])('reports a version number the Actor already has, from %s', async (_, args) => {
            versionsCreateMock.mockRejectedValue(
                apiError(403, 'Version with this number already exists', 'version-already-exists'),
            );

            const result = await callTool({ versionNumber: '0.1', autoBuild: true, ...args });

            // The platform's reason, without the token-access hint the engine adds to a 403.
            expectSoftFailInvalidInput(result);
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureHttpStatus: 403 }));
            expect(result.content[0].text).toBe(
                'Version with this number already exists (API error type: version-already-exists)',
            );
            expect(getPostBody().versionNumber).toBe('0.1');
            expectNoOtherWrite();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('lets any other API error of the POST through to the engine', async () => {
            const error = apiError(403, 'You do not have permission to modify this Actor.', 'insufficient-permissions');
            versionsCreateMock.mockRejectedValue(error);

            await expect(callTool({ files: [ACTOR_JSON] })).rejects.toBe(error);
        });

        it.each([
            ['files', { files: [ACTOR_JSON] }],
            ['a copy of that version', { copyFromVersion: '0.1' }],
        ])(
            'says an earlier attempt may have created the version when the platform refuses the number on a retried POST, from %s',
            async (_, args) => {
                // apify-client retries a POST that timed out or got a 5xx, and the platform may have saved the attempt.
                versionsCreateMock.mockRejectedValue(
                    apiError(403, 'Version with this number already exists', 'version-already-exists', 2),
                );

                const result = await callTool({ autoBuild: true, ...args });

                expectSoftFailInvalidInput(result);
                expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureHttpStatus: 403 }));
                expect(result.structuredContent).toBeUndefined();
                expect(result.content).toStrictEqual([
                    {
                        type: 'text',
                        text:
                            'The platform refused version 0.2 as taken when the request was retried, so an earlier ' +
                            'attempt of this call may have created it. Read it with get-actor-version before calling ' +
                            'create-actor-version again; if it holds the files this call sent, this call created it.',
                    },
                ]);
                expect(getPostBody().versionNumber).toBe('0.2');
                expectNoOtherWrite();
                expect(buildMock).not.toHaveBeenCalled();
            },
        );

        it('lets any other API error of a retried POST through unchanged', async () => {
            const error = apiError(
                403,
                'The limit on the combined size of all versions has been exceeded.',
                'versions-size-exceeded',
                2,
            );
            versionsCreateMock.mockRejectedValue(error);

            await expect(callTool({ files: [ACTOR_JSON] })).rejects.toBe(error);
        });
    });

    describe('cancellation', () => {
        it('creates nothing when the request is cancelled during the read', async () => {
            const controller = new AbortController();
            actorGetMock.mockImplementation(async () => {
                controller.abort();
                return { id: 'actor-1', name: 'my-actor', username: 'john', versions: [mockSourceVersion()] };
            });

            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true }, controller.signal);

            expect(result).toEqual({});
            expect(versionsCreateMock).not.toHaveBeenCalled();
            expectNoOtherWrite();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('keeps the version and starts no build when the request is cancelled during the POST', async () => {
            const controller = new AbortController();
            versionsCreateMock.mockImplementation(async () => controller.abort());

            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true }, controller.signal);

            expect(result).toEqual({});
            expect(versionsCreateMock).toHaveBeenCalledTimes(1);
            expectNoOtherWrite();
            expect(buildMock).not.toHaveBeenCalled();
        });
    });

    describe('autoBuild', () => {
        it('starts a build of the new version without waiting', async () => {
            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            // Actor GET, version POST, build start: no tag, so the new version's own buildTag applies.
            expect(actorMock.mock.calls).toEqual([['john/my-actor'], ['actor-1'], ['actor-1']]);
            expect(buildMock.mock.calls).toEqual([['0.2', { useCache: true }]]);
            expect(buildClientMock).not.toHaveBeenCalled();
            expect(result.structuredContent.build).toEqual({
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.2.1',
                status: 'READY',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: null,
            });
        });

        it('starts no build without autoBuild', async () => {
            const result = await callTool({ copyFromVersion: '0.1' });

            expect(versionsCreateMock).toHaveBeenCalledTimes(1);
            expect(buildMock).not.toHaveBeenCalled();
            expect(result.structuredContent).not.toHaveProperty('build');
            expect(result.content[1].text).toBe(
                'Created version 0.2 of john/my-actor.\nBuild the version to run these files.',
            );
        });

        it('keeps the build it started when the request is cancelled during the build start', async () => {
            const controller = new AbortController();
            buildMock.mockImplementation(async () => {
                controller.abort();
                return {
                    id: 'build-1',
                    actId: 'actor-1',
                    buildNumber: '0.2.1',
                    status: 'RUNNING',
                    startedAt: new Date('2026-09-01T10:00:00.000Z'),
                };
            });
            // The build client is what aborts a build.
            const abortMock = vi.fn(async () => ({}));
            buildClientMock.mockReturnValueOnce({ abort: abortMock });

            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true }, controller.signal);

            expect(buildMock).toHaveBeenCalledTimes(1);
            expect(buildClientMock).not.toHaveBeenCalled();
            expect(abortMock).not.toHaveBeenCalled();
            expect(result.structuredContent.build).toEqual({
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.2.1',
                status: 'RUNNING',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: null,
            });
        });

        it('reports a build that failed to start with the version still created', async () => {
            buildMock.mockRejectedValue(apiError(402, 'Not enough credit'));

            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(versionsCreateMock).toHaveBeenCalledTimes(1);
            expect(result.structuredContent.buildError).toBe('Not enough credit');
            expect(result.structuredContent).not.toHaveProperty('build');
        });
    });
});
