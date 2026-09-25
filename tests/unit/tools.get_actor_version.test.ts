import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
import { getCategoryTools, toolCategoriesEnabledByDefault } from '../../src/tools/index.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { getCrc32, readSourceArchive } from '../../src/tools/source/source_archive.js';
import { getActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';
import { buildZipArchive, type ZipEntryOptions } from './helpers/zip_archive.js';

const actorGetMock = vi.fn();
const versionGetMock = vi.fn();
const versionMock = vi.fn(() => ({ get: versionGetMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock }));
const listKeysMock = vi.fn();
const getRecordMock = vi.fn();
const keyValueStoreMock = vi.fn(() => ({ listKeys: listKeysMock, getRecord: getRecordMock }));

const stubClient = {
    actor: actorMock,
    keyValueStore: keyValueStoreMock,
    baseUrl: 'https://api.example.test/v2',
} as unknown as InternalToolArgs['apifyClient'];

const RECORD_KEY = 'version-0.1.zip';
const RECORD_URL = `https://api.example.test/v2/key-value-stores/store-1/records/${RECORD_KEY}?signature=secret-signature`;

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

/** Stores the zip as the version's record, with the size the key listing reports. */
function stubArchive(zip: Buffer, listedSize = zip.length): void {
    listKeysMock.mockResolvedValue({ items: [{ key: RECORD_KEY, size: listedSize }] });
    getRecordMock.mockResolvedValue({ key: RECORD_KEY, value: zip, contentType: 'application/zip' });
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
        listKeysMock.mockReset();
        getRecordMock.mockReset();
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
            expect(keyValueStoreMock).not.toHaveBeenCalled();
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
                    ' 1 base64 file is in the listing only; name it in paths to read it.',
            );
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
            const serialized = JSON.stringify(result);
            for (const secret of ['user-secret', 'secret-value', 'secret-hash', 'plain-value']) {
                expect(serialized).not.toContain(secret);
            }
            expectNoToolNamed(result);
        });

        it('sorts the manifest by UTF-8 bytes and computes the revision over sorted path and hash lines', async () => {
            // Locale order puts package.json before README.md, and UTF-16 order puts the emoji before the fullwidth z.
            const names = ['\u{1F600}.txt', 'package.json', 'src/main.js', '\uFF5A.txt', 'README.md', 'Dockerfile'];
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: names.map((name) => ({ name, format: 'TEXT', content: `${name}\n` })) }),
            );
            const sortedNames = [
                'Dockerfile',
                'README.md',
                'package.json',
                'src/main.js',
                '\uFF5A.txt',
                '\u{1F600}.txt',
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
            expect(reencoded.content[1].text).toContain(' 1 base64 file is in the listing only;');
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

        it('normalizes inline paths the way the build worker and the zip reader do', async () => {
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
                ' 1 base64 file is in the listing only; name it in paths to read it.',
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
                / Returned the content of 1 file \(0\.1 KiB\)\. 1 base64 file is over 256 KiB as base64, so it cannot be returned; read it with the Apify CLI \(apify pull\)\.$/,
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
                ' Left out to stay within 256 KiB: file-00.txt; request them in another call. No file at: missing.js.',
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

        it('says which omitted files are over the limit on their own', async () => {
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
                ' Over 256 KiB on their own: big.txt; request one alone to read it in line ranges.' +
                    ' Over 256 KiB on their own, first line included: min.js; request one alone to see which of its lines can be returned.' +
                    ' Over 256 KiB as base64, so they cannot be returned: big.bin; read them with the Apify CLI (apify pull).',
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
                ' Returned lines 1-256 of 300 of big.js. The whole file is over the 256 KiB limit. Continue with startLine 257.',
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

            it('says when the long line is the last one', async () => {
                mockFile(`short\n${LONG_LINE}`);

                const result = await callTool({ paths: ['min.js'], startLine: 2 });

                expect(result.content[1].text).toMatch(
                    / Line 2 of min\.js is over 256 KiB on its own, so it cannot be returned\. It is the last line of the file\.$/,
                );
            });

            it('names the long line when the range stops just before it', async () => {
                mockFile(`short\n${LONG_LINE}tail\n`);

                const result = await callTool({ paths: ['min.js'] });

                expect(result.structuredContent.contents).toEqual([
                    { path: 'min.js', content: 'short\n', encoding: 'utf8', startLine: 1, endLine: 1, totalLines: 3 },
                ]);
                expect(result.structuredContent.omittedPaths).toBeUndefined();
                expect(result.content[1].text).toContain(
                    ' Returned lines 1-1 of 3 of min.js. The whole file is over the 256 KiB limit.' +
                        ' Line 2 of min.js is over 256 KiB on its own, so it cannot be returned. Pass startLine 3 to skip it.',
                );
                expect(result.content[1].text).not.toContain('Continue with');
            });

            it('returns the listing for a single-line file requested alone', async () => {
                mockFile('x'.repeat(MAX_INLINE_BYTES + 1));

                const result = await callTool({ paths: ['min.js'] });

                expect(result.isError).toBeFalsy();
                expect(result.structuredContent.revision).toMatch(/^[0-9a-f]{16}$/);
                expect(result.structuredContent.omittedPaths).toEqual(['min.js']);
                expect(result.content[1].text).toMatch(
                    / Returned the listing only\. min\.js is a single line over 256 KiB, so it cannot be read by lines\.$/,
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
            expect(keyValueStoreMock).not.toHaveBeenCalled();
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
            expect(keyValueStoreMock).not.toHaveBeenCalled();
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
            // A record URL on another host is not read from this API as if it were one of its stores.
            [
                `https://evil.example.test/v2/key-value-stores/store-1/records/${RECORD_KEY}?signature=secret-signature`,
                `https://evil.example.test/v2/key-value-stores/store-1/records/${RECORD_KEY}`,
            ],
            [
                'https://user:secret-signature@downloads.example.com/source.zip',
                'https://downloads.example.com/source.zip',
            ],
        ])('reports the zip at %s without its secrets and never fetches it', async (tarballUrl, strippedUrl) => {
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
                / Only key-value store records of this Apify API are read, so no files are returned\.$/,
            );
            expect(keyValueStoreMock).not.toHaveBeenCalled();
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
        });
    });

    describe('zip-stored TARBALL', () => {
        const ZIP_ENTRIES: ZipEntryOptions[] = [
            { name: 'src/', method: 0 },
            { name: MAIN_JS_SOURCE.name, data: MAIN_JS_SOURCE.content, hasDataDescriptor: true },
            { name: ACTOR_JSON_SOURCE.name, data: ACTOR_JSON_SOURCE.content, method: 0 },
            { name: LOGO_SOURCE.name, data: LOGO_BYTES, hasDataDescriptor: true },
        ];

        beforeEach(() => {
            versionGetMock.mockResolvedValue(mockTarballVersion());
            stubArchive(buildZipArchive(ZIP_ENTRIES));
        });

        it('reads the record with the caller token and returns the same output as inline storage', async () => {
            versionGetMock.mockResolvedValueOnce(mockVersion());
            const inline = await callTool({});
            expect(keyValueStoreMock).not.toHaveBeenCalled();

            const result = await callTool({});

            expect(keyValueStoreMock).toHaveBeenCalledWith('store-1');
            expect(listKeysMock).toHaveBeenCalledWith({ prefix: RECORD_KEY });
            expect(getRecordMock).toHaveBeenCalledWith(RECORD_KEY, { buffer: true });
            expect(result.structuredContent).toEqual({ ...inline.structuredContent, sourceType: 'TARBALL' });
            expect(result.content[1].text).toContain(
                'Read version 0.1 of john/my-actor, stored as a zip in key-value store store-1 (TARBALL): 3 files',
            );
            expect(JSON.stringify(result)).not.toContain('secret-signature');
            expectSchemaConformingStructuredContent(result, getActorVersionToolOutputSchema);
            expectNoToolNamed(result);
        });

        it('returns a zip entry as base64 when it has a binary extension or is not UTF-8', async () => {
            const notUtf8 = Buffer.from([0xc3, 0x28]);
            stubArchive(
                buildZipArchive([
                    { name: 'data.bin', data: 'plain text' },
                    { name: 'notes.txt', data: notUtf8 },
                    { name: 'bom.txt', data: '\uFEFFwith bom' },
                ]),
            );

            const { structuredContent } = await callTool({ paths: ['data.bin', 'notes.txt', 'bom.txt'] });

            expect(structuredContent.files.map(({ path, format }) => [path, format])).toEqual([
                ['bom.txt', 'TEXT'],
                ['data.bin', 'BASE64'],
                ['notes.txt', 'BASE64'],
            ]);
            expect(structuredContent.contents).toEqual([
                { path: 'data.bin', content: Buffer.from('plain text').toString('base64'), encoding: 'base64' },
                { path: 'notes.txt', content: notUtf8.toString('base64'), encoding: 'base64' },
                { path: 'bom.txt', content: '\uFEFFwith bom', encoding: 'utf8' },
            ]);
            expect(structuredContent.files[0].hash).toBe(sha256Prefix(Buffer.from('\uFEFFwith bom')));
        });

        it('refuses a zip the key listing reports over 50 MiB before downloading it', async () => {
            stubArchive(buildZipArchive(ZIP_ENTRIES), 50 * 1024 * 1024 + 1);

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "The version's zip is 50.1 MiB, over the 50 MiB this tool reads; read it with the Apify CLI (apify pull) instead.",
            );
            expect(getRecordMock).not.toHaveBeenCalled();
        });

        it('refuses a downloaded zip over 50 MiB even when the key listing reported less', async () => {
            stubArchive(Buffer.alloc(50 * 1024 * 1024 + 1), 1000);

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "The version's zip is 50.1 MiB, over the 50 MiB this tool reads; read it with the Apify CLI (apify pull) instead.",
            );
        });

        it('reports a record that does not exist', async () => {
            listKeysMock.mockResolvedValue({ items: [] });

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                `The version points at record ${RECORD_KEY} in key-value store store-1, which does not exist.`,
            );
            expect(getRecordMock).not.toHaveBeenCalled();
        });

        it('reports a store that does not exist', async () => {
            listKeysMock.mockRejectedValue(apiError(404, 'Store not found'));

            expect(await callToolExpectingUserError({})).toContain('which does not exist.');
        });

        it('refuses a zip it cannot read safely with a user error', async () => {
            stubArchive(buildZipArchive([{ name: '../escape.js', data: 'x' }]));

            const text = await callToolExpectingUserError({});

            expect(text).toBe("The version's zip was refused: entry ../escape.js has a '..' segment.");
        });
    });
});

