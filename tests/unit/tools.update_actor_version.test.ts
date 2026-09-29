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
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const actorGetMock = vi.fn();
const versionUpdateMock = vi.fn();
const buildMock = vi.fn();
const versionMock = vi.fn(() => ({ update: versionUpdateMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock, build: buildMock }));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 1}' };
const MAIN_JS = { name: 'src/main.js', format: 'TEXT', content: 'const a = 1;\nconsole.log(a);\nexport {};\n' };
const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
const LOGO = { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') };
const FOLDER = { name: 'storage', folder: true };

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

async function readRevision(): Promise<string> {
    const result = (await (getActorVersion as HelperTool).call(
        stubToolCallContext({ actor: 'john/my-actor' }, stubClient),
    )) as { structuredContent: { revision: string } };
    return result.structuredContent.revision;
}

const write = (path: string, content: string, extra: Record<string, unknown> = {}) => ({
    type: 'write',
    path,
    content,
    ...extra,
});

const edit = (path: string, ...edits: { oldText: string; newText: string }[]) => ({ type: 'edit', path, edits });

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
        expect(result.content[1].text).toBe(
            'Updated version 0.1 of john/my-actor.\nRuns use these files once the version is built.',
        );
        expect(buildMock).not.toHaveBeenCalled();
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

        it('replaces a file given its current hash, in either case', async () => {
            const result = await callTool({
                operations: [write('src/main.js', 'new\n', { expectedHash: MAIN_JS_HASH.toUpperCase() })],
            });

            expect(getPutFiles()).toContainEqual({ name: 'src/main.js', format: 'TEXT', content: 'new\n' });
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('new\n') },
            ]);
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

            expect(getPutFiles()).toEqual(
                expect.arrayContaining([
                    { name: 'assets/icon.png', format: 'BASE64', content: icon },
                    { name: 'README.md', format: 'BASE64', content: readme },
                ]),
            );
            expect(result.structuredContent.changes).toContainEqual({
                path: 'assets/icon.png',
                action: 'created',
                hash: sha256Prefix(Buffer.from([1, 2, 3])),
            });
        });

        it('warns about an empty file, which the build skips', async () => {
            const result = await callTool({ operations: [write('src/__init__.py', '')] });

            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: src/__init__.py.',
            ]);
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
            expect(getPutFiles()).toContainEqual({ name: 'src/main.js', format: 'TEXT', content });
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix(content) },
            ]);
        });

        it('inserts newText as given, with no replacement patterns', async () => {
            await callTool({ operations: [edit('src/main.js', { oldText: '1', newText: "'$&$1'" })] });

            expect(getPutFiles()).toContainEqual(
                expect.objectContaining({ content: expect.stringContaining("'$&$1'") }),
            );
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

        it('does not convert line endings in a file with mixed line endings', async () => {
            mockFiles({ name: 'src/main.js', format: 'TEXT', content: 'one\r\ntwo\nthree\r\n' });

            const text = await callToolExpectingUserError({
                operations: [edit('src/main.js', { oldText: 'one\ntwo', newText: 'x' })],
            });

            expect(text).toContain('failed with NO_MATCH.');
        });

        it('keeps a UTF-8 file stored as BASE64 in BASE64', async () => {
            mockFiles({ name: 'src/data.txt', format: 'BASE64', content: Buffer.from('hello\n').toString('base64') });

            await callTool({ operations: [edit('src/data.txt', { oldText: 'hello', newText: 'bye' })] });

            expect(getPutFiles()).toEqual([
                { name: 'src/data.txt', format: 'BASE64', content: Buffer.from('bye\n').toString('base64') },
            ]);
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

            expect(getPutFiles()).toEqual([FOLDER, ACTOR_JSON, LOGO]);
            expect(result.structuredContent.changes).toEqual([{ path: 'src/main.js', action: 'deleted' }]);
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
        });

        it('refuses a stale hash (HASH_MISMATCH) and a missing file (FILE_NOT_FOUND)', async () => {
            const stale = await callToolExpectingUserError({
                operations: [{ type: 'delete', path: 'src/main.js', expectedHash: 'ffffffffffffffff' }],
            });
            const missing = await callToolExpectingUserError({
                operations: [{ type: 'delete', path: 'src/none.js', expectedHash: MAIN_JS_HASH }],
            });

            expect(stale).toContain('(delete src/main.js) failed with HASH_MISMATCH.');
            expect(missing).toContain('(delete src/none.js) failed with FILE_NOT_FOUND.');
        });

        it('renames a file with a delete and a write', async () => {
            const result = await callTool({
                operations: [
                    { type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH },
                    write('src/index.js', MAIN_JS.content),
                ],
            });

            expect(result.structuredContent.changes).toEqual([
                { path: 'src/index.js', action: 'created', hash: MAIN_JS_HASH },
                { path: 'src/main.js', action: 'deleted' },
            ]);
        });
    });

    describe('input', () => {
        it('matches a path the way get-actor-version lists it', async () => {
            const result = await callTool({
                operations: [{ type: 'delete', path: './src//main.js', expectedHash: MAIN_JS_HASH }],
            });

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

        it('reports a missing Actor', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const text = await callToolExpectingUserError({ actor: 'my-actor', operations: [write('a.js', 'a')] });

            expect(text).toBe(
                "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
            );
        });

        it.each([
            [
                'GIT_REPO',
                { gitRepoUrl: 'https://user:secret@github.com/john/repo.git' },
                'https://github.com/john/repo.git',
            ],
            [
                'TARBALL',
                {
                    tarballUrl:
                        'https://api.example.test/v2/key-value-stores/s/records/version-0.1.zip?signature=secret',
                },
                'https://api.example.test/v2/key-value-stores/s/records/version-0.1.zip',
            ],
        ])('refuses a %s version, naming its URL without credentials', async (sourceType, urlFields, cleanUrl) => {
            mockVersionRead({ sourceType, ...urlFields });

            const text = await callToolExpectingUserError({ operations: [write('a.js', 'a')] });

            expect(text).toBe(
                `Version 0.1 of john/my-actor is not stored as files (source type ${sourceType}, ${cleanUrl}), and this tool works only on versions stored as files.`,
            );
        });

        it('refuses a version whose source the API hides', async () => {
            mockVersionRead({ sourceFiles: undefined });

            const text = await callToolExpectingUserError({ operations: [write('a.js', 'a')] });

            expect(text).toContain('Version 0.1 of john/my-actor came back without its source');
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
        });

        it('starts a build when nothing changed', async () => {
            const result = await callTool({ autoBuild: true, operations: [] });

            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent.build?.id).toBe('build-1');
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
