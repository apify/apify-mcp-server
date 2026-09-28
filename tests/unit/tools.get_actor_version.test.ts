import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
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
const versionGetMock = vi.fn();
const versionMock = vi.fn(() => ({ get: versionGetMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock }));

const stubClient = {
    actor: actorMock,
    baseUrl: 'https://api.example.test/v2',
} as unknown as InternalToolArgs['apifyClient'];

const RECORD_PATH = '/v2/key-value-stores/store-1/records/version-0.1.zip';
const RECORD_URL = `https://api.example.test${RECORD_PATH}?signature=secret-signature`;

const ACTOR_JSON_SOURCE = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 1}' };
const MAIN_JS_SOURCE = { name: 'src/main.js', format: 'TEXT', content: 'console.log("hi");\n' };
const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
const LOGO_SOURCE = { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') };

type VersionOutput = {
    revision: string;
    files: { path: string; sizeBytes: number; hash: string; format: string }[];
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
    envVars: { name: string; isSecret: boolean }[];
    [key: string]: unknown;
};

type VersionResult = TextToolResult & { structuredContent: VersionOutput; toolTelemetry?: ToolTelemetrySnapshot };

/** An Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor(
    versions: Record<string, unknown>[] = [{ versionNumber: '0.1', sourceType: 'SOURCE_FILES', buildTag: 'latest' }],
) {
    return { id: 'actor-1', userId: 'user-secret', name: 'my-actor', username: 'john', versions };
}

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

/** A TARBALL version; the stale `sourceFiles` a switched version keeps must not be returned. */
function mockTarballVersion(tarballUrl = RECORD_URL) {
    return mockVersion({ sourceType: 'TARBALL', tarballUrl, sourceFiles: [MAIN_JS_SOURCE] });
}

function apiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: 'some-error', message } }, status } as AxiosResponse, 1);
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

const TOOL_NAMES = Object.values(HELPER_TOOLS);

