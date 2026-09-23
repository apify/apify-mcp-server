import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import type { Zippable } from 'fflate';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES, TOOL_STATUS } from '../../src/const.js';
import { pullActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import { pullActor } from '../../src/tools/versions/pull_actor.js';
import { pushActor } from '../../src/tools/versions/push_actor.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
} from './helpers/tool_context.js';

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
const RECORD_URL = `https://api.example.test/v2/key-value-stores/store-1/records/${RECORD_KEY}`;
const PUSH_MERGE_STEP = `Edit the files and push them back with ${HELPER_TOOLS.ACTOR_PUSH}; mode merge sends only the edited files.`;
const PUSH_REPLACE_STEP = `Edit the files and push them back with ${HELPER_TOOLS.ACTOR_PUSH} and mode replace, sending all files; a version stored as a zip cannot be merged into.`;

const ACTOR_JSON_SOURCE = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 1}' };
const MAIN_JS_SOURCE = { name: 'src/main.js', format: 'TEXT', content: 'console.log("hi");' };
const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
const LOGO_SOURCE = { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') };

/** An Actor API document; `userId` is an internal field the tool must not leak. */
function mockActor(versionNumbers: string[] = ['0.1']) {
    return {
        id: 'actor-1',
        userId: 'user-secret',
        name: 'my-actor',
        username: 'john',
        versions: versionNumbers.map((versionNumber) => ({ versionNumber, sourceType: 'SOURCE_FILES' })),
    };
}

/** A SOURCE_FILES version with a folder entry, the way Console stores an empty folder, and env vars that must not leak. */
function mockVersion(overrides: Record<string, unknown> = {}) {
    return {
        versionNumber: '0.1',
        buildTag: 'latest',
        sourceType: 'SOURCE_FILES',
        envVars: [{ name: 'SECRET_KEY', value: 'secret-value', isSecret: true }],
        sourceFiles: [ACTOR_JSON_SOURCE, { name: 'src', folder: true }, MAIN_JS_SOURCE, LOGO_SOURCE],
        ...overrides,
    };
}

/** A TARBALL version; the stale `sourceFiles` a switched version keeps must not be returned. */
function mockTarballVersion(tarballUrl = RECORD_URL) {
    return mockVersion({ sourceType: 'TARBALL', tarballUrl, sourceFiles: [MAIN_JS_SOURCE] });
}

/** Stores the entries as the version's zip record. */
function stubArchive(entries: Zippable): void {
    const zip = Buffer.from(zipSync(entries));
    listKeysMock.mockResolvedValue({ items: [{ key: RECORD_KEY, size: zip.length }] });
    getRecordMock.mockResolvedValue({ key: RECORD_KEY, value: zip, contentType: 'application/zip' });
}

function apiError(status: number, message: string): ApifyApiError {
    return new ApifyApiError({ data: { error: { type: 'some-error', message } }, status } as AxiosResponse, 1);
}

const callTool = async (args: Record<string, unknown>, loadedToolNames?: readonly string[]) => {
    const context = stubToolCallContext({ actor: 'my-actor', ...args }, stubClient);
    if (loadedToolNames) context.loadedToolNames = loadedToolNames;
    return (await (pullActor as HelperTool).call(context)) as TextToolResult;
};

/** Calls the tool expecting a soft-fail result and returns its first text block. */
const callToolExpectingUserError = async (args: Record<string, unknown>) => {
    const result = await (pullActor as HelperTool).call(
        stubToolCallContext({ actor: 'my-actor', ...args }, stubClient),
    );
    expectSoftFailInvalidInput(result);
    return (result as TextToolResult).content[0].text;
};

/** Every tool name except pull-actor itself, which the result text never needs to name. */
const OTHER_TOOL_NAMES = Object.values(HELPER_TOOLS).filter((name) => name !== HELPER_TOOLS.ACTOR_PULL);

const expectNoOtherToolNamed = (text: string) => {
    for (const name of OTHER_TOOL_NAMES) expect(text).not.toContain(name);
};

const totalContentBytes = (files: { content: string }[]) =>
    files.reduce((total, { content }) => total + Buffer.byteLength(content, 'utf8'), 0);

describe('pull-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listKeysMock.mockReset();
        getRecordMock.mockReset();
        actorGetMock.mockResolvedValue(mockActor());
        versionGetMock.mockResolvedValue(mockVersion());
    });

    it('has the expected tool name', () => {
        expect(pullActor.name).toBe(HELPER_TOOLS.ACTOR_PULL);
    });

    it('declares a read-only, idempotent, closed-world tool without payment', () => {
        expect(pullActor.annotations).toEqual({
            title: 'Pull Actor',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect((pullActor as HelperTool).paymentRequired).toBeUndefined();
    });

    describe('SOURCE_FILES', () => {
        it('returns the files with their encodings and skips folder entries', async () => {
            const result = await callTool({});
            const { content, structuredContent } = result;

            expect(actorMock).toHaveBeenCalledWith('my-actor');
            // The version is read through the resolved Actor ID, not the user-supplied selector.
            expect(actorMock).toHaveBeenCalledWith('actor-1');
            expect(versionMock).toHaveBeenCalledWith('0.1');
            expect(keyValueStoreMock).not.toHaveBeenCalled();
            expect(structuredContent).toEqual({
                actorId: 'actor-1',
                actorName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'SOURCE_FILES',
                files: [
                    { path: '.actor/actor.json', content: ACTOR_JSON_SOURCE.content, encoding: 'utf8' },
                    { path: 'src/main.js', content: MAIN_JS_SOURCE.content, encoding: 'utf8' },
                    { path: 'assets/logo.png', content: LOGO_SOURCE.content, encoding: 'base64' },
                ],
            });
            expect(JSON.parse(content[0].text)).toEqual(structuredContent);
            expect(content).toHaveLength(2);
            expect(content[1].text).toBe(`Pulled 3 of 3 files of john/my-actor version 0.1.\n${PUSH_MERGE_STEP}`);
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
            expect(JSON.stringify(result)).not.toContain('user-secret');
            expect(JSON.stringify(result)).not.toContain('secret-value');
        });

        it('returns files push-actor accepts as they are', async () => {
            const { structuredContent } = (await callTool({})) as TextToolResult & {
                structuredContent: { files: unknown[] };
            };

            expect((pushActor as HelperTool).ajvValidate({ actor: 'my-actor', files: structuredContent.files })).toBe(
                true,
            );
        });

        it('names no other tool when push-actor is not loaded', async () => {
            const { content } = await callTool({}, [HELPER_TOOLS.ACTOR_PULL]);

            expect(content[1].text).toBe(
                'Pulled 3 of 3 files of john/my-actor version 0.1.\nEdit the files and push them back to this version.',
            );
            expectNoOtherToolNamed(content[1].text);
        });

        it('reports a version whose source the API hides', async () => {
            versionGetMock.mockResolvedValue({ versionNumber: '0.1', sourceType: 'SOURCE_FILES', buildTag: 'latest' });

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "Version 0.1 of john/my-actor came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.",
            );
        });
    });

    describe('paths', () => {
        it('returns only the requested files', async () => {
            const { content, structuredContent } = await callTool({ paths: ['src/main.js'] });

            expect(structuredContent).toMatchObject({
                files: [{ path: 'src/main.js', content: MAIN_JS_SOURCE.content, encoding: 'utf8' }],
            });
            expect(structuredContent).not.toHaveProperty('omittedFiles');
            expect(structuredContent).not.toHaveProperty('notFoundPaths');
            expect(content[1].text).toBe(`Pulled 1 of 3 files of john/my-actor version 0.1.\n${PUSH_MERGE_STEP}`);
        });

        it('lists requested paths the version has no file at', async () => {
            const result = await callTool({ paths: ['src/main.js', 'src/missing.js', 'src', 'src/missing.js'] });
            const { content, structuredContent } = result;

            // A folder entry is not a file, and a path requested twice is reported once.
            expect(structuredContent).toMatchObject({
                files: [{ path: 'src/main.js' }],
                notFoundPaths: ['src/missing.js', 'src'],
            });
            expect(content[1].text).toBe(
                `Pulled 1 of 3 files of john/my-actor version 0.1. The version has no file at: src/missing.js, src.\n${PUSH_MERGE_STEP}`,
            );
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
        });

        it('rejects an empty paths list and an empty path via ajv validation', () => {
            const tool = pullActor as HelperTool;
            expect(tool.ajvValidate({ actor: 'my-actor', paths: [] })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', paths: [''] })).toBe(false);
            expect(tool.ajvValidate({ actor: '' })).toBe(false);
            expect(tool.ajvValidate({ actor: 'my-actor', paths: ['src/main.js'], versionNumber: '0.1' })).toBe(true);
        });

        it('requires only actor in the input schema', () => {
            expect((pullActor as HelperTool).inputSchema.required).toEqual(['actor']);
        });
    });

    describe('size cap', () => {
        const KIB = 1024;
        const textFile = (name: string, bytes: number) => ({ name, format: 'TEXT', content: 'a'.repeat(bytes) });

        it('skips a file that does not fit and still returns the smaller ones after it', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [
                        textFile('a.txt', 100 * KIB),
                        textFile('b.txt', 200 * KIB),
                        textFile('c.txt', 100 * KIB),
                    ],
                }),
            );

            const result = await callTool({});
            const { content, structuredContent } = result as TextToolResult & {
                structuredContent: { files: { path: string; content: string }[] };
            };

            expect(structuredContent.files.map((file) => file.path)).toEqual(['a.txt', 'c.txt']);
            expect(structuredContent).toMatchObject({ omittedFiles: [{ path: 'b.txt', sizeBytes: 200 * KIB }] });
            expect(totalContentBytes(structuredContent.files)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
            expect(content[1].text).toBe(
                `Pulled 2 of 3 files of john/my-actor version 0.1. Left out to keep the response within 256 KiB: 1 file, listed in omittedFiles; call this tool again with their paths to read them.\n${PUSH_MERGE_STEP}`,
            );
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
        });

        it('returns a file of exactly the cap', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [textFile('a.txt', MAX_INLINE_BYTES)] }));

            const { structuredContent } = await callTool({});

            expect(structuredContent).toMatchObject({ files: [{ path: 'a.txt' }] });
            expect(structuredContent).not.toHaveProperty('omittedFiles');
        });

        it('counts base64 content by its encoded length and sizes the file by its decoded bytes', async () => {
            // 200 KiB of bytes is over 266 KiB of base64 text.
            const bytes = Buffer.alloc(200 * KIB, 1);
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [{ name: 'blob.bin', format: 'BASE64', content: bytes.toString('base64') }],
                }),
            );

            const { content, structuredContent } = await callTool({});

            expect(structuredContent).toMatchObject({
                files: [],
                omittedFiles: [{ path: 'blob.bin', sizeBytes: 200 * KIB }],
            });
            expect(content[1].text).toContain(
                'Too large for this tool even on their own: blob.bin; read those with the Apify CLI (apify pull).',
            );
        });

        it('says which files are too large to return even on their own', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [textFile('big.txt', MAX_INLINE_BYTES + 1), textFile('small.txt', 10)] }),
            );

            const { content, structuredContent } = await callTool({});

            expect(structuredContent).toMatchObject({
                files: [{ path: 'small.txt' }],
                omittedFiles: [{ path: 'big.txt', sizeBytes: MAX_INLINE_BYTES + 1 }],
            });
            expect(content[1].text).toContain(
                'call this tool again with their paths to read them. Too large for this tool even on their own: big.txt; read those with the Apify CLI (apify pull).',
            );
        });

        it('returns an omitted file when it is requested by its path', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [textFile('a.txt', 200 * KIB), textFile('b.txt', 200 * KIB)] }),
            );

            const { structuredContent } = await callTool({ paths: ['b.txt'] });

            expect(structuredContent).toMatchObject({ files: [{ path: 'b.txt' }] });
            expect(structuredContent).not.toHaveProperty('omittedFiles');
        });
    });

    describe('TARBALL in the Actor source store', () => {
        const INVALID_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);

        it('downloads the record, unzips it and classifies each file', async () => {
            stubArchive({
                '.actor': { 'actor.json': strToU8(ACTOR_JSON_SOURCE.content) },
                src: { 'main.js': strToU8(MAIN_JS_SOURCE.content) },
                'assets/logo.png': LOGO_BYTES,
                'data/blob.txt': INVALID_UTF8,
                'bom.txt': new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]),
            });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const result = await callTool({});
            const { content, structuredContent } = result;

            expect(keyValueStoreMock).toHaveBeenCalledWith('store-1');
            expect(listKeysMock).toHaveBeenCalledWith({ prefix: RECORD_KEY });
            expect(getRecordMock).toHaveBeenCalledWith(RECORD_KEY, { buffer: true });
            // The directory entries fflate writes for .actor/ and src/ are skipped.
            expect(structuredContent).toEqual({
                actorId: 'actor-1',
                actorName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'TARBALL',
                files: [
                    { path: '.actor/actor.json', content: ACTOR_JSON_SOURCE.content, encoding: 'utf8' },
                    { path: 'src/main.js', content: MAIN_JS_SOURCE.content, encoding: 'utf8' },
                    // Binary by its extension.
                    { path: 'assets/logo.png', content: LOGO_BYTES.toString('base64'), encoding: 'base64' },
                    // Binary because it is not valid UTF-8.
                    {
                        path: 'data/blob.txt',
                        content: Buffer.from(INVALID_UTF8).toString('base64'),
                        encoding: 'base64',
                    },
                    // The byte order mark is kept, so pushing the file back does not change it.
                    { path: 'bom.txt', content: '﻿hi', encoding: 'utf8' },
                ],
            });
            expect(JSON.parse(content[0].text)).toEqual(structuredContent);
            expect(content[1].text).toBe(`Pulled 5 of 5 files of john/my-actor version 0.1.\n${PUSH_REPLACE_STEP}`);
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
            expect(JSON.stringify(result)).not.toContain('key-value-stores/store-1');
        });

        it('ignores the signature in the record URL and keeps it out of the response', async () => {
            stubArchive({ 'src/main.js': strToU8(MAIN_JS_SOURCE.content) });
            versionGetMock.mockResolvedValue(mockTarballVersion(`${RECORD_URL}?signature=abc123`));

            const result = await callTool({});

            expect(getRecordMock).toHaveBeenCalledWith(RECORD_KEY, { buffer: true });
            expect(result.structuredContent).toMatchObject({ files: [{ path: 'src/main.js' }] });
            expect(JSON.stringify(result)).not.toContain('abc123');
        });

        it('names no other tool when push-actor is not loaded', async () => {
            stubArchive({ 'src/main.js': strToU8(MAIN_JS_SOURCE.content) });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const { content } = await callTool({}, [HELPER_TOOLS.ACTOR_PULL]);

            expect(content[1].text).toBe(
                'Pulled 1 of 1 file of john/my-actor version 0.1.\nEdit the files and push all of them back to this version; a version stored as a zip is replaced as a whole.',
            );
            expectNoOtherToolNamed(content[1].text);
        });

        it('returns only the requested entries and lists the missing ones', async () => {
            stubArchive({
                'src/main.js': strToU8(MAIN_JS_SOURCE.content),
                'README.md': strToU8('# Readme'),
            });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const { content, structuredContent } = await callTool({ paths: ['README.md', 'nope.js'] });

            expect(structuredContent).toMatchObject({
                files: [{ path: 'README.md', content: '# Readme', encoding: 'utf8' }],
                notFoundPaths: ['nope.js'],
            });
            expect(content[1].text).toContain('Pulled 1 of 2 files of john/my-actor version 0.1.');
        });

        it('lists entries over the cap with their original size', async () => {
            stubArchive({
                'a.txt': strToU8('a'.repeat(200 * 1024)),
                'b.txt': strToU8('b'.repeat(100 * 1024)),
                'c.txt': strToU8('c'.repeat(50 * 1024)),
            });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const result = await callTool({});
            const { structuredContent } = result as TextToolResult & {
                structuredContent: { files: { path: string; content: string }[] };
            };

            expect(structuredContent.files.map((file) => file.path)).toEqual(['a.txt', 'c.txt']);
            expect(structuredContent).toMatchObject({ omittedFiles: [{ path: 'b.txt', sizeBytes: 100 * 1024 }] });
            expect(totalContentBytes(structuredContent.files)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
        });

        it('counts a binary extension as base64 before decompressing', async () => {
            // 200 KiB of bytes fits the cap raw but not as base64.
            stubArchive({ 'image.png': new Uint8Array(200 * 1024), 'src/main.js': strToU8(MAIN_JS_SOURCE.content) });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const { content, structuredContent } = await callTool({});

            expect(structuredContent).toMatchObject({
                files: [{ path: 'src/main.js' }],
                omittedFiles: [{ path: 'image.png', sizeBytes: 200 * 1024 }],
            });
            expect(content[1].text).toContain('Too large for this tool even on their own: image.png;');
        });

        it('leaves out a file that grows past the cap once it turns out not to be UTF-8', async () => {
            // Invalid UTF-8 without a binary extension: fits by its raw size, not as base64.
            const bytes = new Uint8Array(200 * 1024).fill(0xff);
            stubArchive({ 'data.txt': bytes, 'src/main.js': strToU8(MAIN_JS_SOURCE.content) });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const { structuredContent } = (await callTool({})) as TextToolResult & {
                structuredContent: { files: { content: string }[] };
            };

            expect(structuredContent).toMatchObject({
                files: [{ path: 'src/main.js' }],
                omittedFiles: [{ path: 'data.txt', sizeBytes: 200 * 1024 }],
            });
            expect(totalContentBytes(structuredContent.files)).toBeLessThanOrEqual(MAX_INLINE_BYTES);
        });

        it('refuses a zip over 50 MiB without downloading it', async () => {
            listKeysMock.mockResolvedValue({ items: [{ key: RECORD_KEY, size: 50 * 1024 * 1024 + 1 }] });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                "The version's zip is 50.0 MiB, over the 50 MiB this tool reads; pull it with the Apify CLI (apify pull) instead.",
            );
            expect(getRecordMock).not.toHaveBeenCalled();
        });

        it('reads a zip of exactly 50 MiB by its listed size', async () => {
            stubArchive({ 'src/main.js': strToU8(MAIN_JS_SOURCE.content) });
            listKeysMock.mockResolvedValue({ items: [{ key: RECORD_KEY, size: 50 * 1024 * 1024 }] });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const { structuredContent } = await callTool({});

            expect(structuredContent).toMatchObject({ files: [{ path: 'src/main.js' }] });
        });

        it('matches the record key exactly among the prefixed keys', async () => {
            listKeysMock.mockResolvedValue({ items: [{ key: `${RECORD_KEY}.bak`, size: 10 }] });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                `The version points at record ${RECORD_KEY} in key-value store store-1, which does not exist.`,
            );
            expect(getRecordMock).not.toHaveBeenCalled();
        });

        it('reports a missing store as a missing record', async () => {
            listKeysMock.mockRejectedValue(apiError(404, 'Key-value store was not found'));
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                `The version points at record ${RECORD_KEY} in key-value store store-1, which does not exist.`,
            );
        });

        it('reports a record that is gone by the time it is downloaded', async () => {
            listKeysMock.mockResolvedValue({ items: [{ key: RECORD_KEY, size: 10 }] });
            getRecordMock.mockResolvedValue(undefined);
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const text = await callToolExpectingUserError({});

            expect(text).toBe(
                `The version points at record ${RECORD_KEY} in key-value store store-1, which does not exist.`,
            );
        });

        it('reports a record that is not a zip', async () => {
            listKeysMock.mockResolvedValue({ items: [{ key: RECORD_KEY, size: 9 }] });
            getRecordMock.mockResolvedValue({ key: RECORD_KEY, value: Buffer.from('not a zip') });
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const text = await callToolExpectingUserError({});

            expect(text).toMatch(/^The version's zip could not be read: .+\.$/);
        });

        it('maps a 403 from the source store to an auth failure with the API message', async () => {
            listKeysMock.mockRejectedValue(apiError(403, 'Insufficient permissions for the key-value store'));
            versionGetMock.mockResolvedValue(mockTarballVersion());

            const result = await callTool({});

            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                    failureCategory: FAILURE_CATEGORY.AUTH,
                    failureHttpStatus: 403,
                }),
            );
            expect(result.content[0].text).toBe('Insufficient permissions for the key-value store');
        });

        it('rethrows other API errors', async () => {
            listKeysMock.mockRejectedValue(apiError(500, 'Internal error'));
            versionGetMock.mockResolvedValue(mockTarballVersion());

            await expect(callTool({})).rejects.toBeInstanceOf(ApifyApiError);
        });

        it('reports a version whose zip URL the API hides', async () => {
            versionGetMock.mockResolvedValue({ versionNumber: '0.1', sourceType: 'TARBALL', buildTag: 'latest' });

            const text = await callToolExpectingUserError({});

            expect(text).toContain('Version 0.1 of john/my-actor came back without its source');
            expect(keyValueStoreMock).not.toHaveBeenCalled();
        });
    });

    describe('TARBALL at another URL', () => {
        it.each([
            ['another host', 'https://example.com/source.zip'],
            ['another host with the record path', 'https://evil.test/v2/key-value-stores/store-1/records/a.zip'],
            ['this API but not a record', 'https://api.example.test/v2/datasets/store-1/items'],
            ['a value that is not a URL', 'not a url'],
        ])('returns the URL without downloading it: %s', async (_label, tarballUrl) => {
            versionGetMock.mockResolvedValue(mockTarballVersion(tarballUrl));

            const result = await callTool({});
            const { content, structuredContent } = result;

            expect(keyValueStoreMock).not.toHaveBeenCalled();
            expect(structuredContent).toEqual({
                actorId: 'actor-1',
                actorName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'TARBALL',
                tarballUrl,
            });
            expect(content[1].text).toBe(
                `Version 0.1 of john/my-actor builds from the zip at ${tarballUrl}, which this tool does not download.\n` +
                    `Download and unzip it in your sandbox. Pushing files with ${HELPER_TOOLS.ACTOR_PUSH} and mode replace would switch the version to files hosted on Apify, and it would stop building from this zip.`,
            );
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
        });

        it('names no other tool when push-actor is not loaded', async () => {
            versionGetMock.mockResolvedValue(mockTarballVersion('https://example.com/source.zip'));

            const { content } = await callTool({}, [HELPER_TOOLS.ACTOR_PULL]);

            expect(content[1].text).toContain(
                'Download and unzip it in your sandbox. Pushing files to this version would switch the version to files hosted on Apify, and it would stop building from this zip.',
            );
            expectNoOtherToolNamed(content[1].text);
        });
    });

    describe('GIT_REPO', () => {
        const GIT_REPO_URL = 'https://github.com/john/my-actor.git#main:actors/scraper';

        it('returns the repository URL and warns that a push would detach the version', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl: GIT_REPO_URL }));

            const result = await callTool({});
            const { content, structuredContent } = result;

            expect(keyValueStoreMock).not.toHaveBeenCalled();
            expect(structuredContent).toEqual({
                actorId: 'actor-1',
                actorName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'GIT_REPO',
                gitRepoUrl: GIT_REPO_URL,
            });
            expect(content[1].text).toBe(
                `Version 0.1 of john/my-actor builds from the Git repository ${GIT_REPO_URL}, so no files are returned; a #branch:subdirectory suffix names the branch and the directory in it.\n` +
                    `Clone the repository in your sandbox and commit there. Pushing files with ${HELPER_TOOLS.ACTOR_PUSH} and mode replace would switch the version to files hosted on Apify, and it would stop building from the repository.`,
            );
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
        });

        it('names no other tool when push-actor is not loaded', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl: GIT_REPO_URL }));

            const { content } = await callTool({}, [HELPER_TOOLS.ACTOR_PULL]);

            expect(content[1].text).toContain(
                'Clone the repository in your sandbox and commit there. Pushing files to this version would switch the version to files hosted on Apify, and it would stop building from the repository.',
            );
            expectNoOtherToolNamed(content[1].text);
        });

        it('reports a version whose repository URL the API hides', async () => {
            versionGetMock.mockResolvedValue({ versionNumber: '0.1', sourceType: 'GIT_REPO', buildTag: 'latest' });

            const text = await callToolExpectingUserError({});

            expect(text).toContain('Version 0.1 of john/my-actor came back without its source');
        });
    });

    describe('GITHUB_GIST', () => {
        const GIST_URL = 'https://gist.github.com/john/0123456789abcdef';

        it('returns the gist URL and warns that a push would detach the version', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GITHUB_GIST', gitHubGistUrl: GIST_URL }));

            const result = await callTool({});
            const { content, structuredContent } = result;

            expect(structuredContent).toEqual({
                actorId: 'actor-1',
                actorName: 'john/my-actor',
                versionNumber: '0.1',
                sourceType: 'GITHUB_GIST',
                gitHubGistUrl: GIST_URL,
            });
            expect(content[1].text).toBe(
                `Version 0.1 of john/my-actor builds from the GitHub gist ${GIST_URL}, so no files are returned.\n` +
                    `Clone the gist in your sandbox and commit there. Pushing files with ${HELPER_TOOLS.ACTOR_PUSH} and mode replace would switch the version to files hosted on Apify, and it would stop building from the gist.`,
            );
            expectSchemaConformingStructuredContent(result, pullActorToolOutputSchema);
        });

        it('names no other tool when push-actor is not loaded', async () => {
            versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GITHUB_GIST', gitHubGistUrl: GIST_URL }));

            const { content } = await callTool({}, [HELPER_TOOLS.ACTOR_PULL]);

            expectNoOtherToolNamed(content[1].text);
        });
    });

    describe('Actor and version resolution', () => {
        it('reports an Actor that does not exist', async () => {
            actorGetMock.mockResolvedValue(undefined);

            const text = await callToolExpectingUserError({ actor: 'john/missing' });

            expect(text).toBe("Actor 'john/missing' not found.");
            expect(versionMock).not.toHaveBeenCalled();
        });

        it('asks for versionNumber when the Actor has several versions', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

            const text = await callToolExpectingUserError({});

            expect(text).toBe('Specify versionNumber; this Actor has versions: 0.1, 0.2.');
            expect(versionGetMock).not.toHaveBeenCalled();
        });

        it('reads the requested version when the Actor has several', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));
            versionGetMock.mockResolvedValue(mockVersion({ versionNumber: '0.2' }));

            const { structuredContent } = await callTool({ versionNumber: '0.2' });

            expect(versionMock).toHaveBeenCalledWith('0.2');
            expect(structuredContent).toMatchObject({ versionNumber: '0.2' });
        });

        it('lists the versions when the requested one does not exist', async () => {
            actorGetMock.mockResolvedValue(mockActor(['0.1', '0.2']));

            const text = await callToolExpectingUserError({ versionNumber: '0.3' });

            expect(text).toBe("Actor 'my-actor' has no version 0.3; available versions: 0.1, 0.2.");
            expect(versionGetMock).not.toHaveBeenCalled();
        });

        it('reports an Actor with no versions', async () => {
            actorGetMock.mockResolvedValue(mockActor([]));

            const text = await callToolExpectingUserError({});

            expect(text).toBe("Actor 'my-actor' has no versions.");
        });

        it('reports a version that is gone by the time it is read', async () => {
            versionGetMock.mockResolvedValue(undefined);

            const text = await callToolExpectingUserError({});

            expect(text).toBe("Actor 'my-actor' has no version 0.1.");
        });

        it('maps a 403 from the Actor lookup to an auth failure with the API message', async () => {
            actorGetMock.mockRejectedValue(apiError(403, 'Insufficient permissions for the Actor'));

            const result = await callTool({});

            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH, failureHttpStatus: 403 }),
            );
            expect(result.content[0].text).toBe('Insufficient permissions for the Actor');
        });
    });

    describe('description', () => {
        it('names push-actor only when it is in the session', () => {
            const tool = pullActor as HelperTool;
            expect(tool.description).toContain(
                `The files come in the shape ${HELPER_TOOLS.ACTOR_PUSH} takes, so they can be edited and pushed back with it.`,
            );
            const withoutPush = tool.buildDescription?.(only(HELPER_TOOLS.ACTOR_PULL));
            expect(withoutPush).toBeDefined();
            for (const name of OTHER_TOOL_NAMES) expect(withoutPush).not.toContain(name);
        });
    });
});
