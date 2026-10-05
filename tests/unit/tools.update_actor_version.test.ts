import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { buildFilesRevision } from '../../src/tools/source/source_files.js';
import { updateActorVersion } from '../../src/tools/source/update_actor_version.js';
import { updateActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import { VERBATIM_LINKS_NUDGE } from '../../src/utils/console_link.js';
import { getUserInfoCached } from '../../src/utils/userid_cache.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockUserInfo,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

vi.mock('../../src/utils/userid_cache.js', () => ({
    getUserInfoCached: vi.fn(),
}));

const actorGetMock = vi.fn();
const versionUpdateMock = vi.fn();
const buildMock = vi.fn();
const versionMock = vi.fn(() => ({ update: versionUpdateMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock, build: buildMock }));
// The build client, which only waiting for a build uses.
const buildClientMock = vi.fn();

const stubClient = { actor: actorMock, build: buildClientMock } as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 1}' };
const MAIN_JS = { name: 'src/main.js', format: 'TEXT', content: 'const a = 1;\nconsole.log(a);\nexport {};\n' };
const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
const LOGO = { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') };
const FOLDER = { name: 'storage', folder: true };
const EMPTY_INIT = { name: 'src/__init__.py', format: 'TEXT', content: '' };
// Stored without content, which the build worker reads as empty.
const NO_CONTENT = { name: 'src/blank.js', format: 'TEXT' };

type UpdateOutput = {
    revision: string;
    changed: boolean;
    changes: { path: string; action: string; hash?: string }[];
    warnings?: string[];
    build?: Record<string, unknown>;
    buildError?: string;
};

type UpdateResult = TextToolResult & { structuredContent: UpdateOutput; toolTelemetry?: ToolTelemetrySnapshot };

function sha256Prefix(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

const MAIN_JS_HASH = sha256Prefix(MAIN_JS.content);

/** A SOURCE_FILES version with env vars, which a write must never send back. */
function mockVersion(overrides: Record<string, unknown> = {}) {
    return {
        versionNumber: '0.1',
        buildTag: 'latest',
        sourceType: 'SOURCE_FILES',
        envVars: [{ name: 'API_KEY', value: 'secret-value', isSecret: true }],
        sourceFiles: [ACTOR_JSON, MAIN_JS, LOGO, FOLDER],
        ...overrides,
    };
}

/** The Actor GET, which carries the versions with their files. */
function mockVersionRead(overrides: Record<string, unknown> = {}) {
    actorGetMock.mockResolvedValue({
        id: 'actor-1',
        name: 'my-actor',
        username: 'john',
        versions: [mockVersion(overrides)],
    });
}

function mockFiles(...sourceFiles: Record<string, unknown>[]) {
    mockVersionRead({ sourceFiles });
}

function apiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: 'some-error', message } }, status } as AxiosResponse, 1);
}

async function callTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<UpdateResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient);
    const withSignal = signal === undefined ? context : { ...context, signal };
    return (await (updateActorVersion as HelperTool).call(withSignal)) as UpdateResult;
}

/** A call from an Apify Console session, whose UI token gets Console links. */
async function callToolInConsole(args: Record<string, unknown>): Promise<UpdateResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient);
    return (await (updateActorVersion as HelperTool).call({ ...context, apifyToken: 'apify_ui_test' })) as UpdateResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>) {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    expect(versionUpdateMock).not.toHaveBeenCalled();
    return result.content[0].text;
}

/** The files of the one version PUT the call sent. */
function getPutFiles(): Record<string, unknown>[] {
    expect(versionUpdateMock).toHaveBeenCalledTimes(1);
    return (versionUpdateMock.mock.calls[0][0] as { sourceFiles: Record<string, unknown>[] }).sourceFiles;
}

type VersionRead = {
    revision: string;
    files: { path: string; sizeBytes: number; hash: string }[];
    contents: { path: string; content: string; encoding: string }[];
};

async function readVersion(args: Record<string, unknown> = {}): Promise<VersionRead> {
    const result = (await (getActorVersion as HelperTool).call(
        stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient),
    )) as { structuredContent: VersionRead };
    return result.structuredContent;
}

async function readRevision(): Promise<string> {
    return (await readVersion()).revision;
}

const write = (path: string, content: string, extra: Record<string, unknown> = {}) => ({
    type: 'write',
    path,
    content,
    ...extra,
});

const edit = (path: string, ...edits: { oldText: string; newText: string }[]) => ({ type: 'edit', path, edits });

const remove = (path: string, expectedHash: string) => ({ type: 'delete', path, expectedHash });

/** A precondition failure message, up to the detail that follows the reason. */
const failedWith = (index: number, type: string, path: string, reason: string) =>
    `Nothing was written: operations[${index}] (${type} ${path}) failed with ${reason}.`;