const expectNoToolNamed = (result: TextToolResult) => {
    for (const block of result.content.slice(1)) {
        for (const name of TOOL_NAMES) expect(block.text).not.toContain(name);
    }
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
        versionGetMock.mockResolvedValue(mockVersion());
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

    it('is served in the source category, which is not enabled by default', () => {
        expect(getCategoryTools().source.map((tool) => tool.name)).toEqual([HELPER_TOOLS.ACTOR_VERSION_GET]);
        expect(toolCategoriesEnabledByDefault).not.toContain('source');
    });

    describe('SOURCE_FILES', () => {
        it('returns the metadata, the sorted manifest, and every text file, without env var values', async () => {
            const result = await callTool({});
            const { structuredContent } = result;

            expect(actorMock).toHaveBeenCalledWith('john/my-actor');
            // The version is read through the resolved Actor ID, not the selector the caller gave.
            expect(actorMock).toHaveBeenCalledWith('actor-1');
            expect(versionMock).toHaveBeenCalledWith('0.1');
            expect(structuredContent).toEqual({
                actorId: 'actor-1',
                fullName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'SOURCE_FILES',
                buildTag: 'latest',
                revision: expect.stringMatching(/^[0-9a-f]{16}$/),
                files: [
                    {
                        path: '.actor/actor.json',
                        sizeBytes: 25,
                        hash: sha256Prefix(ACTOR_JSON_SOURCE.content),
                        format: 'TEXT',
                    },
                    { path: 'assets/logo.png', sizeBytes: 6, hash: sha256Prefix(LOGO_BYTES), format: 'BASE64' },
                    { path: 'src/main.js', sizeBytes: 19, hash: sha256Prefix(MAIN_JS_SOURCE.content), format: 'TEXT' },
                ],
                contents: [
                    { path: '.actor/actor.json', content: ACTOR_JSON_SOURCE.content, encoding: 'utf8' },
                    { path: 'src/main.js', content: MAIN_JS_SOURCE.content, encoding: 'utf8' },
                ],
                envVars: [
                    { name: 'API_KEY', isSecret: true },
                    { name: 'MODE', isSecret: false },
                ],
            });
            expect(JSON.parse(result.content[0].text)).toEqual(structuredContent);
            expect(result.content).toHaveLength(2);
            expect(result.content[1].text).toBe(
                `Read version 0.1 of john/my-actor, stored inline (SOURCE_FILES): 3 files, revision ${structuredContent.revision}.` +
                    ' Returned the content of 2 files (0.1 KiB).' +
                    ' Base64 files are returned only when named in paths: 1 file left out.',
            );
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
            const serialized = JSON.stringify(result);
            for (const secret of ['user-secret', 'secret-value', 'secret-hash', 'plain-value']) {
                expect(serialized).not.toContain(secret);
            }
            expectNoToolNamed(result);
        });

        it('sorts the manifest in plain string order and computes the revision over sorted path and hash lines', async () => {
            // Locale order would put package.json before README.md; plain order puts the emoji, a UTF-16 surrogate pair,
            // before the fullwidth z.
            const names = ['\u{1F600}.txt', 'package.json', 'src/main.js', '\uFF5A.txt', 'README.md', 'Dockerfile'];
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: names.map((name) => ({ name, format: 'TEXT', content: `${name}\n` })) }),
            );
            const sortedNames = [
                'Dockerfile',
                'README.md',
                'package.json',
                'src/main.js',
                '\u{1F600}.txt',
                '\uFF5A.txt',
            ];

            const { structuredContent } = await callTool({ paths: [] });

            expect(structuredContent.files.map(({ path }) => path)).toEqual(sortedNames);
            const lines = sortedNames.map((name) => `${name}\0${sha256Prefix(`${name}\n`)}\n`).join('');
            expect(structuredContent.revision).toBe(sha256Prefix(lines));
        });

        it('gives the same revision whatever order the files are stored in, and a new one when a file changes', async () => {
            const first = await callTool({ paths: [] });
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [LOGO_SOURCE, ACTOR_JSON_SOURCE, MAIN_JS_SOURCE] }),
            );
            const reordered = await callTool({ paths: [] });
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [LOGO_SOURCE, ACTOR_JSON_SOURCE, { ...MAIN_JS_SOURCE, content: 'console.log(1);\n' }],
                }),
            );
            const changed = await callTool({ paths: [] });

            expect(reordered.structuredContent.revision).toBe(first.structuredContent.revision);
            expect(changed.structuredContent.revision).not.toBe(first.structuredContent.revision);
        });

        it('hashes the decoded bytes and returns a UTF-8 file stored as BASE64 as text, keeping its format', async () => {
            const first = await callTool({});
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [
                        {
                            name: 'src/main.js',
                            format: 'BASE64',
                            content: Buffer.from(MAIN_JS_SOURCE.content).toString('base64'),
                        },
                        ACTOR_JSON_SOURCE,
                        LOGO_SOURCE,
                    ],
                }),
            );
            const reencoded = await callTool({});

            expect(reencoded.structuredContent.revision).toBe(first.structuredContent.revision);
            // The manifest keeps the stored format; the content is the same text as a TEXT file gives.
            expect(reencoded.structuredContent.files[2]).toEqual({
                ...first.structuredContent.files[2],
                format: 'BASE64',
            });
            expect(reencoded.structuredContent.contents).toEqual(first.structuredContent.contents);
            expect(reencoded.content[1].text).toContain(' Base64 files are returned only when named in paths: 1 file');
        });

        it('returns a BASE64 file with a text extension as base64 when its bytes are not valid UTF-8', async () => {
            const bytes = Buffer.from([0x61, 0xc3, 0x28, 0xff]);
            const content = bytes.toString('base64');
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [MAIN_JS_SOURCE, { name: 'data.txt', format: 'BASE64', content }] }),
            );

            const named = await callTool({ paths: ['data.txt'] });
            const listed = await callTool({});

            expect(named.structuredContent.files).toContainEqual({
                path: 'data.txt',
                sizeBytes: 4,
                hash: sha256Prefix(bytes),
                format: 'BASE64',
            });
            expect(named.structuredContent.contents).toEqual([{ path: 'data.txt', content, encoding: 'base64' }]);
            expect(listed.structuredContent.contents.map(({ path }) => path)).toEqual(['src/main.js']);
            expect(listed.content[1].text).toContain(
                ' Base64 files are returned only when named in paths: 1 file left out.',
            );
        });

        it('keeps the byte order mark of a UTF-8 file stored as BASE64', async () => {
            const text = '\uFEFFwith bom';
            const bytes = Buffer.from(text, 'utf8');
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [{ name: 'bom.txt', format: 'BASE64', content: bytes.toString('base64') }],
                }),
            );

            const result = await callTool({});

            expect(result.structuredContent.files).toEqual([
                { path: 'bom.txt', sizeBytes: bytes.length, hash: sha256Prefix(bytes), format: 'BASE64' },
            ]);
            expect(result.structuredContent.contents).toEqual([{ path: 'bom.txt', content: text, encoding: 'utf8' }]);
        });

        it('keeps the last stored entry when two entries normalize to the same path', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [
                        { name: 'a.js', format: 'TEXT', content: '1' },
                        { name: './a.js', format: 'TEXT', content: '2' },
                    ],
                }),
            );

            const result = await callTool({});

            expect(result.structuredContent.files).toEqual([
                { path: 'a.js', sizeBytes: 1, hash: sha256Prefix('2'), format: 'TEXT' },
            ]);
            expect(result.structuredContent.contents).toEqual([{ path: 'a.js', content: '2', encoding: 'utf8' }]);
        });

        it('reads an inline file stored without format as TEXT and one without content as empty', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [
                        { name: 'a.js', content: 'a' },
                        { name: 'b.js', format: 'TEXT' },
                        { name: 'c.js', format: 'BASE64' },
                    ],
                }),
            );

            const result = await callTool({});

            expect(result.structuredContent.files).toEqual([
                { path: 'a.js', sizeBytes: 1, hash: sha256Prefix('a'), format: 'TEXT' },
                { path: 'b.js', sizeBytes: 0, hash: sha256Prefix(''), format: 'TEXT' },
                { path: 'c.js', sizeBytes: 0, hash: sha256Prefix(''), format: 'BASE64' },
            ]);
            expect(result.structuredContent.contents).toEqual([
                { path: 'a.js', content: 'a', encoding: 'utf8' },
                { path: 'b.js', content: '', encoding: 'utf8' },
                { path: 'c.js', content: '', encoding: 'utf8' },
            ]);
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it('drops empty and . segments and turns backslashes into /', async () => {
            const first = await callTool({ paths: [] });
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [
                        { ...MAIN_JS_SOURCE, name: './src//main.js' },
                        ACTOR_JSON_SOURCE,
                        { ...LOGO_SOURCE, name: 'assets\\logo.png' },
                    ],
                }),
            );

            const normalized = await callTool({ paths: ['src/main.js'] });

            expect(normalized.structuredContent.files).toEqual(first.structuredContent.files);
            expect(normalized.structuredContent.revision).toBe(first.structuredContent.revision);
            expect(normalized.structuredContent.contents.map(({ path }) => path)).toEqual(['src/main.js']);
        });

        it('returns the listing only when all text files together are over the limit, never a partial set', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: buildTextSources(3, MAX_INLINE_BYTES / 2) }));

            const result = await callTool({});

            expect(result.structuredContent.files).toHaveLength(3);
            expect(result.structuredContent.contents).toEqual([]);
            expect(result.structuredContent.omittedPaths).toBeUndefined();
            expect(result.content[1].text).toContain(
                'Returned the listing only: the text files total 384.0 KiB, over the 256 KiB limit. Pass paths or pathPrefix to read some of them.',
            );
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it('returns every text file when they total exactly the limit, not counting base64 files', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [...buildTextSources(2, MAX_INLINE_BYTES / 2), LOGO_SOURCE] }),
            );

            const result = await callTool({});

            expect(result.structuredContent.contents.map(({ path }) => path)).toEqual(['file-00.txt', 'file-01.txt']);
            expect(result.content[1].text).toContain(
                ' Base64 files are returned only when named in paths: 1 file left out.',
            );
        });

        it('says which base64 files the default read left out are too large to return', async () => {
            const bigBinary = {
                name: 'big.bin',
                format: 'BASE64',
                content: Buffer.alloc(200 * 1024).toString('base64'),
            };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [bigBinary, MAIN_JS_SOURCE] }));

            const result = await callTool({});

            expect(result.content[1].text).toMatch(
                / Returned the content of 1 file \(0\.1 KiB\)\. Over 256 KiB as base64, so they cannot be returned: big\.bin\.$/,
            );
            expectNoToolNamed(result);
        });

        it('returns the listing only for paths: []', async () => {
            const result = await callTool({ paths: [] });

            expect(result.structuredContent.files).toHaveLength(3);
            expect(result.structuredContent.contents).toEqual([]);
            expect(result.content[1].text).toMatch(/ Returned the listing only\.$/);
        });

        it('returns the named files in order within the limit, and lists the rest', async () => {
            const sources = buildTextSources(4, 100 * 1024);
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [...sources, LOGO_SOURCE] }));

            const result = await callTool({
                paths: ['file-03.txt', 'assets/logo.png', 'file-01.txt', 'missing.js', 'file-00.txt', 'file-03.txt'],
            });
            const { structuredContent } = result;

            // Base64 comes back when named; file-00.txt does not fit after two 100 KiB files.
            expect(structuredContent.contents.map(({ path }) => path)).toEqual([
                'file-03.txt',
                'assets/logo.png',
                'file-01.txt',
            ]);
            expect(structuredContent.contents[1]).toEqual({
                path: 'assets/logo.png',
                content: LOGO_SOURCE.content,
                encoding: 'base64',
            });
            expect(structuredContent.omittedPaths).toEqual(['file-00.txt']);
            expect(structuredContent.notFoundPaths).toEqual(['missing.js']);
            expect(result.content[1].text).toContain(
                ' Left out to stay within 256 KiB: file-00.txt; request them in another call, and a text file over the' +
                    ' limit on its own to read it in line ranges. No file at: missing.js.',
            );
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
            expectNoToolNamed(result);
        });

        it('keeps filling the limit after a file that does not fit', async () => {
            const sources = [...buildTextSources(1, 200 * 1024), { name: 'small.txt', format: 'TEXT', content: 'x' }];
            sources.push({ name: 'big.txt', format: 'TEXT', content: 'y'.repeat(100 * 1024) });
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: sources }));

            const { structuredContent } = await callTool({ paths: ['file-00.txt', 'big.txt', 'small.txt'] });

            expect(structuredContent.contents.map(({ path }) => path)).toEqual(['file-00.txt', 'small.txt']);
            expect(structuredContent.omittedPaths).toEqual(['big.txt']);
        });

        it('says which omitted files cannot be returned at all', async () => {
            const bigBinary = {
                name: 'big.bin',
                format: 'BASE64',
                content: Buffer.alloc(200 * 1024).toString('base64'),
            };
            const bigText = { name: 'big.txt', format: 'TEXT', content: `${'x'.repeat(1023)}\n`.repeat(257) };
            const minified = { name: 'min.js', format: 'TEXT', content: 'x'.repeat(MAX_INLINE_BYTES + 1) };
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [bigBinary, bigText, minified, MAIN_JS_SOURCE] }),
            );

            const result = await callTool({ paths: ['src/main.js', 'big.txt', 'min.js', 'big.bin'] });

            expect(result.structuredContent.omittedPaths).toEqual(['big.txt', 'min.js', 'big.bin']);
            expect(result.content[1].text).toContain(
                ' Left out to stay within 256 KiB: big.txt, min.js; request them in another call, and a text file over' +
                    ' the limit on its own to read it in line ranges. Over 256 KiB as base64, so they cannot be returned: big.bin.',
            );
        });

        it('restricts the listing and the content to pathPrefix, but not the revision', async () => {
            const full = await callTool({ paths: [] });

            const result = await callTool({ pathPrefix: 'src/' });
            const { structuredContent } = result;

            expect(structuredContent.files.map(({ path }) => path)).toEqual(['src/main.js']);
            expect(structuredContent.contents.map(({ path }) => path)).toEqual(['src/main.js']);
            expect(structuredContent.revision).toBe(full.structuredContent.revision);
            expect(result.content[1].text).toContain(': 1 of 3 files under src/, revision');
        });

        it('looks requested paths up under pathPrefix only', async () => {
            const result = await callTool({ pathPrefix: 'src/', paths: ['.actor/actor.json'] });

            expect(result.structuredContent.contents).toEqual([]);
            expect(result.structuredContent.notFoundPaths).toEqual(['.actor/actor.json']);
            expect(result.content[1].text).toContain(' No file under src/ at: .actor/actor.json.');
        });

        it('treats a name like __proto__ as an ordinary file', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [{ name: '__proto__', format: 'TEXT', content: 'plain' }] }),
            );

            const { structuredContent } = await callTool({ paths: ['__proto__', 'constructor'] });

            expect(structuredContent.contents).toEqual([{ path: '__proto__', content: 'plain', encoding: 'utf8' }]);
            expect(structuredContent.notFoundPaths).toEqual(['constructor']);
        });
    });

    describe('line ranges', () => {
        const LINES_SOURCE = { name: 'src/lines.js', format: 'TEXT', content: 'one\r\ntwo\nthree\nfour' };

        beforeEach(() => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [LINES_SOURCE] }));
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
            expect(result.content[1].text).toContain(
                ' Returned lines 2-3 of 4 of src/lines.js. Continue with startLine 4.',
            );
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
            expect(toEnd.content[1].text).not.toContain('Continue with');
            expect(fromStart.structuredContent.contents[0]).toMatchObject({
                content: 'one\r\n',
                startLine: 1,
                endLine: 1,
            });
        });

        it('refuses a line range without exactly one path', async () => {
            const text = await callToolExpectingUserError({ paths: ['a', 'b'], startLine: 1 });
            const withoutPaths = await callToolExpectingUserError({ lineCount: 5 });

            expect(text).toBe('startLine and lineCount need exactly one path in paths.');
            expect(withoutPaths).toBe(text);
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('refuses a startLine past the end of the file', async () => {
            const text = await callToolExpectingUserError({ paths: ['src/lines.js'], startLine: 5 });

            expect(text).toBe('src/lines.js has 4 lines, so startLine 5 is past its end.');
        });

        it('refuses a line range on a base64 file', async () => {
            versionGetMock.mockResolvedValue(mockVersion());

            const text = await callToolExpectingUserError({ paths: ['assets/logo.png'], startLine: 1 });

            expect(text).toBe(
                'assets/logo.png is returned as base64, and startLine and lineCount work only on text files.',
            );
        });

        it('reports a missing file in notFoundPaths', async () => {
            const { structuredContent } = await callTool({ paths: ['nope.js'], startLine: 1 });

            expect(structuredContent.notFoundPaths).toEqual(['nope.js']);
        });

        it('returns the lines that fit from line 1 for a single text file over the limit', async () => {
            const line = `${'x'.repeat(1023)}\n`;
            const content = line.repeat(300);
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [{ name: 'big.js', format: 'TEXT', content }] }),
            );

            const result = await callTool({ paths: ['big.js'] });
            const [returned] = result.structuredContent.contents;

            expect(returned).toEqual({
                path: 'big.js',
                content: line.repeat(256),
                encoding: 'utf8',
                startLine: 1,
                endLine: 256,
                totalLines: 300,
            });
            expect(result.structuredContent.omittedPaths).toBeUndefined();
            expect(result.content[1].text).toContain(
                ' Returned lines 1-256 of 300 of big.js. Continue with startLine 257.',
            );
            expectNoToolNamed(result);
        });

        describe('a line over the limit', () => {
            const LONG_LINE = `${'x'.repeat(MAX_INLINE_BYTES + 1)}\n`;

            const mockFile = (content: string) =>
                versionGetMock.mockResolvedValue(
                    mockVersion({ sourceFiles: [{ name: 'min.js', format: 'TEXT', content }, MAIN_JS_SOURCE] }),
                );

            it('returns the listing and names the startLine that skips it', async () => {
                mockFile(`short\n${LONG_LINE}tail\n`);

                const result = await callTool({ paths: ['min.js'], startLine: 2 });

                expect(result.isError).toBeFalsy();
                expect(result.structuredContent.files).toHaveLength(2);
                expect(result.structuredContent.contents).toEqual([]);
                expect(result.structuredContent.omittedPaths).toEqual(['min.js']);
                expect(result.content[1].text).toMatch(
                    / Returned the listing only\. Line 2 of min\.js is over 256 KiB on its own, so it cannot be returned\. Pass startLine 3 to skip it\.$/,
                );
                expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
                expectNoToolNamed(result);
            });

            it('names no startLine past the last line', async () => {
                mockFile(`short\n${LONG_LINE}`);

                const result = await callTool({ paths: ['min.js'], startLine: 2 });

                expect(result.content[1].text).toMatch(
                    / Line 2 of min\.js is over 256 KiB on its own, so it cannot be returned\.$/,
                );
            });

            it('continues at the long line when the lines before it were returned', async () => {
                mockFile(`short\n${LONG_LINE}tail\n`);

                const result = await callTool({ paths: ['min.js'] });

                expect(result.structuredContent.contents).toEqual([
                    { path: 'min.js', content: 'short\n', encoding: 'utf8', startLine: 1, endLine: 1, totalLines: 3 },
                ]);
                expect(result.structuredContent.omittedPaths).toBeUndefined();
                expect(result.content[1].text).toMatch(
                    / Returned lines 1-1 of 3 of min\.js\. Continue with startLine 2\.$/,
                );
            });

            it('returns the listing for a single-line file requested alone', async () => {
                mockFile('x'.repeat(MAX_INLINE_BYTES + 1));

                const result = await callTool({ paths: ['min.js'] });

                expect(result.isError).toBeFalsy();
                expect(result.structuredContent.revision).toMatch(/^[0-9a-f]{16}$/);
                expect(result.structuredContent.omittedPaths).toEqual(['min.js']);
                expect(result.content[1].text).toMatch(
                    / Returned the listing only\. Line 1 of min\.js is over 256 KiB on its own, so it cannot be returned\.$/,
                );
                expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
            });
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
                mockActor([
                    { versionNumber: '0.1', sourceType: 'SOURCE_FILES' },
                    { versionNumber: '0.2', sourceType: 'SOURCE_FILES' },
                ]),
            );
            versionGetMock.mockResolvedValue(mockVersion({ versionNumber: '0.2' }));

            const { structuredContent } = await callTool({ versionNumber: '0.2' });

            expect(versionMock).toHaveBeenCalledWith('0.2');
            expect(structuredContent.versionNumber).toBe('0.2');
        });

        it('refuses a version the Actor does not have', async () => {
            const text = await callToolExpectingUserError({ versionNumber: '9.9' });

            expect(text).toBe("Actor 'john/my-actor' has no version 9.9; available versions: 0.1.");
        });

        it('refuses an Actor without versions', async () => {
            actorGetMock.mockResolvedValue(mockActor([]));

            expect(await callToolExpectingUserError({})).toBe("Actor 'john/my-actor' has no versions.");
        });

        it('reports a missing Actor and that a bare name is not enough', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const text = await callToolExpectingUserError({ actor: 'my-actor' });

            expect(text).toBe(
                "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
            );
        });

        it('reports a version that disappeared after the Actor was read', async () => {
            versionGetMock.mockResolvedValue(undefined);

            expect(await callToolExpectingUserError({})).toBe("Actor 'john/my-actor' has no version 0.1.");
        });

        it('returns an API 4xx as an error with its message, recording 403 as AUTH', async () => {
            actorGetMock.mockRejectedValue(apiError(403, 'Insufficient permissions for the Actor.'));

            const result = await callTool({});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe('Insufficient permissions for the Actor.');
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({ toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.AUTH }),
            );
        });

        it.each([400, 404])('returns an API %i from the version read as an invalid input error', async (status) => {
            versionGetMock.mockRejectedValue(apiError(status, 'Version request failed.'));

            const result = await callTool({});

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe('Version request failed.');
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({ failureCategory: FAILURE_CATEGORY.INVALID_INPUT }),
            );
        });

        it('rethrows an API 5xx', async () => {
            actorGetMock.mockRejectedValue(apiError(503, 'Service unavailable'));

            await expect(callTool({})).rejects.toThrow('Service unavailable');
        });
    });

    describe('hidden and unsupported sources', () => {
        it('says the API hides the source from accounts that cannot modify the Actor', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: undefined }));

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "Version 0.1 of john/my-actor came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.",
            );
        });

        it.each([
            ['TARBALL', 'tarballUrl'],
            ['GIT_REPO', 'gitRepoUrl'],
            ['GITHUB_GIST', 'gitHubGistUrl'],
        ])('says the API hides the source of a %s version that comes back without %s', async (sourceType) => {
            // What the API returns to a reader that cannot modify the Actor: the number, type, and build tag only.
            versionGetMock.mockResolvedValue({ versionNumber: '0.1', sourceType, buildTag: 'latest' });

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "Version 0.1 of john/my-actor came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.",
            );
        });

        it.each(['SOURCE_CODE', 'SOMETHING_NEW'])(
            'reports the %s source type as unsupported, not hidden',
            async (sourceType) => {
                versionGetMock.mockResolvedValue(mockVersion({ sourceType, sourceFiles: undefined }));

                const text = await callToolExpectingUserError({});

                expect(text).toBe(
                    `Version 0.1 of john/my-actor has source type ${sourceType}, which this tool does not support. Open the version in Apify Console to see its source.`,
                );
            },
        );
    });

    describe('URL sources', () => {
        it('reports a Git repository split into repository, branch, and directory', async () => {
            const gitRepoUrl = 'https://github.com/john/scrapers.git#main:actors/my-actor';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl, sourceFiles: undefined }),
            );

            const result = await callTool({ paths: ['src/main.js'] });

            expect(result.structuredContent).toEqual({
                actorId: 'actor-1',
                fullName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'GIT_REPO',
                buildTag: 'latest',
                revision: sha256Prefix(`GIT_REPO\0${gitRepoUrl}`),
                files: [],
                contents: [],
                envVars: [
                    { name: 'API_KEY', isSecret: true },
                    { name: 'MODE', isSecret: false },
                ],
                gitRepoUrl,
                repository: 'https://github.com/john/scrapers.git',
                branch: 'main',
                directory: 'actors/my-actor',
            });
            expect(result.content[1].text).toBe(
                `Version 0.1 of john/my-actor builds from the Git repository https://github.com/john/scrapers.git, branch main, directory actors/my-actor, revision ${result.structuredContent.revision}. Its source is not stored on Apify, and nothing outside the Apify API is fetched, so no files are returned.`,
            );
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
            expectNoToolNamed(result);
        });

        it.each([
            ['https://github.com/john/repo', { repository: 'https://github.com/john/repo' }],
            ['https://github.com/john/repo#dev', { repository: 'https://github.com/john/repo', branch: 'dev' }],
            ['git@github.com:john/repo.git#:src', { repository: 'git@github.com:john/repo.git', directory: 'src' }],
        ])('splits %s', async (gitRepoUrl, expected) => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl, sourceFiles: undefined }),
            );

            const { structuredContent } = await callTool({});

            expect(structuredContent).toMatchObject({ gitRepoUrl, ...expected });
            for (const key of ['branch', 'directory'].filter((field) => !(field in expected))) {
                expect(structuredContent).not.toHaveProperty(key);
            }
        });

        it('removes the query string and the http credentials from a Git URL, for the fields and the revision', async () => {
            const gitRepoUrl =
                'https://oauth2:secret-token@gitlab.com/john/repo.git?private_token=secret-query#main:src';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl, sourceFiles: undefined }),
            );
            const cleanUrl = 'https://gitlab.com/john/repo.git#main:src';

            const result = await callTool({});

            expect(result.structuredContent).toMatchObject({
                gitRepoUrl: cleanUrl,
                repository: 'https://gitlab.com/john/repo.git',
                branch: 'main',
                directory: 'src',
                revision: sha256Prefix(`GIT_REPO\0${cleanUrl}`),
            });
            for (const secret of ['secret-token', 'secret-query', 'oauth2']) {
                expect(JSON.stringify(result)).not.toContain(secret);
            }
        });

        it('keeps the SSH user of a Git URL, which is not a secret', async () => {
            const gitRepoUrl = 'ssh://git@github.com/john/repo.git?x=secret-query#main';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl, sourceFiles: undefined }),
            );

            const { structuredContent } = await callTool({});

            expect(structuredContent.gitRepoUrl).toBe('ssh://git@github.com/john/repo.git#main');
        });

        it('reports a GitHub gist without its query string', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceType: 'GITHUB_GIST',
                    gitHubGistUrl: 'https://gist.github.com/john/abc123?secret=secret-query',
                    sourceFiles: undefined,
                }),
            );

            const result = await callTool({});

            expect(result.structuredContent.gitHubGistUrl).toBe('https://gist.github.com/john/abc123');
            expect(result.structuredContent.revision).toBe(
                sha256Prefix('GITHUB_GIST\0https://gist.github.com/john/abc123'),
            );
            expect(JSON.stringify(result)).not.toContain('secret-query');
        });

        it('reports a GitHub gist', async () => {
            const gitHubGistUrl = 'https://gist.github.com/john/abc123';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GITHUB_GIST', gitHubGistUrl, sourceFiles: undefined }),
            );

            const result = await callTool({});

            expect(result.structuredContent).toMatchObject({
                gitHubGistUrl,
                files: [],
                contents: [],
                revision: sha256Prefix(`GITHUB_GIST\0${gitHubGistUrl}`),
            });
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it.each([
            [
                'https://downloads.example.com/source.zip?token=secret-signature',
                'https://downloads.example.com/source.zip',
            ],
            [
                'https://api.example.test/v2/actor-builds/abc?token=secret-signature',
                'https://api.example.test/v2/actor-builds/abc',
            ],
            // A record URL on another host is reported as an outside zip, not refused as one of this API's stores.
            [
                `https://evil.example.test${RECORD_PATH}?signature=secret-signature`,
                `https://evil.example.test${RECORD_PATH}`,
            ],
            [
                'https://user:secret-signature@downloads.example.com/source.zip',
                'https://downloads.example.com/source.zip',
            ],
        ])('reports the zip at %s without its secrets', async (tarballUrl, strippedUrl) => {
            versionGetMock.mockResolvedValue(mockTarballVersion(tarballUrl));

            const result = await callTool({});

            expect(result.structuredContent).toMatchObject({
                sourceType: 'TARBALL',
                tarballUrl: strippedUrl,
                files: [],
                contents: [],
                revision: sha256Prefix(`TARBALL\0${strippedUrl}`),
            });
            expect(JSON.stringify(result)).not.toContain('secret-signature');
            expect(result.content[1].text).toMatch(
                / builds from the zip at \S+, revision [0-9a-f]{16}\. This tool does not download zips, so no files are returned\.$/,
            );
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });

        it('refuses a version stored as a zip in a key-value store of this API, without its URL', async () => {
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const result = await callTool({});

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                'Version 0.1 of john/my-actor is stored as a zip (TARBALL), and versions stored as a zip cannot be read' +
                    ' with this tool yet. Open the version in Apify Console to see its source.',
            );
            expect(result.structuredContent).toBeUndefined();
            expect(JSON.stringify(result)).not.toContain(RECORD_PATH);
        });
    });
});
