import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../src/const.js';
import { getCategoryTools, toolCategoriesEnabledByDefault } from '../../src/tools/index.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { getActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const actorGetMock = vi.fn();
// The Actor client's other methods, which lead to every write and build, and `actors()`, which creates Actors.
const writeMocks = { update: vi.fn(), delete: vi.fn(), build: vi.fn(), version: vi.fn(), versions: vi.fn() };
const actorsMock = vi.fn();
const actorMock = vi.fn(() => ({ get: actorGetMock, ...writeMocks }));

const stubClient = { actor: actorMock, actors: actorsMock } as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON_SOURCE = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 1}' };
const MAIN_JS_SOURCE = { name: 'src/main.js', format: 'TEXT', content: 'console.log("hi");\n' };
const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
const LOGO_SOURCE = { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') };
/** The env var names and values of `mockVersion()` and the internal `userId` of `mockActor()`. */
const LEAKABLE_VALUES = ['user-secret', 'API_KEY', 'secret-value', 'secret-hash', 'MODE', 'plain-value'];

type VersionOutput = {
    revision: string;
    files: { path: string; sizeBytes: number; hash: string }[];
    contents: {
        path: string;
        content: string;
        encoding: string;
        startLine?: number;
        endLine?: number;
        totalLines?: number;
    }[];
    omittedPaths?: string[];
    notFoundPaths?: string[];
    [key: string]: unknown;
};

type VersionResult = TextToolResult & { structuredContent: VersionOutput; toolTelemetry?: ToolTelemetrySnapshot };

/** A SOURCE_FILES version with a folder entry, the way Console stores an empty folder, and env vars that must not leak. */
function mockVersion(overrides: Record<string, unknown> = {}) {
    return {
        versionNumber: '0.1',
        buildTag: 'latest',
        sourceType: 'SOURCE_FILES',
        envVars: [
            { name: 'API_KEY', value: 'secret-value', valueHash: 'secret-hash', isSecret: true },
            { name: 'MODE', value: 'plain-value' },
        ],
        sourceFiles: [MAIN_JS_SOURCE, { name: 'src', folder: true }, ACTOR_JSON_SOURCE, LOGO_SOURCE],
        ...overrides,
    };
}

/** An Actor API document, which carries its versions; `userId` is an internal field the tool must not leak. */
function mockActor(versions: Record<string, unknown>[] = [mockVersion()]) {
    return { id: 'actor-1', userId: 'user-secret', name: 'my-actor', username: 'john', versions };
}

function mockVersionRead(overrides: Record<string, unknown>) {
    actorGetMock.mockResolvedValue(mockActor([mockVersion(overrides)]));
}

function sha256Prefix(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

const callTool = async (args: Record<string, unknown>) =>
    (await (getActorVersion as HelperTool).call(
        stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient),
    )) as VersionResult;

/** Calls the tool expecting a soft-fail result and returns its first text block. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await callTool(args);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
};

/** `count` text files of `sizeBytes` each, named file-00.txt and on. */
function buildTextSources(count: number, sizeBytes: number) {
    return Array.from({ length: count }, (_, index) => ({
        name: `file-${String(index).padStart(2, '0')}.txt`,
        format: 'TEXT',
        content: 'x'.repeat(sizeBytes),
    }));
}

describe('get-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actorGetMock.mockResolvedValue(mockActor());
    });

    it('is a read-only, idempotent, closed-world tool without payment', () => {
        expect(getActorVersion.name).toBe(HELPER_TOOLS.ACTOR_VERSION_GET);
        expect(getActorVersion.annotations).toEqual({
            title: 'Get Actor version',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect((getActorVersion as HelperTool).paymentRequired).toBeUndefined();
    });

    it.each<{ outcome: string; args: Record<string, unknown>; setup?: () => void; succeeds?: boolean }>([
        { outcome: 'the listing', args: {}, succeeds: true },
        { outcome: 'file contents', args: { paths: ['src/main.js', 'assets/logo.png', 'missing.js'] }, succeeds: true },
        { outcome: 'a line range', args: { paths: ['src/main.js'], startLine: 1, lineCount: 1 }, succeeds: true },
        { outcome: 'a startLine past the end', args: { paths: ['src/main.js'], startLine: 2 } },
        { outcome: 'a line range on a base64 file', args: { paths: ['assets/logo.png'], startLine: 1 } },
        { outcome: 'a missing version', args: { versionNumber: '9.9' } },
        {
            outcome: 'several versions and no versionNumber',
            args: {},
            setup: () =>
                actorGetMock.mockResolvedValue(mockActor([mockVersion(), mockVersion({ versionNumber: '0.2' })])),
        },
        { outcome: 'a hidden source', args: {}, setup: () => mockVersionRead({ sourceFiles: undefined }) },
        {
            outcome: 'a Git repository',
            args: {},
            setup: () => mockVersionRead({ sourceType: 'GIT_REPO', gitRepoUrl: 'https://github.com/john/repo.git' }),
        },
        {
            outcome: 'a gist',
            args: {},
            setup: () =>
                mockVersionRead({ sourceType: 'GITHUB_GIST', gitHubGistUrl: 'https://gist.github.com/john/1' }),
        },
        {
            outcome: 'a TARBALL',
            args: {},
            setup: () => mockVersionRead({ sourceType: 'TARBALL', tarballUrl: 'https://example.com/source.zip' }),
        },
        { outcome: 'a legacy source type', args: {}, setup: () => mockVersionRead({ sourceType: 'SOURCE_CODE' }) },
        { outcome: 'a missing Actor', args: {}, setup: () => actorGetMock.mockResolvedValue(undefined) },
        {
            // The version document carries the env vars.
            outcome: 'a sub-resource that is not an Actor',
            args: { actor: 'john/my-actor/versions/0.1' },
            setup: () => actorGetMock.mockResolvedValue(mockVersion()),
        },
    ])('makes only the Actor GET and returns no env var for $outcome', async ({ args, setup, succeeds = false }) => {
        setup?.();

        const result = await callTool(args);

        expect(result.isError ?? false).toBe(!succeeds);
        expect(actorGetMock).toHaveBeenCalledTimes(1);
        for (const [name, mock] of Object.entries({ ...writeMocks, actors: actorsMock })) {
            expect(mock, name).not.toHaveBeenCalled();
        }
        const serialized = JSON.stringify(result);
        for (const value of LEAKABLE_VALUES) {
            expect(serialized).not.toContain(value);
        }
    });

    it('is served in the source category, which is not enabled by default', () => {
        expect(getCategoryTools().source.map((tool) => tool.name)).toEqual([HELPER_TOOLS.ACTOR_VERSION_GET]);
        expect(toolCategoriesEnabledByDefault).not.toContain('source');
    });

    describe('SOURCE_FILES', () => {
        it.each([{}, { paths: [] }])(
            'returns the sorted manifest and no content for %o, from one Actor read',
            async (args) => {
                const result = await callTool(args);
                const { structuredContent } = result;

                expect(actorMock).toHaveBeenCalledTimes(1);
                expect(actorMock).toHaveBeenCalledWith('john/my-actor');
                expect(structuredContent).toEqual({
                    actorId: 'actor-1',
                    fullName: 'john/my-actor',
                    versionNumber: '0.1',
                    revision: expect.stringMatching(/^[0-9a-f]{16}$/),
                    files: [
                        { path: '.actor/actor.json', sizeBytes: 25, hash: sha256Prefix(ACTOR_JSON_SOURCE.content) },
                        { path: 'assets/logo.png', sizeBytes: 6, hash: sha256Prefix(LOGO_BYTES) },
                        { path: 'src/main.js', sizeBytes: 19, hash: sha256Prefix(MAIN_JS_SOURCE.content) },
                    ],
                    contents: [],
                });
                expect(JSON.parse(result.content[0].text)).toEqual(structuredContent);
                expect(result.content).toHaveLength(2);
                expect(result.content[1].text).toBe('Read version 0.1 of john/my-actor.');
                expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
                const serialized = JSON.stringify(result);
                for (const secret of LEAKABLE_VALUES) {
                    expect(serialized).not.toContain(secret);
                }
            },
        );

        it('sorts the manifest in plain string order and computes the revision over sorted path and hash lines', async () => {
            // Locale order would put package.json before README.md; plain order puts the emoji, a UTF-16 surrogate pair,
            // before the fullwidth z.
            const names = ['\u{1F600}.txt', 'package.json', 'src/main.js', '\uFF5A.txt', 'README.md', 'Dockerfile'];
            mockVersionRead({ sourceFiles: names.map((name) => ({ name, format: 'TEXT', content: `${name}\n` })) });
            const sortedNames = [
                'Dockerfile',
                'README.md',
                'package.json',
                'src/main.js',
                '\u{1F600}.txt',
                '\uFF5A.txt',
            ];

            const { structuredContent } = await callTool({});

            expect(structuredContent.files.map(({ path }) => path)).toEqual(sortedNames);
            const lines = sortedNames.map((name) => `${name}\0${sha256Prefix(`${name}\n`)}\n`).join('');
            expect(structuredContent.revision).toBe(sha256Prefix(lines));
        });

        it('gives the same revision whatever order the files are stored in, and a new one when a file changes', async () => {
            const first = await callTool({});
            mockVersionRead({ sourceFiles: [LOGO_SOURCE, ACTOR_JSON_SOURCE, MAIN_JS_SOURCE] });
            const reordered = await callTool({});
            mockVersionRead({
                sourceFiles: [LOGO_SOURCE, ACTOR_JSON_SOURCE, { ...MAIN_JS_SOURCE, content: 'console.log(1);\n' }],
            });
            const changed = await callTool({});

            expect(reordered.structuredContent.revision).toBe(first.structuredContent.revision);
            expect(changed.structuredContent.revision).not.toBe(first.structuredContent.revision);
        });

        it('hashes the decoded bytes and returns a UTF-8 file stored as BASE64 as text', async () => {
            const first = await callTool({ paths: ['src/main.js'] });
            mockVersionRead({
                sourceFiles: [
                    {
                        name: 'src/main.js',
                        format: 'BASE64',
                        content: Buffer.from(MAIN_JS_SOURCE.content).toString('base64'),
                    },
                    ACTOR_JSON_SOURCE,
                    LOGO_SOURCE,
                ],
            });
            const reencoded = await callTool({ paths: ['src/main.js'] });

            expect(reencoded.structuredContent.revision).toBe(first.structuredContent.revision);
            expect(reencoded.structuredContent.files).toEqual(first.structuredContent.files);
            expect(reencoded.structuredContent.contents).toEqual([
                { path: 'src/main.js', content: MAIN_JS_SOURCE.content, encoding: 'utf8' },
            ]);
        });

        it('returns a BASE64 file with a text extension as base64 when its bytes are not valid UTF-8', async () => {
            const bytes = Buffer.from([0x61, 0xc3, 0x28, 0xff]);
            const content = bytes.toString('base64');
            mockVersionRead({ sourceFiles: [{ name: 'data.txt', format: 'BASE64', content }] });

            const { structuredContent } = await callTool({ paths: ['data.txt'] });

            expect(structuredContent.files).toEqual([{ path: 'data.txt', sizeBytes: 4, hash: sha256Prefix(bytes) }]);
            expect(structuredContent.contents).toEqual([{ path: 'data.txt', content, encoding: 'base64' }]);
        });

        it('returns a BASE64 file with a binary extension as base64 even when its bytes are valid UTF-8', async () => {
            const content = Buffer.from('ascii').toString('base64');
            mockVersionRead({ sourceFiles: [{ name: 'data.bin', format: 'BASE64', content }] });

            const { structuredContent } = await callTool({ paths: ['data.bin'] });

            expect(structuredContent.contents).toEqual([{ path: 'data.bin', content, encoding: 'base64' }]);
        });

        it('keeps the byte order mark of a UTF-8 file stored as BASE64', async () => {
            const text = '\uFEFFwith bom';
            const bytes = Buffer.from(text, 'utf8');
            mockVersionRead({
                sourceFiles: [{ name: 'bom.txt', format: 'BASE64', content: bytes.toString('base64') }],
            });

            const { structuredContent } = await callTool({ paths: ['bom.txt'] });

            expect(structuredContent.files).toEqual([
                { path: 'bom.txt', sizeBytes: bytes.length, hash: sha256Prefix(bytes) },
            ]);
            expect(structuredContent.contents).toEqual([{ path: 'bom.txt', content: text, encoding: 'utf8' }]);
        });

        it('normalizes stored names as the build worker does, and keeps the last entry for a path', async () => {
            mockVersionRead({
                sourceFiles: [
                    { name: 'a.js', format: 'TEXT', content: '1' },
                    { name: './a.js', format: 'TEXT', content: '2' },
                    { name: './src//lib/../main.js', format: 'TEXT', content: 'main' },
                ],
            });

            const { structuredContent } = await callTool({ paths: ['a.js', 'src/main.js'] });

            expect(structuredContent.files).toEqual([
                { path: 'a.js', sizeBytes: 1, hash: sha256Prefix('2') },
                { path: 'src/main.js', sizeBytes: 4, hash: sha256Prefix('main') },
            ]);
            expect(structuredContent.contents.map(({ content }) => content)).toEqual(['2', 'main']);
        });

        it('reads an inline file stored without format as TEXT and one without content as empty', async () => {
            mockVersionRead({
                sourceFiles: [
                    { name: 'a.js', content: 'a' },
                    { name: 'b.js', format: 'TEXT' },
                    { name: 'c.js', format: 'BASE64' },
                ],
            });

            const result = await callTool({ paths: ['a.js', 'b.js', 'c.js'] });

            expect(result.structuredContent.files).toEqual([
                { path: 'a.js', sizeBytes: 1, hash: sha256Prefix('a') },
                { path: 'b.js', sizeBytes: 0, hash: sha256Prefix('') },
                { path: 'c.js', sizeBytes: 0, hash: sha256Prefix('') },
            ]);
            expect(result.structuredContent.contents).toEqual([
                { path: 'a.js', content: 'a', encoding: 'utf8' },
                { path: 'b.js', content: '', encoding: 'utf8' },
                { path: 'c.js', content: '', encoding: 'utf8' },
            ]);
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it('returns the named files in order within the limit, and lists the rest', async () => {
            const sources = buildTextSources(4, 100 * 1024);
            mockVersionRead({ sourceFiles: [...sources, LOGO_SOURCE] });

            const result = await callTool({
                paths: ['file-03.txt', 'assets/logo.png', 'file-01.txt', 'missing.js', 'file-00.txt', 'file-03.txt'],
            });
            const { structuredContent } = result;

            // A binary file comes back as base64; file-00.txt does not fit after two 100 KiB files.
            expect(structuredContent.contents).toEqual([
                { path: 'file-03.txt', content: sources[3].content, encoding: 'utf8' },
                { path: 'assets/logo.png', content: LOGO_SOURCE.content, encoding: 'base64' },
                { path: 'file-01.txt', content: sources[1].content, encoding: 'utf8' },
            ]);
            expect(structuredContent.omittedPaths).toEqual(['file-00.txt']);
            expect(structuredContent.notFoundPaths).toEqual(['missing.js']);
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it('keeps filling the limit after a file that does not fit', async () => {
            const sources = [...buildTextSources(1, 200 * 1024), { name: 'small.txt', format: 'TEXT', content: 'x' }];
            sources.push({ name: 'big.txt', format: 'TEXT', content: 'y'.repeat(100 * 1024) });
            mockVersionRead({ sourceFiles: sources });

            const { structuredContent } = await callTool({ paths: ['file-00.txt', 'big.txt', 'small.txt'] });

            expect(structuredContent.contents.map(({ path }) => path)).toEqual(['file-00.txt', 'small.txt']);
            expect(structuredContent.omittedPaths).toEqual(['big.txt']);
        });

        it('omits a single file over the limit, and returns one of exactly the limit', async () => {
            mockVersionRead({
                sourceFiles: [
                    { name: 'big.js', format: 'TEXT', content: 'x'.repeat(MAX_INLINE_BYTES + 1) },
                    { name: 'fits.js', format: 'TEXT', content: 'x'.repeat(MAX_INLINE_BYTES) },
                ],
            });

            const big = await callTool({ paths: ['big.js'] });
            const fits = await callTool({ paths: ['fits.js'] });

            expect(big.structuredContent.contents).toEqual([]);
            expect(big.structuredContent.omittedPaths).toEqual(['big.js']);
            expect(fits.structuredContent.contents.map(({ path }) => path)).toEqual(['fits.js']);
        });

        it('treats a name like __proto__ as an ordinary file', async () => {
            mockVersionRead({ sourceFiles: [{ name: '__proto__', format: 'TEXT', content: 'plain' }] });

            const { structuredContent } = await callTool({ paths: ['__proto__', 'constructor'] });

            expect(structuredContent.contents).toEqual([{ path: '__proto__', content: 'plain', encoding: 'utf8' }]);
            expect(structuredContent.notFoundPaths).toEqual(['constructor']);
        });
    });

    describe('line ranges', () => {
        const LINES_SOURCE = { name: 'src/lines.js', format: 'TEXT', content: 'one\r\ntwo\nthree\nfour' };

        beforeEach(() => {
            mockVersionRead({ sourceFiles: [LINES_SOURCE, LOGO_SOURCE] });
        });

        it('returns the requested lines raw, with their line endings', async () => {
            const result = await callTool({ paths: ['src/lines.js'], startLine: 2, lineCount: 2 });

            expect(result.structuredContent.contents).toEqual([
                {
                    path: 'src/lines.js',
                    content: 'two\nthree\n',
                    encoding: 'utf8',
                    startLine: 2,
                    endLine: 3,
                    totalLines: 4,
                },
            ]);
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it('reads to the end without lineCount, and from line 1 without startLine', async () => {
            const toEnd = await callTool({ paths: ['src/lines.js'], startLine: 3 });
            const fromStart = await callTool({ paths: ['src/lines.js'], lineCount: 1 });

            expect(toEnd.structuredContent.contents[0]).toMatchObject({
                content: 'three\nfour',
                startLine: 3,
                endLine: 4,
            });
            expect(fromStart.structuredContent.contents[0]).toMatchObject({
                content: 'one\r\n',
                startLine: 1,
                endLine: 1,
            });
        });

        it('returns a range of a file over the limit, and omits a range over the limit', async () => {
            const line = `${'x'.repeat(1023)}\n`;
            mockVersionRead({ sourceFiles: [{ name: 'big.js', format: 'TEXT', content: line.repeat(300) }] });

            const part = await callTool({ paths: ['big.js'], startLine: 257, lineCount: 44 });
            const tooLong = await callTool({ paths: ['big.js'], lineCount: 257 });

            expect(part.structuredContent.contents).toEqual([
                {
                    path: 'big.js',
                    content: line.repeat(44),
                    encoding: 'utf8',
                    startLine: 257,
                    endLine: 300,
                    totalLines: 300,
                },
            ]);
            expect(tooLong.structuredContent.contents).toEqual([]);
            expect(tooLong.structuredContent.omittedPaths).toEqual(['big.js']);
        });

        it('refuses a line range without exactly one path', async () => {
            const text = await callToolExpectingUserError({ paths: ['a', 'b'], startLine: 1 });
            const withoutPaths = await callToolExpectingUserError({ lineCount: 5 });

            expect(text).toBe('startLine and lineCount need exactly one path in paths.');
            expect(withoutPaths).toBe(text);
            expect(actorMock).not.toHaveBeenCalled();
            expect(actorsMock).not.toHaveBeenCalled();
        });

        it('refuses a startLine past the end of the file', async () => {
            const text = await callToolExpectingUserError({ paths: ['src/lines.js'], startLine: 5 });

            expect(text).toBe('src/lines.js has 4 lines, so startLine 5 is past its end.');
        });

        it('refuses a line range on a base64 file', async () => {
            const text = await callToolExpectingUserError({ paths: ['assets/logo.png'], startLine: 1 });

            expect(text).toBe(
                'assets/logo.png is returned as base64, and startLine and lineCount work only on text files.',
            );
        });

        it('reports a missing file in notFoundPaths', async () => {
            const { structuredContent } = await callTool({ paths: ['nope.js'], startLine: 1 });

            expect(structuredContent.notFoundPaths).toEqual(['nope.js']);
        });
    });

    describe('Actor and version resolution', () => {
        it('lists each version with its source type and build tag when versionNumber is needed', async () => {
            actorGetMock.mockResolvedValue(
                mockActor([
                    { versionNumber: '0.1', sourceType: 'SOURCE_FILES', buildTag: 'latest' },
                    { versionNumber: '0.2', sourceType: 'GIT_REPO', buildTag: 'beta' },
                    { versionNumber: '0.3', sourceType: 'TARBALL' },
                ]),
            );

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                'Specify versionNumber; this Actor has versions: 0.1 (SOURCE_FILES, build tag latest), 0.2 (GIT_REPO, build tag beta), 0.3 (TARBALL).',
            );
        });

        it('reads the requested version', async () => {
            actorGetMock.mockResolvedValue(
                mockActor([mockVersion(), mockVersion({ versionNumber: '0.2', sourceFiles: [MAIN_JS_SOURCE] })]),
            );

            const { structuredContent } = await callTool({ versionNumber: '0.2' });

            expect(structuredContent.versionNumber).toBe('0.2');
            expect(structuredContent.files.map(({ path }) => path)).toEqual(['src/main.js']);
        });

        it('refuses a version the Actor does not have', async () => {
            const text = await callToolExpectingUserError({ versionNumber: '9.9' });

            expect(text).toBe("Actor 'john/my-actor' has no version 9.9; available versions: 0.1.");
        });

        it('reports a missing Actor and that a bare name is not enough', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const text = await callToolExpectingUserError({ actor: 'my-actor' });

            expect(text).toBe(
                "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
            );
        });

        it.each([
            ['a run', 'john/my-actor/runs/last', { id: 'run-1', actId: 'actor-1', status: 'SUCCEEDED' }],
            ['a version', 'john/my-actor/versions/0.1', mockVersion()],
            // Has a name but no username.
            ['an env var', 'john/my-actor/versions/0.1/env-vars/API_KEY', { name: 'API_KEY', value: 'secret-value' }],
        ])('reports %s, reached by extra path segments, as a missing Actor', async (_, actor, document) => {
            actorGetMock.mockResolvedValue(document);

            const text = await callToolExpectingUserError({ actor });

            expect(actorMock).toHaveBeenCalledWith(actor);
            expect(text).toBe(
                `Actor '${actor}' not found. Give its ID or its full name, username/name; a name without the username is not enough.`,
            );
        });

        it('lets an API error through unchanged, for the tool-call engine to report', async () => {
            const error = new ApifyApiError(
                {
                    data: { error: { type: 'some-error', message: 'Insufficient permissions.' } },
                    status: 403,
                } as AxiosResponse,
                1,
            );
            actorGetMock.mockRejectedValue(error);

            await expect(callTool({})).rejects.toBe(error);
        });
    });

    describe('versions not stored as files', () => {
        it('says the API hides the source from accounts that cannot modify the Actor', async () => {
            mockVersionRead({ sourceFiles: undefined });

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "Version 0.1 of john/my-actor came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.",
            );
        });

        it.each([
            [
                'GIT_REPO',
                {
                    gitRepoUrl:
                        'https://oauth2:secret-token@gitlab.com/john/repo.git?private_token=secret-query#main:src',
                },
                'https://gitlab.com/john/repo.git#main:src',
            ],
            [
                'GIT_REPO',
                { gitRepoUrl: 'ssh://git@github.com/john/repo.git?x=secret-query#main' },
                'ssh://git@github.com/john/repo.git#main',
            ],
            [
                'GIT_REPO',
                { gitRepoUrl: 'ssh://deploy:secret-password@github.com/john/repo.git#main' },
                'ssh://deploy@github.com/john/repo.git#main',
            ],
            [
                'GIT_REPO',
                { gitRepoUrl: 'git@github.com:john/repo.git?x=secret-query#main' },
                'git@github.com:john/repo.git#main',
            ],
            [
                'GITHUB_GIST',
                { gitHubGistUrl: 'https://gist.github.com/john/abc123?secret=secret-query' },
                'https://gist.github.com/john/abc123',
            ],
            [
                'TARBALL',
                {
                    tarballUrl:
                        'https://api.example.test/v2/key-value-stores/store-1/records/version-0.1.zip?signature=secret-signature',
                    // A field left over from an earlier source type is not the source.
                    gitRepoUrl: 'https://github.com/john/old.git',
                },
                'https://api.example.test/v2/key-value-stores/store-1/records/version-0.1.zip',
            ],
            [
                'TARBALL',
                { tarballUrl: 'https://user:secret-signature@downloads.example.com/source.zip' },
                'https://downloads.example.com/source.zip',
            ],
        ])('refuses a %s version, naming its URL without credentials', async (sourceType, urlFields, cleanUrl) => {
            // A version switched to another source type keeps its old files, which must not be returned.
            mockVersionRead({ sourceType, ...urlFields });

            const result = await callTool({ paths: ['src/main.js'] });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                `Version 0.1 of john/my-actor is not stored as files (source type ${sourceType}, ${cleanUrl}), and this tool reads only versions stored as files.`,
            );
            expect(JSON.stringify(result)).not.toMatch(/secret|oauth2/);
        });

        it.each(['GIT_REPO', 'SOURCE_CODE', 'SOMETHING_NEW'])(
            'refuses a %s version that comes back without a URL',
            async (sourceType) => {
                // What the API returns to a reader that cannot modify the Actor: the number, type, and build tag only.
                actorGetMock.mockResolvedValue(mockActor([{ versionNumber: '0.1', sourceType, buildTag: 'latest' }]));

                const text = await callToolExpectingUserError({});

                expect(text).toBe(
                    `Version 0.1 of john/my-actor is not stored as files (source type ${sourceType}), and this tool reads only versions stored as files.`,
                );
            },
        );
    });
});