describe('update-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVersionRead();
        versionUpdateMock.mockResolvedValue({});
        buildMock.mockResolvedValue({
            id: 'build-1',
            actId: 'actor-1',
            buildNumber: '0.1.5',
            status: 'READY',
            startedAt: new Date('2026-09-01T10:00:00.000Z'),
        });
    });

    it('is a destructive, non-idempotent, closed-world tool without payment', () => {
        expect(updateActorVersion.name).toBe(HELPER_TOOLS.ACTOR_VERSION_UPDATE);
        expect(updateActorVersion.annotations).toEqual({
            title: 'Update Actor version',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        });
        expect((updateActorVersion as HelperTool).paymentRequired).toBeUndefined();
    });

    it('reads the Actor once and sends one PUT with only sourceType and sourceFiles', async () => {
        const result = await callTool({ operations: [write('src/util.js', 'export const b = 2;\n')] });

        expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
        expect(actorGetMock).toHaveBeenCalledTimes(1);
        expect(actorMock).toHaveBeenNthCalledWith(1, 'john/my-actor');
        expect(actorMock).toHaveBeenNthCalledWith(2, 'actor-1');
        expect(versionMock).toHaveBeenCalledWith('0.1');
        // Folder entries go back as stored, then the stored files in path order; new files follow in the order written.
        expect(versionUpdateMock).toHaveBeenCalledWith({
            sourceType: 'SOURCE_FILES',
            sourceFiles: [
                FOLDER,
                ACTOR_JSON,
                LOGO,
                MAIN_JS,
                { name: 'src/util.js', format: 'TEXT', content: 'export const b = 2;\n' },
            ],
        });
        expect(result.structuredContent).toEqual({
            revision: expect.stringMatching(/^[0-9a-f]{16}$/),
            changed: true,
            changes: [{ path: 'src/util.js', action: 'created', hash: sha256Prefix('export const b = 2;\n') }],
        });
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toBe(
            'Updated version 0.1 of john/my-actor.\nRuns use these files once the version is built.',
        );
        expect(buildMock).not.toHaveBeenCalled();
    });

    describe('input schema', () => {
        const validate = (args: Record<string, unknown>) => (updateActorVersion as HelperTool).ajvValidate(args);
        const fullOperation = {
            type: 'edit',
            path: 'a.js',
            content: 'x',
            encoding: 'utf8',
            expectedHash: MAIN_JS_HASH,
            edits: [{ oldText: 'a', newText: 'b' }],
        };

        it('requires only actor and operations', () => {
            expect((updateActorVersion as HelperTool).inputSchema.required).toEqual(['actor', 'operations']);
        });

        it.each(['write', 'edit', 'delete'])(
            'keeps every field of an operation of type %s, the fields of the other types included, and strips unknown keys',
            (type) => {
                const args = {
                    actor: 'john/my-actor',
                    operations: [{ ...fullOperation, type, extra: 1 }],
                    expectedRevision: 'abc',
                    autoBuild: true,
                    unknown: 'x',
                };

                expect(validate(args)).toBe(true);
                expect(args).toStrictEqual({
                    actor: 'john/my-actor',
                    operations: [{ ...fullOperation, type }],
                    expectedRevision: 'abc',
                    autoBuild: true,
                });
            },
        );

        it.each<[string, Record<string, unknown>]>([
            ['no actor', { operations: [] }],
            ['an empty actor', { actor: '', operations: [] }],
            ['no operations', { actor: 'john/my-actor' }],
            ['an unknown operation type', { actor: 'a', operations: [{ type: 'rename', path: 'a.js' }] }],
            ['an operation without a type', { actor: 'a', operations: [{ path: 'a.js', content: 'x' }] }],
            ['an empty path', { actor: 'a', operations: [{ type: 'write', path: '', content: 'x' }] }],
            ['an operation without a path', { actor: 'a', operations: [{ type: 'write', content: 'x' }] }],
            [
                'an unknown encoding',
                { actor: 'a', operations: [{ type: 'write', path: 'a', content: 'x', encoding: 'hex' }] },
            ],
            ['empty edits', { actor: 'a', operations: [{ type: 'edit', path: 'a.js', edits: [] }] }],
            [
                'an empty oldText',
                { actor: 'a', operations: [{ type: 'edit', path: 'a.js', edits: [{ oldText: '', newText: 'b' }] }] },
            ],
            [
                'an edit without newText',
                { actor: 'a', operations: [{ type: 'edit', path: 'a.js', edits: [{ oldText: 'a' }] }] },
            ],
        ])('rejects %s', (_, args) => {
            expect(validate(args)).toBe(false);
        });

        it('accepts no operations and an empty newText', () => {
            expect(validate({ actor: 'a', operations: [] })).toBe(true);
            expect(
                validate({
                    actor: 'a',
                    operations: [{ type: 'edit', path: 'a.js', edits: [{ oldText: 'a', newText: '' }] }],
                }),
            ).toBe(true);
        });
    });

    it('reports the revision get-actor-version returns after the write', async () => {
        const revisionBefore = await readRevision();
        const result = await callTool({
            expectedRevision: revisionBefore,
            operations: [{ type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH }],
        });
        mockFiles(...getPutFiles());

        expect(result.structuredContent.revision).not.toBe(revisionBefore);
        expect(result.structuredContent.revision).toBe(await readRevision());
    });

    it('returns the hashes and revision get-actor-version lists for the saved files', async () => {
        const icon = Buffer.from([0, 1, 2, 255]);
        const result = await callTool({
            operations: [
                edit('src/main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' }),
                write('assets/icon.png', icon.toString('base64')),
                write('README.md', Buffer.from('héllo\n').toString('base64'), { encoding: 'base64' }),
                remove('.actor/actor.json', sha256Prefix(ACTOR_JSON.content)),
            ],
        });
        mockFiles(...getPutFiles());
        const read = await readVersion({ paths: ['assets/icon.png', 'README.md'] });

        expect(result.structuredContent.revision).toBe(read.revision);
        const listedHashes = new Map(read.files.map(({ path, hash }) => [path, hash]));
        for (const change of result.structuredContent.changes) {
            expect(change.hash, change.path).toBe(listedHashes.get(change.path));
        }
        expect(result.structuredContent.changes.map(({ path, action }) => `${action} ${path}`)).toEqual([
            'deleted .actor/actor.json',
            'created README.md',
            'created assets/icon.png',
            'updated src/main.js',
        ]);
        // The base64 content decodes to exactly the bytes sent.
        expect(read.contents).toEqual([
            { path: 'assets/icon.png', content: icon.toString('base64'), encoding: 'base64' },
            { path: 'README.md', content: 'héllo\n', encoding: 'utf8' },
        ]);
    });

    describe('files left alone', () => {
        const readmeAsBase64 = {
            name: 'README.md',
            format: 'BASE64',
            content: Buffer.from('# Hi\n').toString('base64'),
        };
        // Stored without format, which the build worker reads as TEXT.
        const noFormat = { name: 'src/z.js', content: 'z();\n' };
        const nestedFolder = { name: 'src/empty', folder: true };

        it('sends every file it leaves alone back exactly as stored, before and after the changed one', async () => {
            mockFiles(
                MAIN_JS,
                FOLDER,
                readmeAsBase64,
                noFormat,
                EMPTY_INIT,
                ACTOR_JSON,
                NO_CONTENT,
                LOGO,
                nestedFolder,
            );

            const result = await callTool({
                operations: [edit('.actor/actor.json', { oldText: '1', newText: '2' })],
            });

            const actorJson = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 2}' };
            expect(versionUpdateMock.mock.calls).toStrictEqual([
                [
                    {
                        sourceType: 'SOURCE_FILES',
                        sourceFiles: [
                            FOLDER,
                            nestedFolder,
                            actorJson,
                            readmeAsBase64,
                            LOGO,
                            EMPTY_INIT,
                            NO_CONTENT,
                            MAIN_JS,
                            noFormat,
                        ],
                    },
                ],
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: '.actor/actor.json', action: 'updated', hash: sha256Prefix(actorJson.content) },
            ]);
        });

        it('sends back an entry stored under an unnormalized name as stored', async () => {
            const unnormalized = { name: './src//util.js', format: 'TEXT', content: 'util();\n' };
            mockFiles(unnormalized, MAIN_JS);

            await callTool({ operations: [remove('src/main.js', MAIN_JS_HASH)] });

            expect(getPutFiles()).toStrictEqual([unnormalized]);
        });

        it('sends a path stored twice back once, as the last entry, the one get-actor-version returns', async () => {
            const first = { name: 'src/a.js', format: 'TEXT', content: 'first();\n' };
            const last = { name: './src/a.js', format: 'TEXT', content: 'last();\n' };
            mockFiles(first, ACTOR_JSON, last);

            await callTool({ operations: [write('src/b.js', 'b();\n')] });

            expect(getPutFiles()).toStrictEqual([
                ACTOR_JSON,
                last,
                { name: 'src/b.js', format: 'TEXT', content: 'b();\n' },
            ]);
        });
    });

    describe('files stored under an unnormalized name or twice', () => {
        const UNNORMALIZED = { name: './src//util.js', format: 'TEXT', content: 'util();\n' };
        const UNNORMALIZED_HASH = sha256Prefix(UNNORMALIZED.content);
        const FIRST = { name: 'src/a.js', format: 'TEXT', content: 'first();\n' };
        const LAST = { name: './src/a.js', format: 'TEXT', content: 'last();\n' };
        const LAST_HASH = sha256Prefix(LAST.content);

        it('refuses a write without expectedHash to the path an unnormalized name stands for (FILE_EXISTS)', async () => {
            mockFiles(UNNORMALIZED, MAIN_JS);

            const text = await callToolExpectingUserError({ operations: [write('src/util.js', 'x')] });

            expect(text).toBe(
                `${failedWith(0, 'write', 'src/util.js', 'FILE_EXISTS')} ` +
                    `src/util.js exists with hash ${UNNORMALIZED_HASH}; pass that as expectedHash to replace it.`,
            );
        });

        it.each([
            [
                'replaces',
                write('src/util.js', 'x', { expectedHash: UNNORMALIZED_HASH }),
                [MAIN_JS, { name: 'src/util.js', format: 'TEXT', content: 'x' }],
            ],
            [
                'edits',
                edit('src/util.js', { oldText: 'util', newText: 'tool' }),
                [MAIN_JS, { name: 'src/util.js', format: 'TEXT', content: 'tool();\n' }],
            ],
            ['deletes', remove('src/util.js', UNNORMALIZED_HASH), [MAIN_JS]],
        ])(
            '%s a file stored under an unnormalized name, with no entry left under that name',
            async (_, operation, sourceFiles) => {
                mockFiles(UNNORMALIZED, MAIN_JS);

                await callTool({ operations: [operation] });

                expect(versionUpdateMock.mock.calls).toStrictEqual([[{ sourceType: 'SOURCE_FILES', sourceFiles }]]);
            },
        );

        it.each([
            [
                'replaces',
                write('src/a.js', 'x', { expectedHash: LAST_HASH }),
                [ACTOR_JSON, { name: 'src/a.js', format: 'TEXT', content: 'x' }],
            ],
            [
                'edits',
                edit('src/a.js', { oldText: 'last', newText: 'new' }),
                [ACTOR_JSON, { name: 'src/a.js', format: 'TEXT', content: 'new();\n' }],
            ],
            ['deletes', remove('src/a.js', LAST_HASH), [ACTOR_JSON]],
        ])(
            '%s a file stored twice by its last entry, with neither stored entry left',
            async (_, operation, sourceFiles) => {
                mockFiles(FIRST, ACTOR_JSON, LAST);

                await callTool({ operations: [operation] });

                expect(versionUpdateMock.mock.calls).toStrictEqual([[{ sourceType: 'SOURCE_FILES', sourceFiles }]]);
            },
        );

        it('compares expectedHash of a file stored twice with its last entry (HASH_MISMATCH)', async () => {
            mockFiles(FIRST, ACTOR_JSON, LAST);

            const text = await callToolExpectingUserError({
                operations: [remove('src/a.js', sha256Prefix(FIRST.content))],
            });

            expect(text).toBe(
                `${failedWith(0, 'delete', 'src/a.js', 'HASH_MISMATCH')} ` +
                    `src/a.js has hash ${LAST_HASH}, not ${sha256Prefix(FIRST.content)}.`,
            );
        });

        it('takes the revision get-actor-version returns for such a version, and sends no PUT when nothing changes', async () => {
            mockFiles(UNNORMALIZED, FIRST, ACTOR_JSON, LAST, EMPTY_INIT, NO_CONTENT, FOLDER);
            const revision = await readRevision();

            const unchanged = await callTool({ expectedRevision: revision, operations: [] });
            const rewritten = await callTool({
                expectedRevision: revision,
                operations: [write('src/util.js', UNNORMALIZED.content, { expectedHash: UNNORMALIZED_HASH })],
            });

            expect(unchanged.structuredContent).toEqual({ revision, changed: false, changes: [] });
            expect(rewritten.structuredContent).toEqual({ revision, changed: false, changes: [] });
            expect(versionUpdateMock).not.toHaveBeenCalled();

            const written = await callTool({ expectedRevision: revision, operations: [write('src/b.js', 'b')] });

            expect(written.structuredContent.changes).toEqual([
                { path: 'src/b.js', action: 'created', hash: sha256Prefix('b') },
            ]);
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it('treats an entry with folder false as a file', async () => {
            mockFiles({ name: 'src/x.js', folder: false, format: 'TEXT', content: 'x();\n' });

            const result = await callTool({ operations: [edit('src/x.js', { oldText: 'x()', newText: 'y()' })] });

            expect(getPutFiles()).toStrictEqual([{ name: 'src/x.js', format: 'TEXT', content: 'y();\n' }]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/x.js', action: 'updated', hash: sha256Prefix('y();\n') },
            ]);
        });
    });

    describe('PUT body', () => {
        it.each([
            ['write', write('src/new.js', 'x')],
            ['edit', edit('src/main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' })],
            ['delete', remove('src/main.js', MAIN_JS_HASH)],
        ])(
            'carries only sourceType and sourceFiles for a %s, whatever else the version holds',
            async (_, operation) => {
                mockVersionRead({
                    applyEnvVarsToBuild: true,
                    gitRepoUrl: 'https://github.com/john/old-repo.git',
                    tarballUrl: 'https://example.com/old-tarball.zip',
                    gitHubGistUrl: 'https://gist.github.com/john/old-gist',
                });

                const result = await callTool({ operations: [operation] });

                expect(versionUpdateMock).toHaveBeenCalledTimes(1);
                expect(versionUpdateMock.mock.calls[0]).toHaveLength(1);
                const [body] = versionUpdateMock.mock.calls[0] as [Record<string, unknown>];
                expect(Object.keys(body).sort()).toEqual(['sourceFiles', 'sourceType']);
                expect(body.sourceType).toBe('SOURCE_FILES');
                expect(JSON.stringify(body)).not.toMatch(/API_KEY|secret-value|latest|old-/);
                expect(JSON.stringify(result)).not.toMatch(/API_KEY|secret-value|old-/);
            },
        );

        it('goes to the resolved Actor ID and only the requested version', async () => {
            const mainV2 = { name: 'src/main.js', format: 'TEXT', content: 'console.log("v2");\n' };
            actorGetMock.mockResolvedValue({
                id: 'actor-7',
                name: 'my-actor',
                username: 'john',
                versions: [
                    mockVersion(),
                    mockVersion({ versionNumber: '0.2', buildTag: 'beta', sourceFiles: [mainV2] }),
                    mockVersion({ versionNumber: '0.3', sourceFiles: [ACTOR_JSON] }),
                ],
            });

            await callTool({
                versionNumber: '0.2',
                autoBuild: true,
                operations: [edit('src/main.js', { oldText: 'v2', newText: 'v2 fixed' })],
            });

            expect(actorMock.mock.calls).toEqual([['john/my-actor'], ['actor-7'], ['actor-7']]);
            expect(versionMock.mock.calls).toEqual([['0.2']]);
            expect(versionUpdateMock.mock.calls).toStrictEqual([
                [
                    {
                        sourceType: 'SOURCE_FILES',
                        sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("v2 fixed");\n' }],
                    },
                ],
            ]);
            expect(buildMock.mock.calls).toEqual([['0.2', { useCache: true }]]);
        });

        it('matches the version number as a string, so 0.10 is not 0.1', async () => {
            const mainV10 = { name: 'src/main.js', format: 'TEXT', content: 'console.log("v10");\n' };
            actorGetMock.mockResolvedValue({
                id: 'actor-1',
                name: 'my-actor',
                username: 'john',
                versions: [mockVersion(), mockVersion({ versionNumber: '0.10', sourceFiles: [mainV10] })],
            });

            await callTool({
                versionNumber: '0.10',
                operations: [edit('src/main.js', { oldText: 'v10', newText: 'v11' })],
            });

            expect(versionMock.mock.calls).toEqual([['0.10']]);
            expect(versionUpdateMock.mock.calls).toStrictEqual([
                [
                    {
                        sourceType: 'SOURCE_FILES',
                        sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("v11");\n' }],
                    },
                ],
            ]);
        });
    });

    describe('write', () => {
        it('refuses to replace an existing file without expectedHash (FILE_EXISTS)', async () => {
            const text = await callToolExpectingUserError({ operations: [write('src/main.js', MAIN_JS.content)] });

            expect(text).toBe(
                'Nothing was written: operations[0] (write src/main.js) failed with FILE_EXISTS. ' +
                    `src/main.js exists with hash ${MAIN_JS_HASH}; pass that as expectedHash to replace it.`,
            );
        });

        it('refuses a stale expectedHash (HASH_MISMATCH)', async () => {
            const text = await callToolExpectingUserError({
                operations: [write('src/main.js', 'new\n', { expectedHash: '0000000000000000' })],
            });

            expect(text).toBe(
                'Nothing was written: operations[0] (write src/main.js) failed with HASH_MISMATCH. ' +
                    `src/main.js has hash ${MAIN_JS_HASH}, not 0000000000000000.`,
            );
        });

        it('refuses expectedHash for a path with no file (FILE_NOT_FOUND)', async () => {
            const text = await callToolExpectingUserError({
                operations: [write('src/new.js', 'x', { expectedHash: MAIN_JS_HASH })],
            });

            expect(text).toBe(
                'Nothing was written: operations[0] (write src/new.js) failed with FILE_NOT_FOUND. There is no file at src/new.js.',
            );
        });

        it.each([
            ['lower', MAIN_JS_HASH],
            ['upper', MAIN_JS_HASH.toUpperCase()],
        ])('replaces a file given its current hash in %s case', async (_, expectedHash) => {
            const result = await callTool({ operations: [write('src/main.js', 'new\n', { expectedHash })] });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content: 'new\n' },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('new\n') },
            ]);
        });

        it('needs the hash of the file a path normalizes onto', async () => {
            const text = await callToolExpectingUserError({ operations: [write('./src/main.js', 'x')] });
            await callTool({ operations: [write('./src/main.js', 'x', { expectedHash: MAIN_JS_HASH })] });

            expect(text).toBe(
                `${failedWith(0, 'write', './src/main.js', 'FILE_EXISTS')} ` +
                    `src/main.js exists with hash ${MAIN_JS_HASH}; pass that as expectedHash to replace it.`,
            );
            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content: 'x' },
            ]);
        });

        it.each([
            ['assets/icon.png', undefined, 'BASE64'],
            ['assets/ICON.PNG', undefined, 'BASE64'],
            ['fonts/a.woff2', undefined, 'BASE64'],
            ['src/main.ts', undefined, 'TEXT'],
            ['assets/icon.svg', undefined, 'TEXT'],
            ['Dockerfile', undefined, 'TEXT'],
            ['assets/icon.png', 'utf8', 'TEXT'],
            ['README.md', 'base64', 'BASE64'],
        ])('stores a write to %s with encoding %s as %s, with the content as sent', async (path, encoding, format) => {
            const content = 'aGk=';

            await callTool({ operations: [write(path, content, encoding === undefined ? {} : { encoding })] });

            expect(getPutFiles().at(-1)).toStrictEqual({ name: path, format, content });
        });

        it('sends no PUT when the content is the same', async () => {
            const result = await callTool({
                operations: [write('assets/logo.png', LOGO.content, { expectedHash: sha256Prefix(LOGO_BYTES) })],
            });

            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent).toEqual({
                revision: await readRevision(),
                changed: false,
                changes: [],
            });
            expect(result.content[1].text).toContain(
                'Nothing changed in version 0.1 of john/my-actor, so nothing was written.',
            );
        });

        it('stores content for a binary extension as BASE64 by default, and text sent as base64 as BASE64', async () => {
            const icon = Buffer.from([1, 2, 3]).toString('base64');
            const readme = Buffer.from('hello\n').toString('base64');
            const result = await callTool({
                operations: [write('assets/icon.png', icon), write('README.md', readme, { encoding: 'base64' })],
            });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                MAIN_JS,
                { name: 'assets/icon.png', format: 'BASE64', content: icon },
                { name: 'README.md', format: 'BASE64', content: readme },
            ]);
            expect(result.structuredContent.changes).toContainEqual({
                path: 'assets/icon.png',
                action: 'created',
                hash: sha256Prefix(Buffer.from([1, 2, 3])),
            });
        });

        it('stores a write with no encoding over a UTF-8 file stored as BASE64 as TEXT, with the content as sent', async () => {
            const readme = { name: 'README.md', format: 'BASE64', content: Buffer.from('# Hi\n').toString('base64') };
            mockFiles(readme, MAIN_JS);

            const result = await callTool({
                operations: [write('README.md', '# Bye\n', { expectedHash: sha256Prefix('# Hi\n') })],
            });

            expect(getPutFiles()).toStrictEqual([{ name: 'README.md', format: 'TEXT', content: '# Bye\n' }, MAIN_JS]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'README.md', action: 'updated', hash: sha256Prefix('# Bye\n') },
            ]);
        });

        it.each([
            ['no encoding', {}],
            ['encoding utf8', { encoding: 'utf8' }],
        ])('stores text sent with %s byte for byte', async (_, extra) => {
            const content = '\uFEFFline one  \r\nn\u00e1zev = "🙂"\n\tend\r';

            const result = await callTool({ operations: [write('src/win.js', content, extra)] });

            expect(getPutFiles().at(-1)).toStrictEqual({ name: 'src/win.js', format: 'TEXT', content });
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/win.js', action: 'created', hash: sha256Prefix(Buffer.from(content)) },
            ]);
        });

        it('stores a non-ASCII path as sent, with the revision get-actor-version reads, and takes its NFD form as another file', async () => {
            const nfcPath = 'src/název.js';
            const nfdPath = 'src/název.js';
            mockFiles(MAIN_JS);

            const result = await callTool({ operations: [write(nfcPath, 'x')] });
            const putFiles = getPutFiles();
            mockFiles(...putFiles);

            expect(putFiles).toStrictEqual([MAIN_JS, { name: nfcPath, format: 'TEXT', content: 'x' }]);
            expect(result.structuredContent.revision).toBe(await readRevision());

            versionUpdateMock.mockClear();
            const nfd = await callTool({ operations: [write(nfdPath, 'y')] });

            expect(getPutFiles()).toStrictEqual([...putFiles, { name: nfdPath, format: 'TEXT', content: 'y' }]);
            expect(nfd.structuredContent.changes).toEqual([
                { path: nfdPath, action: 'created', hash: sha256Prefix('y') },
            ]);
        });

        it('writes the first file of a version with no files', async () => {
            mockFiles();

            const result = await callTool({ operations: [write('a.js', 'a')] });

            expect(versionUpdateMock.mock.calls).toStrictEqual([
                [{ sourceType: 'SOURCE_FILES', sourceFiles: [{ name: 'a.js', format: 'TEXT', content: 'a' }] }],
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'a.js', action: 'created', hash: sha256Prefix('a') },
            ]);
        });

        it('saves an empty file and warns that the build skips it', async () => {
            const result = await callTool({ operations: [write('src/__init__.py', '')] });

            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                MAIN_JS,
                { name: 'src/__init__.py', format: 'TEXT', content: '' },
            ]);
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: src/__init__.py.',
            ]);
        });

        it('saves every empty file, and warns about the ones the call leaves empty, not the ones it leaves alone', async () => {
            mockFiles(ACTOR_JSON, MAIN_JS, EMPTY_INIT, NO_CONTENT);

            const result = await callTool({
                operations: [
                    edit('src/main.js', { oldText: MAIN_JS.content, newText: '' }),
                    write('assets/blank.png', ''),
                ],
            });

            expect(getPutFiles()).toStrictEqual([
                ACTOR_JSON,
                EMPTY_INIT,
                NO_CONTENT,
                { name: 'src/main.js', format: 'TEXT', content: '' },
                { name: 'assets/blank.png', format: 'BASE64', content: '' },
            ]);
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: assets/blank.png, src/main.js.',
            ]);
        });

        it('gives no warning when no file is left empty', async () => {
            const result = await callTool({ operations: [write('src/b.js', 'b')] });

            expect(result.structuredContent).not.toHaveProperty('warnings');
        });
    });

    describe('edit', () => {
        it('applies edits in order, each to the text the previous one left', async () => {
            const result = await callTool({
                operations: [
                    edit(
                        'src/main.js',
                        { oldText: 'const a = 1;', newText: 'const a = 2;' },
                        { oldText: 'a = 2', newText: 'a = 3' },
                    ),
                ],
            });

            const content = 'const a = 3;\nconsole.log(a);\nexport {};\n';
            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix(content) },
            ]);
        });

        it('keeps every edit of an operation that changes different parts of the file', async () => {
            const result = await callTool({
                operations: [
                    edit(
                        'src/main.js',
                        { oldText: 'const a = 1;', newText: 'const a = 22;' },
                        { oldText: 'export {};', newText: 'export { a };' },
                    ),
                ],
            });

            const content = 'const a = 22;\nconsole.log(a);\nexport { a };\n';
            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix(content) },
            ]);
        });

        it('inserts newText as given, with no replacement patterns', async () => {
            await callTool({
                operations: [edit('src/main.js', { oldText: 'const a = 1;', newText: "$&|$1|$$|$'|$`|$<a>" })],
            });

            expect(getPutFiles()).toContainEqual({
                name: 'src/main.js',
                format: 'TEXT',
                content: "$&|$1|$$|$'|$`|$<a>\nconsole.log(a);\nexport {};\n",
            });
        });

        it.each([
            ['at the start of the file', 'const a', 'let a', 'let a = 1;\nconsole.log(a);\nexport {};\n'],
            [
                'at the end of the file',
                'export {};\n',
                'export { a };\n',
                'const a = 1;\nconsole.log(a);\nexport { a };\n',
            ],
            ['equal to the whole file', MAIN_JS.content, 'x\n', 'x\n'],
        ])('replaces an oldText %s', async (_, oldText, newText, content) => {
            await callTool({ operations: [edit('src/main.js', { oldText, newText })] });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content },
            ]);
        });

        it('reports the edit of an operation that no longer matches after the edits before it', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    edit(
                        'src/main.js',
                        { oldText: 'const a = 1;', newText: 'const a = 2;' },
                        { oldText: 'const a = 1;', newText: 'const a = 3;' },
                    ),
                ],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'src/main.js', 'NO_MATCH')} oldText of edits[1] is not in the file.`,
            );
        });

        it.each([
            ['});\n});\n});\n', '});\n});'],
            ['aaa\n', 'aa'],
        ])('reports an oldText whose matches overlap in %j (MULTIPLE_MATCHES)', async (content, oldText) => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content });

            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText, newText: '' })],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'src/main.js', 'MULTIPLE_MATCHES')} ` +
                    'oldText of edits[0] matches more than once; add surrounding lines so it matches once.',
            );
        });

        it('reports an oldText that the edits before it made match twice (MULTIPLE_MATCHES)', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    edit(
                        'src/main.js',
                        { oldText: 'export {};', newText: 'console.log(a);\nexport {};' },
                        { oldText: 'console.log(a);', newText: 'console.log(b);' },
                    ),
                ],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'src/main.js', 'MULTIPLE_MATCHES')} ` +
                    'oldText of edits[1] matches more than once; add surrounding lines so it matches once.',
            );
        });

        it('applies an oldText that matched twice before the edits before it removed one match', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'a();\nx();\nb();\nx();\n' });

            await callTool({
                operations: [
                    edit(
                        'src/main.js',
                        { oldText: 'b();\nx();\n', newText: 'b();\n' },
                        { oldText: 'x();', newText: 'y();' },
                    ),
                ],
            });

            expect(getPutFiles()).toStrictEqual([
                { name: 'src/main.js', format: 'TEXT', content: 'a();\ny();\nb();\n' },
            ]);
        });

        it('edits a file with a binary extension stored as TEXT', async () => {
            mockFiles({ name: 'data/notes.dat', format: 'TEXT', content: 'a=1\n' });

            await callTool({ operations: [edit('data/notes.dat', { oldText: 'a=1', newText: 'a=2' })] });

            expect(getPutFiles()).toStrictEqual([{ name: 'data/notes.dat', format: 'TEXT', content: 'a=2\n' }]);
        });

        it('refuses to edit a BASE64 file with a binary extension even when its bytes are UTF-8 (NOT_TEXT)', async () => {
            mockFiles({ name: 'assets/x.png', format: 'BASE64', content: Buffer.from('hello').toString('base64') });

            const text = await callToolExpectingUserError({
                operations: [edit('assets/x.png', { oldText: 'hello', newText: 'bye' })],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'assets/x.png', 'NOT_TEXT')} assets/x.png is not UTF-8 text; replace it with a write.`,
            );
        });

        it('edits a file at a path that normalizes onto it', async () => {
            await callTool({
                operations: [edit('./src//main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' })],
            });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content: 'const a = 2;\nconsole.log(a);\nexport {};\n' },
            ]);
        });

        it('reports an oldText that is not in the file (NO_MATCH)', async () => {
            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText: 'zzz', newText: 'y' })],
            });

            expect(text).toBe(
                'Nothing was written: operations[0] (edit src/main.js) failed with NO_MATCH. oldText of edits[0] is not in the file.',
            );
        });

        it('reports an oldText that matches more than once (MULTIPLE_MATCHES)', async () => {
            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText: 'a', newText: 'b' })],
            });

            expect(text).toBe(
                'Nothing was written: operations[0] (edit src/main.js) failed with MULTIPLE_MATCHES. ' +
                    'oldText of edits[0] matches more than once; add surrounding lines so it matches once.',
            );
        });

        it('retries an LF oldText as CRLF in a file with only CRLF line breaks', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\r\nthree\r\n' });

            await callTool({ operations: [edit('src/main.js', { oldText: 'one\ntwo\n', newText: '1\n2\n' })] });

            expect(getPutFiles()).toEqual([{ name: 'src/main.js', format: 'TEXT', content: '1\r\n2\r\nthree\r\n' }]);
        });

        it('converts LF in newText to CRLF on the retry, and keeps the CRLF already in it', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\r\nthree\r\n' });

            await callTool({ operations: [edit('src/main.js', { oldText: 'two\nthree', newText: 'a\r\nb\nc' })] });

            expect(getPutFiles()).toEqual([{ name: 'src/main.js', format: 'TEXT', content: 'one\r\na\r\nb\r\nc\r\n' }]);
        });

        it('requires a retried oldText to match once', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'a\r\nb\r\na\r\nb\r\n' });

            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText: 'a\nb', newText: 'x' })],
            });

            expect(text).toContain(failedWith(0, 'edit', 'src/main.js', 'MULTIPLE_MATCHES'));
        });

        it('does not retry an oldText that matches as given in a file with only CRLF line breaks', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\r\n' });

            await callTool({ operations: [edit('src/main.js', { oldText: '\ntwo', newText: 'X' })] });

            // Byte for byte: the CR before the matched LF stays.
            expect(getPutFiles()).toEqual([{ name: 'src/main.js', format: 'TEXT', content: 'one\rX\r\n' }]);
        });

        it('does not retry an oldText without a line break, so LF in its newText stays LF', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\r\n' });

            await callTool({ operations: [edit('src/main.js', { oldText: 'two', newText: 'two\nmore' })] });

            expect(getPutFiles()).toEqual([{ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\nmore\r\n' }]);
        });

        it('does not retry an oldText that has a CR', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\r\n' });

            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText: 'one\r\ntwo\n', newText: 'x' })],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'src/main.js', 'NO_MATCH')} oldText of edits[0] is not in the file.`,
            );
        });

        it('does not convert line endings in a file with mixed line endings', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\nthree\r\n' });

            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText: 'one\ntwo', newText: 'x' })],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'src/main.js', 'NO_MATCH')} oldText of edits[0] is not in the file.`,
            );
        });

        it('keeps a UTF-8 file stored as BASE64 in BASE64', async () => {
            mockFiles({ name: 'src/data.txt', format: 'BASE64', content: Buffer.from('hello\n').toString('base64') });

            await callTool({ operations: [edit('src/data.txt', { oldText: 'hello', newText: 'bye' })] });

            expect(getPutFiles()).toEqual([
                { name: 'src/data.txt', format: 'BASE64', content: Buffer.from('bye\n').toString('base64') },
            ]);
        });

        it('stores the exact UTF-8 bytes of an edited BASE64 file, byte order mark included', async () => {
            const before = Buffer.from('﻿název = "č"\n');
            mockFiles({ name: 'src/data.txt', format: 'BASE64', content: before.toString('base64') });

            const result = await callTool({ operations: [edit('src/data.txt', { oldText: 'č', newText: '🙂' })] });

            const after = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('název = "🙂"\n')]);
            expect(getPutFiles()).toEqual([
                { name: 'src/data.txt', format: 'BASE64', content: after.toString('base64') },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/data.txt', action: 'updated', hash: sha256Prefix(after) },
            ]);
        });

        it('refuses to edit a file with a text extension whose bytes are not UTF-8 (NOT_TEXT)', async () => {
            mockFiles({
                name: 'src/data.txt',
                format: 'BASE64',
                content: Buffer.from([0xff, 0xfe, 0x41]).toString('base64'),
            });

            const text = await callToolExpectingUserError({
                operations: [edit('src/data.txt', { oldText: 'A', newText: 'B' })],
            });

            expect(text).toBe(
                `${failedWith(0, 'edit', 'src/data.txt', 'NOT_TEXT')} src/data.txt is not UTF-8 text; replace it with a write.`,
            );
        });

        it('refuses to edit a binary file (NOT_TEXT)', async () => {
            const text = await callToolExpectingUserError({
                operations: [edit('assets/logo.png', { oldText: 'PNG', newText: 'x' })],
            });

            expect(text).toBe(
                'Nothing was written: operations[0] (edit assets/logo.png) failed with NOT_TEXT. ' +
                    'assets/logo.png is not UTF-8 text; replace it with a write.',
            );
        });

        it('refuses to edit a missing file (FILE_NOT_FOUND)', async () => {
            const text = await callToolExpectingUserError({
                operations: [edit('src/none.js', { oldText: 'a', newText: 'b' })],
            });

            expect(text).toContain('(edit src/none.js) failed with FILE_NOT_FOUND. There is no file at src/none.js.');
        });
    });

    describe('delete', () => {
        it('deletes a file given its hash', async () => {
            const result = await callTool({
                operations: [{ type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH }],
            });

            expect(getPutFiles()).toStrictEqual([FOLDER, ACTOR_JSON, LOGO]);
            // No other key: a deleted file is not named as an empty one.
            expect(result.structuredContent).toStrictEqual({
                revision: expect.stringMatching(/^[0-9a-f]{16}$/),
                changed: true,
                changes: [{ path: 'src/main.js', action: 'deleted' }],
            });
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
        });

        it('deletes the last file, leaving no files and the folder entries', async () => {
            mockFiles(MAIN_JS, FOLDER);

            const result = await callTool({ operations: [remove('src/main.js', MAIN_JS_HASH)] });

            expect(versionUpdateMock.mock.calls).toStrictEqual([
                [{ sourceType: 'SOURCE_FILES', sourceFiles: [FOLDER] }],
            ]);
            expect(result.structuredContent.changes).toEqual([{ path: 'src/main.js', action: 'deleted' }]);

            mockFiles(MAIN_JS);
            versionUpdateMock.mockClear();
            await callTool({ operations: [remove('src/main.js', MAIN_JS_HASH)] });

            expect(versionUpdateMock.mock.calls).toStrictEqual([[{ sourceType: 'SOURCE_FILES', sourceFiles: [] }]]);
        });

        it('refuses a stale hash (HASH_MISMATCH) and a missing file (FILE_NOT_FOUND)', async () => {
            const stale = await callToolExpectingUserError({
                operations: [{ type: 'delete', path: 'src/main.js', expectedHash: 'ffffffffffffffff' }],
            });
            const missing = await callToolExpectingUserError({
                operations: [{ type: 'delete', path: 'src/none.js', expectedHash: MAIN_JS_HASH }],
            });

            expect(stale).toBe(
                `${failedWith(0, 'delete', 'src/main.js', 'HASH_MISMATCH')} src/main.js has hash ${MAIN_JS_HASH}, not ffffffffffffffff.`,
            );
            expect(missing).toBe(
                `${failedWith(0, 'delete', 'src/none.js', 'FILE_NOT_FOUND')} There is no file at src/none.js.`,
            );
        });

        it('deletes a file given its hash in upper case', async () => {
            await callTool({ operations: [remove('src/main.js', MAIN_JS_HASH.toUpperCase())] });

            expect(getPutFiles()).toStrictEqual([FOLDER, ACTOR_JSON, LOGO]);
        });

        it('renames a file with a delete and a write', async () => {
            const result = await callTool({
                operations: [
                    { type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH },
                    write('src/index.js', MAIN_JS.content),
                ],
            });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/index.js', format: 'TEXT', content: MAIN_JS.content },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/index.js', action: 'created', hash: MAIN_JS_HASH },
                { path: 'src/main.js', action: 'deleted' },
            ]);
        });
    });

    describe('operation order', () => {
        const editedMainJs = 'const a = 2;\nconsole.log(a);\nexport {};\n';
        const editMainJs = edit('src/main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' });

        it('edits a file an earlier write created or replaced, with no hash for the edit', async () => {
            const result = await callTool({
                operations: [
                    write('src/new.js', 'hello\n'),
                    edit('src/new.js', { oldText: 'hello', newText: 'bye' }),
                    write('src/main.js', 'x = 1;\n', { expectedHash: MAIN_JS_HASH }),
                    edit('src/main.js', { oldText: '1', newText: '2' }),
                ],
            });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content: 'x = 2;\n' },
                { name: 'src/new.js', format: 'TEXT', content: 'bye\n' },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('x = 2;\n') },
                { path: 'src/new.js', action: 'created', hash: sha256Prefix('bye\n') },
            ]);
        });

        it('applies an edit operation to the text an earlier edit operation on the file left', async () => {
            const stale = await callToolExpectingUserError({
                operations: [editMainJs, edit('src/main.js', { oldText: 'const a = 1;', newText: 'const a = 3;' })],
            });
            const result = await callTool({
                operations: [editMainJs, edit('src/main.js', { oldText: 'const a = 2;', newText: 'const a = 3;' })],
            });

            const content = 'const a = 3;\nconsole.log(a);\nexport {};\n';
            expect(getPutFiles()).toContainEqual({ name: 'src/main.js', format: 'TEXT', content });
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix(content) },
            ]);
            expect(stale).toBe(
                `${failedWith(1, 'edit', 'src/main.js', 'NO_MATCH')} oldText of edits[0] is not in the file.`,
            );
        });

        it('compares the hash of a delete after an edit with the edited file', async () => {
            const stale = await callToolExpectingUserError({
                operations: [editMainJs, remove('src/main.js', MAIN_JS_HASH)],
            });
            const result = await callTool({
                operations: [editMainJs, remove('src/main.js', sha256Prefix(editedMainJs))],
            });

            expect(stale).toBe(
                `${failedWith(1, 'delete', 'src/main.js', 'HASH_MISMATCH')} ` +
                    `src/main.js has hash ${sha256Prefix(editedMainJs)}, not ${MAIN_JS_HASH}.`,
            );
            expect(getPutFiles()).toStrictEqual([FOLDER, ACTOR_JSON, LOGO]);
            expect(result.structuredContent.changes).toEqual([{ path: 'src/main.js', action: 'deleted' }]);
        });

        it('takes a write after a delete of the same path as a new file, which needs no hash', async () => {
            const withHash = await callToolExpectingUserError({
                operations: [
                    remove('src/main.js', MAIN_JS_HASH),
                    write('src/main.js', 'new\n', { expectedHash: MAIN_JS_HASH }),
                ],
            });
            const result = await callTool({
                operations: [remove('src/main.js', MAIN_JS_HASH), write('src/main.js', 'new\n')],
            });

            expect(withHash).toBe(
                `${failedWith(1, 'write', 'src/main.js', 'FILE_NOT_FOUND')} There is no file at src/main.js.`,
            );
            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                LOGO,
                { name: 'src/main.js', format: 'TEXT', content: 'new\n' },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('new\n') },
            ]);
        });

        it('compares the hash of a second write with the content of the first', async () => {
            const stale = await callToolExpectingUserError({
                operations: [
                    write('src/main.js', 'v1\n', { expectedHash: MAIN_JS_HASH }),
                    write('src/main.js', 'v2\n', { expectedHash: MAIN_JS_HASH }),
                ],
            });
            const exists = await callToolExpectingUserError({
                operations: [write('src/new.js', 'v1\n'), write('src/new.js', 'v2\n')],
            });
            await callTool({
                operations: [
                    write('src/main.js', 'v1\n', { expectedHash: MAIN_JS_HASH }),
                    write('src/main.js', 'v2\n', { expectedHash: sha256Prefix('v1\n') }),
                ],
            });

            expect(stale).toBe(
                `${failedWith(1, 'write', 'src/main.js', 'HASH_MISMATCH')} ` +
                    `src/main.js has hash ${sha256Prefix('v1\n')}, not ${MAIN_JS_HASH}.`,
            );
            expect(exists).toBe(
                `${failedWith(1, 'write', 'src/new.js', 'FILE_EXISTS')} ` +
                    `src/new.js exists with hash ${sha256Prefix('v1\n')}; pass that as expectedHash to replace it.`,
            );
            expect(getPutFiles()).toContainEqual({ name: 'src/main.js', format: 'TEXT', content: 'v2\n' });
        });
    });

    describe('input', () => {
        it.each(['/src/main.js', '..', '../x.js', 'src/../../x.js', 'a/../..'])(
            'refuses a write to %s, outside the Actor root, which the build refuses',
            async (path) => {
                const text = await callToolExpectingUserError({ autoBuild: true, operations: [write(path, 'x')] });

                expect(text).toBe(
                    `operations[0] (write ${path}) has a path outside the Actor root; give one relative to it, such as src/main.js.`,
                );
                expect(buildMock).not.toHaveBeenCalled();
            },
        );

        it.each(['.', './', 'src/', 'src//', 'src/..'])('refuses a write to %s, which names a folder', async (path) => {
            const text = await callToolExpectingUserError({ autoBuild: true, operations: [write(path, 'x')] });

            expect(text).toBe(`operations[0] (write ${path}) has a path that names a folder, not a file.`);
            expect(buildMock).not.toHaveBeenCalled();
        });

        it.each([
            ['storage', 'storage'],
            ['src', 'src/main.js'],
            ['src/main.js/inner.js', 'src/main.js'],
            ['assets/logo.png/x', 'assets/logo.png'],
        ])(
            'refuses a write to %s, which collides with %s, since a path cannot be both a file and a folder',
            async (path, collision) => {
                const text = await callToolExpectingUserError({ autoBuild: true, operations: [write(path, 'x')] });

                expect(text).toBe(
                    `operations[0] (write ${path}) collides with ${collision}; one path cannot be both a file and a folder.`,
                );
                expect(buildMock).not.toHaveBeenCalled();
            },
        );

        it('refuses a write under a file an earlier write created', async () => {
            const text = await callToolExpectingUserError({
                operations: [write('lib', 'x'), write('lib/util.js', 'y')],
            });

            expect(text).toBe(
                'operations[1] (write lib/util.js) collides with lib; one path cannot be both a file and a folder.',
            );
        });

        it('refuses a write to a folder stored with a trailing slash, and to a parent of a nested folder', async () => {
            mockFiles({ name: 'cache/', folder: true }, { name: 'data/raw', folder: true }, MAIN_JS);

            const cache = await callToolExpectingUserError({ operations: [write('cache', 'x')] });
            const data = await callToolExpectingUserError({ operations: [write('data', 'x')] });

            expect(cache).toBe(
                'operations[0] (write cache) collides with cache/; one path cannot be both a file and a folder.',
            );
            expect(data).toBe(
                'operations[0] (write data) collides with data/raw; one path cannot be both a file and a folder.',
            );
        });

        it('writes a file into a folder entry, and where a file deleted in the same call held a folder', async () => {
            await callTool({
                operations: [
                    write('storage/input.json', '{}'),
                    remove('src/main.js', MAIN_JS_HASH),
                    write('src', 'x'),
                    remove('assets/logo.png', sha256Prefix(LOGO_BYTES)),
                    write('assets/logo.png/readme.txt', 'y'),
                ],
            });

            expect(getPutFiles()).toStrictEqual([
                FOLDER,
                ACTOR_JSON,
                { name: 'storage/input.json', format: 'TEXT', content: '{}' },
                { name: 'src', format: 'TEXT', content: 'x' },
                { name: 'assets/logo.png/readme.txt', format: 'TEXT', content: 'y' },
            ]);
        });

        it('refuses to delete or edit a folder (FILE_NOT_FOUND)', async () => {
            const deleted = await callToolExpectingUserError({ operations: [remove('storage', MAIN_JS_HASH)] });
            const edited = await callToolExpectingUserError({
                operations: [edit('storage', { oldText: 'a', newText: 'b' })],
            });

            expect(deleted).toBe(
                `${failedWith(0, 'delete', 'storage', 'FILE_NOT_FOUND')} There is no file at storage.`,
            );
            expect(edited).toBe(`${failedWith(0, 'edit', 'storage', 'FILE_NOT_FOUND')} There is no file at storage.`);
        });

        it.each([
            ['an edit', edit('/src/main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' })],
            ['a delete', remove('/src/main.js', MAIN_JS_HASH)],
        ])('takes the path of %s with a leading slash as written, so it finds no file', async (_, operation) => {
            const text = await callToolExpectingUserError({ operations: [operation] });

            expect(text).toBe(
                `${failedWith(0, operation.type, '/src/main.js', 'FILE_NOT_FOUND')} There is no file at /src/main.js.`,
            );
        });

        it('deletes a stored file outside the Actor root, so such a file can be removed', async () => {
            const outside = { name: '/src/main.js', format: 'TEXT', content: 'x' };
            mockFiles(outside, MAIN_JS);

            await callTool({ operations: [remove('/src/main.js', sha256Prefix('x'))] });

            expect(getPutFiles()).toStrictEqual([MAIN_JS]);
        });

        it('matches a path the way get-actor-version lists it', async () => {
            const result = await callTool({
                operations: [{ type: 'delete', path: './src//main.js', expectedHash: MAIN_JS_HASH }],
            });

            expect(getPutFiles()).toStrictEqual([FOLDER, ACTOR_JSON, LOGO]);
            expect(result.structuredContent.changes).toEqual([{ path: 'src/main.js', action: 'deleted' }]);
        });

        it.each([
            [write('a.js', 'a', { content: undefined }), 'content'],
            [{ type: 'edit', path: 'a.js' }, 'edits'],
            [{ type: 'delete', path: 'a.js' }, 'expectedHash'],
        ])('refuses %j without the field its type needs', async (operation, field) => {
            const text = await callToolExpectingUserError({ operations: [operation] });

            expect(text).toBe(`operations[0] (${operation.type} a.js) needs ${field}.`);
        });

        it('writes nothing when the third operation fails', async () => {
            const text = await callToolExpectingUserError({
                autoBuild: true,
                operations: [
                    write('src/a.js', 'a'),
                    edit('src/main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' }),
                    { type: 'delete', path: 'src/none.js', expectedHash: MAIN_JS_HASH },
                ],
            });

            expect(text).toContain(
                'Nothing was written: operations[2] (delete src/none.js) failed with FILE_NOT_FOUND.',
            );
            expect(buildMock).not.toHaveBeenCalled();
        });

        const failingOperations = [
            { reason: 'FILE_EXISTS', operation: write('src/main.js', 'x') },
            { reason: 'FILE_NOT_FOUND', operation: remove('src/none.js', MAIN_JS_HASH) },
            { reason: 'HASH_MISMATCH', operation: remove('src/main.js', '0000000000000000') },
            { reason: 'NO_MATCH', operation: edit('src/main.js', { oldText: 'zzz', newText: 'y' }) },
            { reason: 'MULTIPLE_MATCHES', operation: edit('src/main.js', { oldText: 'a', newText: 'b' }) },
            { reason: 'NOT_TEXT', operation: edit('assets/logo.png', { oldText: 'PNG', newText: 'x' }) },
        ];
        it.each(
            failingOperations.flatMap(({ reason, operation }) =>
                ['first', 'middle', 'last'].map((position, index) => ({ reason, operation, position, index })),
            ),
        )(
            'writes nothing and starts no build when the $position operation fails with $reason',
            async ({ reason, operation, index }) => {
                const operations: Record<string, unknown>[] = [
                    write('src/a.js', 'a'),
                    edit('.actor/actor.json', { oldText: '1', newText: '2' }),
                ];
                operations.splice(index, 0, operation);

                const text = await callToolExpectingUserError({ autoBuild: true, operations });

                const prefix = `${failedWith(index, operation.type, operation.path, reason)} `;
                expect(text.startsWith(prefix), text).toBe(true);
                expect(actorGetMock).toHaveBeenCalledTimes(1);
                expect(versionMock).not.toHaveBeenCalled();
                expect(buildMock).not.toHaveBeenCalled();
            },
        );

        it('writes nothing and starts no build when expectedRevision does not match', async () => {
            const text = await callToolExpectingUserError({
                autoBuild: true,
                expectedRevision: 'aaaaaaaaaaaaaaaa',
                operations: [write('b.js', 'b')],
            });

            expect(text).toContain('Nothing was written: expectedRevision failed with REVISION_MISMATCH.');
            expect(versionMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('reports REVISION_MISMATCH before an operation that would fail', async () => {
            const revision = await readRevision();

            const text = await callToolExpectingUserError({
                expectedRevision: 'aaaaaaaaaaaaaaaa',
                operations: [write('src/main.js', 'x'), remove('src/none.js', MAIN_JS_HASH)],
            });

            expect(text).toBe(
                'Nothing was written: expectedRevision failed with REVISION_MISMATCH. ' +
                    `The version's revision is ${revision}, not aaaaaaaaaaaaaaaa.`,
            );
        });

        it('sends no PUT for no operations', async () => {
            const result = await callTool({ operations: [] });

            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent).toEqual({ revision: await readRevision(), changed: false, changes: [] });
            expect(result.content[1].text).toBe(
                'Nothing changed in version 0.1 of john/my-actor, so nothing was written.\nRuns use these files once the version is built.',
            );
        });

        it.each([
            [
                'edits that undo each other',
                [
                    edit('src/main.js', { oldText: 'const a = 1;', newText: 'const a = 2;' }),
                    edit('src/main.js', { oldText: 'const a = 2;', newText: 'const a = 1;' }),
                ],
            ],
            [
                'a delete and a write of the same content',
                [remove('src/main.js', MAIN_JS_HASH), write('src/main.js', MAIN_JS.content)],
            ],
            ['a write and a delete of a new file', [write('src/tmp.js', 'x'), remove('src/tmp.js', sha256Prefix('x'))]],
        ])('sends no PUT for %s', async (_, operations) => {
            const result = await callTool({ operations });

            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent).toEqual({ revision: await readRevision(), changed: false, changes: [] });
        });

        it('refuses a stale expectedRevision (REVISION_MISMATCH) and takes a current one in either case', async () => {
            const revision = await readRevision();
            const text = await callToolExpectingUserError({
                expectedRevision: 'aaaaaaaaaaaaaaaa',
                operations: [write('b.js', 'b')],
            });
            await callTool({ expectedRevision: revision.toUpperCase(), operations: [write('b.js', 'b')] });

            expect(text).toBe(
                'Nothing was written: expectedRevision failed with REVISION_MISMATCH. ' +
                    `The version's revision is ${revision}, not aaaaaaaaaaaaaaaa.`,
            );
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it.each<[string, (revision: string) => string]>([
            ['an empty expectedRevision', () => ''],
            ['the first 8 characters of the revision', (revision) => revision.slice(0, 8)],
        ])('refuses %s, since it must match the whole revision (REVISION_MISMATCH)', async (_, getExpectedRevision) => {
            const revision = await readRevision();
            const expectedRevision = getExpectedRevision(revision);

            const text = await callToolExpectingUserError({
                autoBuild: true,
                expectedRevision,
                operations: [write('b.js', 'b')],
            });

            expect(text).toBe(
                'Nothing was written: expectedRevision failed with REVISION_MISMATCH. ' +
                    `The version's revision is ${revision}, not ${expectedRevision}.`,
            );
            expect(buildMock).not.toHaveBeenCalled();
        });

        const hashPrefix = MAIN_JS_HASH.slice(0, 8);
        it.each([
            ['write', 'an empty expectedHash', '', write('src/main.js', 'x', { expectedHash: '' })],
            ['delete', 'an empty expectedHash', '', remove('src/main.js', '')],
            [
                'write',
                "the first 8 characters of the file's hash",
                hashPrefix,
                write('src/main.js', 'x', { expectedHash: hashPrefix }),
            ],
            ['delete', "the first 8 characters of the file's hash", hashPrefix, remove('src/main.js', hashPrefix)],
        ])(
            'refuses a %s given %s, since it must match the whole hash (HASH_MISMATCH)',
            async (type, _, expectedHash, operation) => {
                const text = await callToolExpectingUserError({ autoBuild: true, operations: [operation] });

                expect(text).toBe(
                    `${failedWith(0, type, 'src/main.js', 'HASH_MISMATCH')} ` +
                        `src/main.js has hash ${MAIN_JS_HASH}, not ${expectedHash}.`,
                );
                expect(buildMock).not.toHaveBeenCalled();
            },
        );

        it('computes the revision over the files only', async () => {
            const result = await callTool({ operations: [] });

            expect(result.structuredContent.revision).toBe(
                buildFilesRevision([
                    { path: '.actor/actor.json', hash: sha256Prefix(ACTOR_JSON.content) },
                    { path: 'src/main.js', hash: MAIN_JS_HASH },
                    { path: 'assets/logo.png', hash: sha256Prefix(LOGO_BYTES) },
                ]),
            );
        });
    });

    describe('Actor and version', () => {
        it('needs versionNumber when the Actor has several versions', async () => {
            actorGetMock.mockResolvedValue({
                id: 'actor-1',
                name: 'my-actor',
                username: 'john',
                versions: [mockVersion(), mockVersion({ versionNumber: '0.2', buildTag: 'beta' })],
            });

            const text = await callToolExpectingUserError({ operations: [write('a.js', 'a')] });

            expect(text).toBe(
                'Specify versionNumber; this Actor has versions: 0.1 (SOURCE_FILES, build tag latest), 0.2 (SOURCE_FILES, build tag beta).',
            );
        });

        it('lists only the versions that have a number when versionNumber is needed', async () => {
            actorGetMock.mockResolvedValue({
                id: 'actor-1',
                name: 'my-actor',
                username: 'john',
                versions: [
                    mockVersion(),
                    { sourceType: 'SOURCE_FILES', sourceFiles: [MAIN_JS] },
                    mockVersion({ versionNumber: '0.2', sourceType: 'GIT_REPO', buildTag: undefined }),
                ],
            });

            const text = await callToolExpectingUserError({ operations: [write('a.js', 'a')] });

            expect(text).toBe(
                'Specify versionNumber; this Actor has versions: 0.1 (SOURCE_FILES, build tag latest), 0.2 (GIT_REPO).',
            );
        });

        it.each([
            ['no versions', []],
            ['only a version without a number', [{ sourceType: 'SOURCE_FILES', sourceFiles: [MAIN_JS] }]],
        ])('needs versionNumber when the Actor has %s', async (_, versions) => {
            actorGetMock.mockResolvedValue({ id: 'actor-1', name: 'my-actor', username: 'john', versions });

            const text = await callToolExpectingUserError({ autoBuild: true, operations: [write('a.js', 'a')] });

            expect(text).toBe('Specify versionNumber; this Actor has versions: .');
            expect(versionMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it.each(['actor-1', 'john~my-actor'])(
            'names the Actor by the full name in its document when given as %s',
            async (actor) => {
                const result = await callTool({ actor, operations: [write('a.js', 'a')] });

                expect(actorMock.mock.calls).toEqual([[actor], ['actor-1']]);
                expect(result.content[1].text).toBe(
                    'Updated version 0.1 of john/my-actor.\nRuns use these files once the version is built.',
                );
            },
        );

        it('refuses a version the Actor does not have', async () => {
            const text = await callToolExpectingUserError({ versionNumber: '0.2', operations: [write('a.js', 'a')] });

            expect(text).toBe("Actor 'john/my-actor' has no version 0.2; available versions: 0.1.");
        });

        it('reports a missing Actor', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const text = await callToolExpectingUserError({ actor: 'my-actor', operations: [write('a.js', 'a')] });

            expect(text).toBe(
                "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
            );
        });

        it.each([
            ['a version', 'john/my-actor/versions/0.1', mockVersion()],
            // Has a name but no username.
            ['an env var', 'john/my-actor/versions/0.1/env-vars/API_KEY', { name: 'API_KEY', value: 'secret-value' }],
            // Has a username but no name, as a run's default storage does.
            ["a run's key-value store", 'john/my-actor/runs/last/key-value-store', { id: 'kvs-1', username: 'john' }],
        ])(
            'reports %s, reached by extra path segments, as a missing Actor and writes nothing',
            async (_, actor, document) => {
                actorGetMock.mockResolvedValue(document);

                const result = await callTool({ actor, autoBuild: true, operations: [write('a.js', 'a')] });

                expectSoftFailInvalidInput(result);
                expect(result.content[0].text).toBe(
                    `Actor '${actor}' not found. Give its ID or its full name, username/name; a name without the username is not enough.`,
                );
                expect(versionMock).not.toHaveBeenCalled();
                expect(buildMock).not.toHaveBeenCalled();
                expect(JSON.stringify(result)).not.toContain('secret-value');
            },
        );

        it.each([
            ['https://user:secret@github.com/john/repo.git', 'https://github.com/john/repo.git'],
            ['http://john:secret-password@git.example.com/repo.git', 'http://git.example.com/repo.git'],
            [
                'ssh://deploy:secret@github.com/john/repo.git?x=secret#main',
                'ssh://deploy@github.com/john/repo.git#main',
            ],
            ['git@github.com:john/repo.git', 'git@github.com:john/repo.git'],
            ['git@github.com:john/repo.git?token=secret', 'git@github.com:john/repo.git'],
            ['git@github.com:john/repo.git?token=secret#main:src', 'git@github.com:john/repo.git#main:src'],
        ])('refuses a GIT_REPO version at %s, naming its URL as %s', async (gitRepoUrl, cleanUrl) => {
            mockVersionRead({ sourceType: 'GIT_REPO', gitRepoUrl });

            const result = await callTool({ autoBuild: true, operations: [write('a.js', 'a')] });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                `Version 0.1 of john/my-actor has its files in the Git repository ${cleanUrl}, not stored on Apify, so this tool cannot work on them; use the repository.`,
            );
            expect(JSON.stringify(result)).not.toMatch(/secret/);
            expect(versionMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it.each<{ outcome: string; version: Record<string, unknown>; text: string }>([
            {
                outcome: 'a GITHUB_GIST version, naming its URL without credentials',
                version: {
                    sourceType: 'GITHUB_GIST',
                    gitHubGistUrl: 'https://gist.github.com/john/abc123?secret=x',
                    gitRepoUrl: 'https://github.com/old.git',
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
        ])('refuses $outcome', async ({ version, text }) => {
            mockVersionRead(version);

            const result = await callTool({ autoBuild: true, operations: [write('a.js', 'a')] });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(text);
            expect(JSON.stringify(result)).not.toMatch(/secret|example|old\.git|key-value-stores/);
            expect(versionMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it.each(['SOURCE_CODE', 'SOMETHING_NEW'])(
            'refuses a %s version without naming a URL left over from another source type',
            async (sourceType) => {
                mockVersionRead({
                    sourceType,
                    gitRepoUrl: 'https://github.com/john/old-repo.git',
                    tarballUrl: 'https://example.com/old-tarball.zip',
                    gitHubGistUrl: 'https://gist.github.com/john/old-gist',
                });

                const text = await callToolExpectingUserError({ autoBuild: true, operations: [write('a.js', 'a')] });

                expect(text).toBe(
                    `Version 0.1 of john/my-actor has source type ${sourceType}, which this tool cannot work on; only versions stored as files are supported.`,
                );
                expect(buildMock).not.toHaveBeenCalled();
            },
        );

        it('refuses a version whose source the API hides', async () => {
            mockVersionRead({ sourceFiles: undefined });

            const text = await callToolExpectingUserError({ autoBuild: true, operations: [write('a.js', 'a')] });

            expect(text).toBe(
                "Version 0.1 of john/my-actor came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.",
            );
            expect(buildMock).not.toHaveBeenCalled();
        });

        it.each<[string, () => void, Record<string, unknown>]>([
            ['a write', () => {}, { operations: [write('a.js', 'a')] }],
            ['a failed operation', () => {}, { operations: [write('src/main.js', 'x')] }],
            ['a build', () => {}, { autoBuild: true, operations: [write('a.js', 'a')] }],
            ['a refused version', () => mockVersionRead({ sourceType: 'GIT_REPO' }), { operations: [] }],
        ])('returns no env var name or value after %s', async (_, setup, args) => {
            setup();

            const result = await callTool(args);

            expect(JSON.stringify(result)).not.toMatch(/API_KEY|secret-value/);
        });

        it('lets an API error from the PUT through unchanged', async () => {
            const error = apiError(400, 'Source files are too large.');
            versionUpdateMock.mockRejectedValue(error);

            await expect(callTool({ operations: [write('b.js', 'b')] })).rejects.toBe(error);
        });
    });

    describe('cancellation', () => {
        it('writes nothing when the request is cancelled during the read', async () => {
            const controller = new AbortController();
            actorGetMock.mockImplementation(async () => {
                controller.abort();
                return { id: 'actor-1', name: 'my-actor', username: 'john', versions: [mockVersion()] };
            });

            const result = await callTool({ autoBuild: true, operations: [write('b.js', 'b')] }, controller.signal);

            expect(result).toEqual({});
            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('starts no build when the request is cancelled during the write', async () => {
            const controller = new AbortController();
            versionUpdateMock.mockImplementation(async () => controller.abort());

            const result = await callTool({ autoBuild: true, operations: [write('b.js', 'b')] }, controller.signal);

            expect(result).toEqual({});
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('keeps the build it started when the request is cancelled during the build start', async () => {
            const controller = new AbortController();
            buildMock.mockImplementation(async () => {
                controller.abort();
                return {
                    id: 'build-1',
                    actId: 'actor-1',
                    buildNumber: '0.1.5',
                    status: 'RUNNING',
                    startedAt: new Date('2026-09-01T10:00:00.000Z'),
                };
            });
            // The build client is what aborts a build.
            const abortMock = vi.fn(async () => ({}));
            buildClientMock.mockReturnValueOnce({ abort: abortMock });

            const result = await callTool({ autoBuild: true, operations: [write('b.js', 'b')] }, controller.signal);

            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
            expect(buildMock).toHaveBeenCalledTimes(1);
            expect(buildClientMock).not.toHaveBeenCalled();
            expect(abortMock).not.toHaveBeenCalled();
            expect(result.structuredContent.build).toEqual({
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.1.5',
                status: 'RUNNING',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: null,
            });
        });
    });

    describe('autoBuild', () => {
        it('starts a build without waiting', async () => {
            const result = await callTool({ autoBuild: true, operations: [write('b.js', 'b')] });

            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(buildMock).toHaveBeenCalledWith('0.1', { useCache: true });
            expect(result.structuredContent.build).toEqual({
                id: 'build-1',
                actorId: 'actor-1',
                buildNumber: '0.1.5',
                status: 'READY',
                startedAt: '2026-09-01T10:00:00.000Z',
                finishedAt: null,
            });
            expect(result.content[1].text).toContain(`Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET}`);
            expect(result.content).toHaveLength(2);
            expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        });

        it('adds the build Console link for an Apify Console session', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

            const result = await callToolInConsole({ autoBuild: true, operations: [write('b.js', 'b')] });

            const consoleUrl = 'https://console.apify.com/actors/actor-1/builds/0.1.5';
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(getUserInfoCached).toHaveBeenCalledWith('apify_ui_test', stubClient);
            expect(result.structuredContent.build?.apifyConsoleUrl).toBe(consoleUrl);
            expect(result.content).toHaveLength(3);
            expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
            expect(result.content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        });

        it('starts a build when nothing changed', async () => {
            const result = await callTool({ autoBuild: true, operations: [] });

            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent.build?.id).toBe('build-1');
        });

        it('starts a build of the version when a write leaves its content as it was', async () => {
            const result = await callTool({
                autoBuild: true,
                operations: [write('src/main.js', MAIN_JS.content, { expectedHash: MAIN_JS_HASH })],
            });

            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(buildMock.mock.calls).toEqual([['0.1', { useCache: true }]]);
            expect(result.structuredContent.changed).toBe(false);
            expect(result.structuredContent.build?.id).toBe('build-1');
            expect(result.content[1].text).toContain(
                'Nothing changed in version 0.1 of john/my-actor, so nothing was written.',
            );
        });

        it('returns a build that is still running without waiting for it', async () => {
            buildMock.mockResolvedValue({ id: 'build-2', actId: 'actor-1', buildNumber: '0.1.6', status: 'RUNNING' });

            const result = await callTool({ autoBuild: true, operations: [write('b.js', 'b')] });

            expect(result.structuredContent.build).toEqual(
                expect.objectContaining({ id: 'build-2', status: 'RUNNING' }),
            );
            expect(buildClientMock).not.toHaveBeenCalled();
        });

        it('reports a build that failed to start with the write still done', async () => {
            buildMock.mockRejectedValue(apiError(402, 'Not enough credit'));

            const result = await callTool({ autoBuild: true, operations: [write('b.js', 'b')] });

            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
            expect(result.structuredContent.buildError).toBe('Not enough credit');
            expect(result.structuredContent).not.toHaveProperty('build');
            expect(result.content[1].text).toContain(
                'The build could not be started; start it again to run these files.',
            );
        });

        it('rethrows an error from the build start that is not an API error', async () => {
            buildMock.mockRejectedValue(new TypeError('Cannot read properties of undefined'));

            await expect(callTool({ autoBuild: true, operations: [write('b.js', 'b')] })).rejects.toThrow(TypeError);
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });
    });
});