describe('readSourceArchive()', () => {
    const readPaths = (zip: Buffer) => [...readSourceArchive(zip).keys()];

    it('reads stored, deflated, and data-descriptor entries and skips folders', () => {
        const files = readSourceArchive(
            buildZipArchive([
                { name: 'src/', method: 0 },
                { name: 'src/main.js', data: 'deflated', hasDataDescriptor: true },
                { name: 'README.md', data: 'stored', method: 0 },
                { name: './lib\\util.js', data: 'normalized' },
                { name: 'empty.txt', data: '' },
            ]),
        );

        expect([...files.keys()]).toEqual(['src/main.js', 'README.md', 'lib/util.js', 'empty.txt']);
        expect(Buffer.from(files.get('src/main.js')!).toString()).toBe('deflated');
        expect(Buffer.from(files.get('README.md')!).toString()).toBe('stored');
        expect(files.get('empty.txt')).toHaveLength(0);
    });

    it('keeps an entry named __proto__ as a file', () => {
        const files = readSourceArchive(buildZipArchive([{ name: '__proto__', data: 'x' }]));

        expect([...files.keys()]).toEqual(['__proto__']);
        expect(Object.getPrototypeOf(files)).toBe(Map.prototype);
    });

    it('reads a zip with a comment after the end record', () => {
        const zip = buildZipArchive([{ name: 'a.js', data: 'a' }]);
        zip.writeUInt16LE(5, zip.length - 2);

        expect(readPaths(Buffer.concat([zip, Buffer.from('hello')]))).toEqual(['a.js']);
    });

    it.each<[string, ZipEntryOptions[], string]>([
        ['an absolute path', [{ name: '/etc/passwd', data: 'x' }], 'entry /etc/passwd has an absolute path'],
        ['a Windows drive path', [{ name: 'C:\\evil.js', data: 'x' }], 'entry C:\\evil.js has an absolute path'],
        ['a .. segment', [{ name: 'src/../../evil.js', data: 'x' }], "entry src/../../evil.js has a '..' segment"],
        ['a NUL in a name', [{ name: 'a\0b.js', data: 'x' }], 'an entry name contains a NUL character'],
        [
            'a regular file whose name is empty after normalization',
            [{ name: '.', data: 'x' }],
            'entry . has an empty path',
        ],
        [
            'a name over 255 characters',
            [{ name: `${'a'.repeat(256)}.js`, data: 'x' }],
            `entry ${'a'.repeat(40)}... has a name over 255 characters`,
        ],
        [
            'names that repeat after normalization',
            [
                { name: 'src/a.js', data: 'x' },
                { name: './src//a.js', data: 'y' },
            ],
            'the path src/a.js appears more than once',
        ],
        ['an encrypted entry', [{ name: 'a.js', data: 'x', flags: 0x0001 }], 'entry a.js is encrypted'],
        ['a strongly encrypted entry', [{ name: 'a.js', data: 'x', flags: 0x0040 }], 'entry a.js is encrypted'],
        [
            'an entry of an encrypted central directory',
            [{ name: 'a.js', data: 'x', flags: 0x2000 }],
            'entry a.js is encrypted',
        ],
        [
            'a local header with another name',
            [{ name: 'a.js', data: 'x', localName: 'b.js' }],
            'entry a.js has a local header that does not match the central directory',
        ],
        [
            'a local header with another compression method',
            [{ name: 'a.js', data: 'x', localMethod: 0 }],
            'entry a.js has a local header that does not match the central directory',
        ],
        [
            'an unsupported compression method',
            [{ name: 'a.js', data: 'x', method: 12 }],
            'entry a.js uses compression method 12; only stored and deflated entries are read',
        ],
        [
            'a symbolic link',
            [{ name: 'link.js', data: '/etc/passwd', method: 0, externalAttributes: (0o120777 << 16) >>> 0 }],
            'entry link.js is a symbolic link',
        ],
        [
            'a special file',
            [{ name: 'fifo', data: '', method: 0, externalAttributes: (0o010644 << 16) >>> 0 }],
            'entry fifo is not a regular file or a folder',
        ],
        [
            'a zip64 extra field',
            [{ name: 'a.js', data: 'x', extraField: Buffer.from([0x01, 0x00, 0x00, 0x00]) }],
            'entry a.js uses zip64',
        ],
        ['a zip64 size marker', [{ name: 'a.js', data: 'x', uncompressedSize: 0xffffffff }], 'entry a.js uses zip64'],
        [
            'a declared size smaller than the data',
            [{ name: 'a.js', data: 'x'.repeat(1000), uncompressedSize: 10 }],
            'entry a.js is corrupt or larger than it declares',
        ],
        [
            'a declared size larger than the data',
            [{ name: 'a.js', data: 'short', uncompressedSize: 1000 }],
            'entry a.js is not the size it declares',
        ],
        [
            'a stored entry with two different sizes',
            [{ name: 'a.js', data: 'short', method: 0, compressedSize: 3 }],
            'entry a.js is stored uncompressed but declares two different sizes',
        ],
        [
            'a compressed size that runs past the data',
            [{ name: 'a.js', data: 'x', compressedSize: 10_000 }],
            'entry a.js points outside the archive',
        ],
        ['a bad CRC-32', [{ name: 'a.js', data: 'content', crc32: 12345 }], 'entry a.js fails its CRC-32 check'],
        [
            'a stored entry with a bad CRC-32',
            [{ name: 'a.js', data: 'content', method: 0, crc32: 12345 }],
            'entry a.js fails its CRC-32 check',
        ],
        [
            // Exactly 64 MiB passes the total check, so the entry's own size check is what refuses it.
            'a declared total of exactly 64 MiB only by the entry sizes',
            [
                { name: 'a.js', data: 'x', uncompressedSize: 32 * 1024 * 1024 },
                { name: 'b.js', data: 'x', uncompressedSize: 32 * 1024 * 1024 },
            ],
            'entry a.js is not the size it declares',
        ],
        [
            'a declared total over 64 MiB',
            [
                { name: 'a.js', data: 'x', uncompressedSize: 40 * 1024 * 1024 },
                { name: 'b.js', data: 'x', uncompressedSize: 40 * 1024 * 1024 },
            ],
            'its entries declare more than 64 MiB uncompressed',
        ],
    ])('refuses %s', (_label, entries, reason) => {
        expect(() => readSourceArchive(buildZipArchive(entries))).toThrow(`The version's zip was refused: ${reason}.`);
    });

    it('skips a root folder entry and a Unix folder without a trailing slash', () => {
        const folderAttributes = (0o040755 << 16) >>> 0;

        expect(
            readPaths(
                buildZipArchive([
                    { name: './', method: 0 },
                    { name: 'lib', method: 0, externalAttributes: folderAttributes },
                    { name: 'a.js', data: 'a' },
                ]),
            ),
        ).toEqual(['a.js']);
    });

    it('finds the data where the local header says when its extra field differs from the central one', () => {
        // Info-ZIP writes an extended timestamp of 28 bytes locally and 24 bytes in the central directory.
        const buildTimestampField = (dataLength: number) =>
            Buffer.concat([Buffer.from([0x55, 0x54, dataLength, 0]), Buffer.alloc(dataLength, 1)]);
        const files = readSourceArchive(
            buildZipArchive([
                {
                    name: 'src/main.js',
                    data: 'deflated',
                    hasDataDescriptor: true,
                    localExtraField: buildTimestampField(24),
                    extraField: buildTimestampField(20),
                },
                { name: 'README.md', data: 'stored', method: 0, localExtraField: buildTimestampField(24) },
            ]),
        );

        expect(Buffer.from(files.get('src/main.js')!).toString()).toBe('deflated');
        expect(Buffer.from(files.get('README.md')!).toString()).toBe('stored');
    });

    it('refuses an end record that declares fewer entries than the central directory holds', () => {
        const zip = buildZipArchive(
            [
                { name: 'a.js', data: 'a' },
                { name: 'hidden.js', data: 'b' },
            ],
            { declaredEntryCount: 1 },
        );

        expect(() => readSourceArchive(zip)).toThrow(
            "The version's zip was refused: its central directory does not match its end record.",
        );
    });

    it('ignores an end record signature inside the comment', () => {
        const comment = Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(30, 0x78)]);

        expect(readPaths(buildZipArchive([{ name: 'a.js', data: 'a' }], { comment }))).toEqual(['a.js']);
    });

    it('reads exactly 10,000 entries', () => {
        const entries = Array.from({ length: 10_000 }, (_, index) => ({ name: `f${index}`, method: 0 }));

        expect(readPaths(buildZipArchive(entries))).toHaveLength(10_000);
    });

    it('refuses more than 10,000 entries', () => {
        const entries = Array.from({ length: 10_001 }, (_, index) => ({ name: `f${index}`, method: 0 }));

        expect(() => readSourceArchive(buildZipArchive(entries))).toThrow(
            "The version's zip was refused: it has 10001 entries, over the 10000 this tool reads.",
        );
    });

    it('refuses a zip64 end of central directory locator', () => {
        const zip = buildZipArchive([{ name: 'a.js', data: 'x' }], { hasZip64Locator: true });

        expect(() => readSourceArchive(zip)).toThrow("The version's zip was refused: it is a zip64 archive.");
    });

    it('refuses bytes that are not a zip', () => {
        expect(() => readSourceArchive(Buffer.from('not a zip at all, just some text'))).toThrow(
            "The version's zip was refused: it is not a zip archive.",
        );
    });

    it('refuses a truncated zip', () => {
        const zip = buildZipArchive([{ name: 'a.js', data: 'x'.repeat(100) }]);

        expect(() => readSourceArchive(zip.subarray(0, zip.length - 10))).toThrow('not a zip archive');
    });
});

describe('getCrc32()', () => {
    it('matches the standard check value', () => {
        expect(getCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
        expect(getCrc32(Buffer.alloc(0))).toBe(0);
    });
});
