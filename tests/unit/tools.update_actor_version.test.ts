import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS, TOOL_STATUS } from '../../src/const.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { buildFilesRevision, buildUrlRevision } from '../../src/tools/source/source_files.js';
import { updateActorVersion } from '../../src/tools/source/update_actor_version.js';
import { updateActorVersionToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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
const versionUpdateMock = vi.fn();
const buildMock = vi.fn();
const versionMock = vi.fn(() => ({ get: versionGetMock, update: versionUpdateMock }));
const actorMock = vi.fn(() => ({ get: actorGetMock, version: versionMock, build: buildMock }));

const stubClient = {
    actor: actorMock,
    baseUrl: 'https://api.example.test/v2',
} as unknown as InternalToolArgs['apifyClient'];

const ACTOR_JSON = { name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification": 1}' };
const MAIN_JS = { name: 'src/main.js', format: 'TEXT', content: 'const a = 1;\nconsole.log(a);\nexport {};\n' };
const LOGO_BYTES = Buffer.from([137, 80, 78, 71, 0, 255]);
const LOGO = { name: 'assets/logo.png', format: 'BASE64', content: LOGO_BYTES.toString('base64') };

const TOOL_NAMES = Object.values(HELPER_TOOLS);

type ChangeOutput = { path: string; action: string; newPath?: string; hash?: string; sizeBytes?: number };

type UpdateOutput = {
    actorId: string;
    fullName: string;
    versionNumber: string;
    sourceType: string;
    buildTag?: string;
    previousRevision: string;
    revision: string;
    changed: boolean;
    changes: ChangeOutput[];
    excerpts: { path: string; startLine: number; endLine: number; text: string }[];
    totalSizeBytes?: number;
    warnings: string[];
    build?: Record<string, unknown>;
    buildError?: string;
};

type UpdateResult = TextToolResult & { structuredContent: UpdateOutput; toolTelemetry?: ToolTelemetrySnapshot };

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

/** A SOURCE_FILES version with env vars, which a write must never send back. */
function mockVersion(overrides: Record<string, unknown> = {}) {
    return {
        versionNumber: '0.1',
        buildTag: 'latest',
        sourceType: 'SOURCE_FILES',
        envVars: [{ name: 'API_KEY', value: 'secret-value', isSecret: true }],
        sourceFiles: [ACTOR_JSON, MAIN_JS, LOGO],
        ...overrides,
    };
}

function sha256Prefix(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function apiError(status: number, message: string, type = 'some-error'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
}

function mockBuild(overrides: Record<string, unknown> = {}) {
    return {
        id: 'build-1',
        actId: 'actor-1',
        buildNumber: '0.1.5',
        status: 'READY',
        startedAt: new Date('2026-09-01T10:00:00.000Z'),
        finishedAt: undefined,
        ...overrides,
    };
}

async function callTool(
    args: Record<string, unknown>,
    loadedToolNames?: string[],
    signal?: AbortSignal,
): Promise<UpdateResult> {
    const context = stubToolCallContext({ actor: 'john/my-actor', ...args }, stubClient);
    const withTools = loadedToolNames === undefined ? context : { ...context, loadedToolNames };
    const withSignal = signal === undefined ? withTools : { ...withTools, signal };
    return (await (updateActorVersion as HelperTool).call(withSignal)) as UpdateResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>, loadedToolNames?: string[]) {
    const result = await callTool(args, loadedToolNames);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
}

/** The body of the one version PUT the call sent. */
function getPutBody(): Record<string, unknown> {
    expect(versionUpdateMock).toHaveBeenCalledTimes(1);
    return versionUpdateMock.mock.calls[0][0] as Record<string, unknown>;
}

function getPutFiles(): { name: string; format?: string; content?: string }[] {
    return getPutBody().sourceFiles as { name: string; format?: string; content?: string }[];
}

function expectNoToolNamed(text: string) {
    for (const name of TOOL_NAMES) expect(text).not.toContain(name);
}

const MAIN_JS_HASH = sha256Prefix(MAIN_JS.content);

describe('update-actor-version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: 'user-1' }));
        actorGetMock.mockResolvedValue(mockActor());
        versionGetMock.mockResolvedValue(mockVersion());
        versionUpdateMock.mockImplementation(async (body: Record<string, unknown>) => ({ ...mockVersion(), ...body }));
        buildMock.mockResolvedValue(mockBuild());
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

    describe('description', () => {
        const { buildDescription } = updateActorVersion as HelperTool;

        it('names get-actor-version and get-actor-build only when the session has them', () => {
            const full = buildDescription?.(only(HELPER_TOOLS.ACTOR_VERSION_GET, HELPER_TOOLS.ACTOR_BUILD_GET)) ?? '';
            expect(full).toContain(`Read the version with ${HELPER_TOOLS.ACTOR_VERSION_GET} first`);
            expect(full).toContain(`Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`);
            expect(full).toBe(updateActorVersion.description);
            const bare = buildDescription?.(only()) ?? '';
            for (const name of TOOL_NAMES.filter((tool) => tool !== HELPER_TOOLS.ACTOR_VERSION_UPDATE)) {
                expect(bare).not.toContain(name);
            }
        });

        it('uses plain punctuation', () => {
            expect(updateActorVersion.description).not.toMatch(/[\u2013\u2014]/);
        });
    });

    describe('write', () => {
        it('creates a file and sends one PUT with only the source keys', async () => {
            const result = await callTool({
                operations: [{ type: 'write', path: 'src/util.js', content: 'export const b = 2;\n' }],
            });
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            const body = getPutBody();
            expect(Object.keys(body).sort()).toEqual(['sourceFiles', 'sourceType']);
            expect(body.sourceType).toBe('SOURCE_FILES');
            expect(body).not.toHaveProperty('envVars');
            expect(body).not.toHaveProperty('versionNumber');
            // Untouched files go back exactly as read.
            expect(getPutFiles()).toEqual([
                ACTOR_JSON,
                MAIN_JS,
                LOGO,
                { name: 'src/util.js', format: 'TEXT', content: 'export const b = 2;\n' },
            ]);
            expect(versionMock).toHaveBeenCalledWith('0.1');
            // The lookup takes the selector; the version GET and PUT go to the resolved Actor's ID.
            expect(actorMock).toHaveBeenCalledTimes(2);
            expect(actorMock).toHaveBeenNthCalledWith(1, 'john/my-actor');
            expect(actorMock).toHaveBeenNthCalledWith(2, 'actor-1');
            const { structuredContent } = result;
            expect(structuredContent.changed).toBe(true);
            expect(structuredContent.changes).toEqual([
                { path: 'src/util.js', action: 'created', hash: sha256Prefix('export const b = 2;\n'), sizeBytes: 20 },
            ]);
            expect(structuredContent.revision).not.toBe(structuredContent.previousRevision);
            expect(structuredContent.actorId).toBe('actor-1');
            expect(structuredContent.fullName).toBe('john/my-actor');
            expect(structuredContent.buildTag).toBe('latest');
            expect(result.content[1].text).toContain('Updated version 0.1 of john/my-actor: 1 file created;');
            expect(result.content[1].text).toContain(
                'Runs keep using the previously tagged build until this version is built.',
            );
        });

        it('reports the same revisions get-actor-version returns before and after', async () => {
            const readBefore = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', paths: [] }, stubClient),
            )) as { structuredContent: { revision: string } };
            const result = await callTool({
                expectedRevision: readBefore.structuredContent.revision,
                operations: [{ type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH }],
            });
            expect(result.structuredContent.previousRevision).toBe(readBefore.structuredContent.revision);
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: getPutFiles() }));
            const readAfter = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', paths: [] }, stubClient),
            )) as { structuredContent: { revision: string } };
            expect(result.structuredContent.revision).toBe(readAfter.structuredContent.revision);
        });

        it('refuses to replace an existing file without expectedHash (FILE_EXISTS)', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'src/main.js', content: 'new\n' }],
            });
            expect(text).toBe(
                'Nothing was written: operations[0] (write src/main.js) failed with FILE_EXISTS. ' +
                    `A file exists at src/main.js with hash ${MAIN_JS_HASH}; to replace it, pass that as expectedHash. ` +
                    `Read the version again with ${HELPER_TOOLS.ACTOR_VERSION_GET} and retry.`,
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('names no tool in the retry hint when get-actor-version is not loaded', async () => {
            const text = await callToolExpectingUserError(
                { operations: [{ type: 'write', path: 'src/main.js', content: 'new\n' }] },
                [HELPER_TOOLS.ACTOR_VERSION_UPDATE],
            );
            expect(text).toContain('Read the version again and retry.');
            expectNoToolNamed(text);
        });

        it('refuses a stale expectedHash (HASH_MISMATCH)', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'write', path: 'src/main.js', content: 'new\n', expectedHash: '0000000000000000' },
                ],
            });
            expect(text).toContain('operations[0] (write src/main.js) failed with HASH_MISMATCH.');
            expect(text).toContain(`src/main.js has hash ${MAIN_JS_HASH}, not 0000000000000000`);
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('replaces a file given its current hash', async () => {
            const result = await callTool({
                operations: [{ type: 'write', path: 'src/main.js', content: 'new\n', expectedHash: MAIN_JS_HASH }],
            });
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('new\n'), sizeBytes: 4 },
            ]);
            expect(getPutFiles()[1]).toEqual({ name: 'src/main.js', format: 'TEXT', content: 'new\n' });
        });

        it('reports a byte-identical write as unchanged and sends no PUT', async () => {
            const result = await callTool({
                operations: [{ type: 'write', path: 'src/main.js', content: MAIN_JS.content }],
            });
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent.changed).toBe(false);
            expect(result.structuredContent.revision).toBe(result.structuredContent.previousRevision);
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'unchanged', hash: MAIN_JS_HASH, sizeBytes: MAIN_JS.content.length },
            ]);
            expect(result.content[1].text).toContain('Nothing changed in version 0.1 of john/my-actor');
            expect(result.content[1].text).toContain('These files already had the content sent: src/main.js.');
        });

        it('treats the same bytes sent as base64 as unchanged', async () => {
            const result = await callTool({
                operations: [{ type: 'write', path: 'assets/logo.png', content: LOGO.content }],
            });
            expect(result.structuredContent.changed).toBe(false);
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses expectedHash for a path with no file (FILE_NOT_FOUND)', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'src/new.js', content: 'x', expectedHash: MAIN_JS_HASH }],
            });
            expect(text).toContain('operations[0] (write src/new.js) failed with FILE_NOT_FOUND.');
        });

        it('stores content for a binary extension as base64 when encoding is omitted', async () => {
            const content = Buffer.from([1, 2, 3]).toString('base64');
            const result = await callTool({ operations: [{ type: 'write', path: 'assets/icon.png', content }] });
            expect(getPutFiles().at(-1)).toEqual({ name: 'assets/icon.png', format: 'BASE64', content });
            expect(result.structuredContent.changes[0]).toEqual({
                path: 'assets/icon.png',
                action: 'created',
                hash: sha256Prefix(Buffer.from([1, 2, 3])),
                sizeBytes: 3,
            });
        });

        it('refuses content that is not strict base64', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'assets/icon.png', content: 'AQID\n' }],
            });
            expect(text).toContain('has encoding base64, but its content is not valid base64');
            expect(text).toContain('Files with the extension of assets/icon.png default to base64.');
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it.each([
            ['AQI', 'no padding'],
            ['AQ-_', 'the URL-safe alphabet'],
            ['AQID====', 'extra padding'],
        ])('refuses base64 content %j with %s before any request', async (content) => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'assets/icon.png', content }],
            });
            expect(text).toContain('its content is not valid base64');
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('accepts an expectedHash in upper case', async () => {
            await callTool({
                operations: [
                    { type: 'write', path: 'src/main.js', content: 'new\n', expectedHash: MAIN_JS_HASH.toUpperCase() },
                ],
            });
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it('refuses a file where another file needs a folder, naming both paths', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'src', content: 'x' }],
            });
            expect(text).toBe(
                'Nothing was written: after the changes src would be a file and also a folder (src/main.js is inside ' +
                    'it), so the build could not write it.',
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses a file at the path of a folder entry', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [...mockVersion().sourceFiles, { name: 'empty', folder: true }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'empty', content: 'x' }],
            });
            expect(text).toContain('empty would be a file and also a folder (a folder entry has the same path)');
        });

        it('does not block a call on a file and folder clash the version already had', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [...mockVersion().sourceFiles, { name: 'src', format: 'TEXT', content: 'x' }],
                }),
            );
            await callTool({ operations: [{ type: 'write', path: 'b.js', content: 'b' }] });
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it('stores text sent with encoding base64 as BASE64', async () => {
            const content = Buffer.from('hello\n').toString('base64');
            await callTool({ operations: [{ type: 'write', path: 'README.md', content, encoding: 'base64' }] });
            expect(getPutFiles().at(-1)).toEqual({ name: 'README.md', format: 'BASE64', content });
        });

        it('warns about an empty file, which the build skips', async () => {
            const result = await callTool({ operations: [{ type: 'write', path: 'src/.keep', content: '' }] });
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: src/.keep.',
            ]);
        });
    });

    describe('edit', () => {
        it('replaces a unique match and returns an excerpt with 2 lines of context', async () => {
            const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join('');
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content: lines }] }),
            );
            const result = await callTool({
                operations: [
                    { type: 'edit', path: 'src/main.js', edits: [{ oldText: 'line 5\n', newText: 'five\n' }] },
                ],
            });
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(getPutFiles()[1].content).toBe(lines.replace('line 5\n', 'five\n'));
            expect(result.structuredContent.excerpts).toEqual([
                { path: 'src/main.js', startLine: 3, endLine: 7, text: 'line 3\nline 4\nfive\nline 6\nline 7\n' },
            ]);
            expect(result.structuredContent.changes[0].action).toBe('updated');
        });

        it('applies edits in order, each to the text the previous one left', async () => {
            await callTool({
                operations: [
                    {
                        type: 'edit',
                        path: 'src/main.js',
                        edits: [
                            { oldText: 'const a = 1;', newText: 'const a = 2;' },
                            { oldText: 'a = 2', newText: 'a = 3' },
                        ],
                    },
                ],
            });
            expect(getPutFiles()[1].content).toBe('const a = 3;\nconsole.log(a);\nexport {};\n');
        });

        it('moves the excerpt of an earlier edit when a later one shifts the lines', async () => {
            const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('');
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content: lines }] }),
            );
            const result = await callTool({
                operations: [
                    {
                        type: 'edit',
                        path: 'src/main.js',
                        edits: [
                            { oldText: 'line 15\n', newText: 'fifteen\n' },
                            { oldText: 'line 2\n', newText: 'two\nextra\n' },
                        ],
                    },
                ],
            });
            expect(result.structuredContent.excerpts.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
                [1, 5],
                [14, 18],
            ]);
            expect(result.structuredContent.excerpts[1].text).toBe('line 13\nline 14\nfifteen\nline 16\nline 17\n');
        });

        it('reports NO_MATCH with the closest text and notes an edit that may already be applied', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [
                        ACTOR_JSON,
                        { name: 'src/main.js', format: 'TEXT', content: 'function f() {\n    return 2;\n}\n' },
                    ],
                }),
            );
            const text = await callToolExpectingUserError({
                operations: [
                    {
                        type: 'edit',
                        path: 'src/main.js',
                        edits: [{ oldText: 'function f() {\n  return 1;\n}', newText: 'return 2;' }],
                    },
                ],
            });
            expect(text).toContain('operations[0] (edit src/main.js) failed with NO_MATCH.');
            expect(text).toContain('oldText of edits[0] is not in the file byte for byte');
            expect(text).toContain('newText is in the file once, so this edit may already be applied.');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('shows up to 10 lines of current text around a whitespace-insensitive match', async () => {
            const content = Array.from({ length: 30 }, (_, index) => `row(${index + 1});\n`).join('');
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'edit', path: 'src/main.js', edits: [{ oldText: 'row( 15 );\nrow(16);', newText: 'x' }] },
                ],
            });
            expect(text).toContain('the closest match ignoring whitespace is at line 15.');
            expect(text).toContain(
                'The current text of lines 13-22:\nrow(13);\nrow(14);\nrow(15);\nrow(16);\nrow(17);\nrow(18);\nrow(19);\nrow(20);\nrow(21);\nrow(22);\n',
            );
            expect(text).not.toContain('may already be applied');
        });

        it('says there is no whitespace-insensitive match and suggests reading again', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: 'zzz', newText: 'y' }] }],
            });
            expect(text).toContain(
                'oldText of edits[0] is not in the file, and it has no whitespace-insensitive match either.',
            );
            expect(text).toContain(`Read the version again with ${HELPER_TOOLS.ACTOR_VERSION_GET} and retry.`);
        });

        it('shows the lines around newText when only newText is in the file', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    {
                        type: 'edit',
                        path: 'src/main.js',
                        edits: [{ oldText: 'zzz', newText: 'console.log(a);' }],
                    },
                ],
            });
            expect(text).toContain(
                'oldText of edits[0] is not in the file, even ignoring whitespace, but newText is in it once, at ' +
                    'line 2, so this edit may already be applied. The current text of lines 1-3:\n' +
                    MAIN_JS.content,
            );
            expect(text).not.toContain('Read the version again');
        });

        it('does not say the edit may be applied when newText is in the file twice', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'edit', path: 'src/main.js', edits: [{ oldText: 'const  a = 1;\nzzz', newText: 'a' }] },
                ],
            });
            expect(text).toContain('failed with NO_MATCH.');
            expect(text).not.toContain('may already be applied');
        });

        it('ignores a first line that occurs more than once', async () => {
            const content = 'if (x) {\n    one();\n}\nif (y) {\n    two();\n}\n';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: '}\nelse {', newText: 'qqq' }] }],
            });
            expect(text).toContain('it has no whitespace-insensitive match either.');
        });

        it('keeps the NO_MATCH context within 4 KiB for a long line', async () => {
            const content = `${'a'.repeat(10_000)}needle(1)${'b'.repeat(10_000)}\n`;
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'dist/app.min.js', format: 'TEXT', content }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'edit', path: 'dist/app.min.js', edits: [{ oldText: 'needle( 1 )', newText: 'x' }] },
                ],
            });
            expect(text).toContain('Line 1 is too long to show whole; its characters 9745 to 10768:\n');
            expect(text).toContain('needle(1)');
            expect(Buffer.byteLength(text)).toBeLessThan(4096);
        });

        it('shows fewer lines when 10 lines would be over 4 KiB', async () => {
            const content = Array.from({ length: 12 }, (_, index) => `${index}:${'x'.repeat(1000)}\n`).join('');
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/data.js', format: 'TEXT', content }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/data.js', edits: [{ oldText: '5 :xxx', newText: 'y' }] }],
            });
            expect(text).toContain('the closest match ignoring whitespace is at line 6.');
            expect(text).toContain('The current text of lines 3-6:\n2:');
            expect(Buffer.byteLength(text)).toBeLessThan(4096 + 300);
        });

        it('reports MULTIPLE_MATCHES with the line numbers', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: 'a', newText: 'b' }] }],
            });
            expect(text).toContain('failed with MULTIPLE_MATCHES.');
            expect(text).toContain('oldText of edits[0] matches 2 times, at lines 1, 2.');
        });

        it('lists at most 10 line numbers', async () => {
            const content = 'x\n'.repeat(12);
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: 'x', newText: 'y' }] }],
            });
            expect(text).toContain('matches 12 times, at lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, and more.');
        });

        it('replaces every match with allOccurrences', async () => {
            await callTool({
                operations: [
                    {
                        type: 'edit',
                        path: 'src/main.js',
                        edits: [{ oldText: 'a', newText: 'value', allOccurrences: true }],
                    },
                ],
            });
            expect(getPutFiles()[1].content).toBe('const value = 1;\nconsole.log(value);\nexport {};\n');
        });

        it('retries an LF oldText as CRLF in a file with only CRLF line breaks', async () => {
            const content = 'one\r\ntwo\r\nthree\r\n';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content }] }),
            );
            await callTool({
                operations: [
                    { type: 'edit', path: 'src/main.js', edits: [{ oldText: 'one\ntwo\n', newText: '1\n2\n' }] },
                ],
            });
            expect(getPutFiles()[1].content).toBe('1\r\n2\r\nthree\r\n');
        });

        it('does not convert line endings in a file with mixed line endings', async () => {
            const content = 'one\r\ntwo\nthree\r\n';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content }] }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: 'one\ntwo', newText: 'x' }] }],
            });
            expect(text).toContain('failed with NO_MATCH.');
        });

        it('keeps a UTF-8 file stored as BASE64 in BASE64', async () => {
            const stored = {
                name: 'src/data.txt',
                format: 'BASE64',
                content: Buffer.from('hello\n').toString('base64'),
            };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [ACTOR_JSON, stored] }));
            await callTool({
                operations: [{ type: 'edit', path: 'src/data.txt', edits: [{ oldText: 'hello', newText: 'bye' }] }],
            });
            expect(getPutFiles()[1]).toEqual({
                name: 'src/data.txt',
                format: 'BASE64',
                content: Buffer.from('bye\n').toString('base64'),
            });
        });

        it('refuses to edit a binary file (NOT_TEXT)', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'assets/logo.png', edits: [{ oldText: 'PNG', newText: 'x' }] }],
            });
            expect(text).toContain('operations[0] (edit assets/logo.png) failed with NOT_TEXT.');
            expect(text).toContain('replace it with a write and its expectedHash');
        });

        it('refuses to edit a missing file (FILE_NOT_FOUND)', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'edit', path: 'src/none.js', edits: [{ oldText: 'a', newText: 'b' }] }],
            });
            expect(text).toContain('failed with FILE_NOT_FOUND. There is no file at src/none.js.');
        });

        it('keeps the excerpts within 4 KiB and says when they are cut', async () => {
            const content = 'start\nend\n';
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [ACTOR_JSON, { name: 'src/main.js', format: 'TEXT', content }] }),
            );
            const newText = `${'x'.repeat(100)}\n`.repeat(60);
            const result = await callTool({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: 'start\n', newText }] }],
            });
            const excerptBytes = result.structuredContent.excerpts.reduce((total, { text }) => total + text.length, 0);
            expect(excerptBytes).toBeLessThanOrEqual(4096);
            expect(excerptBytes).toBeGreaterThan(3900);
            expect(result.content[1].text).toContain('The excerpts cover only part of the edited lines');
        });
    });

    describe('delete and move', () => {
        it('deletes a file given its hash', async () => {
            const result = await callTool({
                operations: [{ type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH }],
            });
            expect(getPutFiles()).toEqual([ACTOR_JSON, LOGO]);
            expect(result.structuredContent.changes).toEqual([{ path: 'src/main.js', action: 'deleted' }]);
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
        });

        it('refuses a delete with a stale hash (HASH_MISMATCH) or a missing file (FILE_NOT_FOUND)', async () => {
            expect(
                await callToolExpectingUserError({
                    operations: [{ type: 'delete', path: 'src/main.js', expectedHash: 'ffffffffffffffff' }],
                }),
            ).toContain('failed with HASH_MISMATCH.');
            expect(
                await callToolExpectingUserError({
                    operations: [{ type: 'delete', path: 'src/none.js', expectedHash: MAIN_JS_HASH }],
                }),
            ).toContain('failed with FILE_NOT_FOUND.');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('moves a file and reports one move for a moved and edited file', async () => {
            const result = await callTool({
                operations: [
                    { type: 'move', path: 'src/main.js', newPath: 'src/index.js' },
                    {
                        type: 'edit',
                        path: 'src/index.js',
                        edits: [{ oldText: 'const a = 1;', newText: 'const a = 9;' }],
                    },
                ],
            });
            const content = 'const a = 9;\nconsole.log(a);\nexport {};\n';
            expect(getPutFiles()).toEqual([ACTOR_JSON, LOGO, { name: 'src/index.js', format: 'TEXT', content }]);
            expect(result.structuredContent.changes).toEqual([
                {
                    path: 'src/main.js',
                    action: 'moved',
                    newPath: 'src/index.js',
                    hash: sha256Prefix(content),
                    sizeBytes: content.length,
                },
            ]);
            expect(result.structuredContent.excerpts[0].path).toBe('src/index.js');
        });

        it('refuses to move onto an existing file (FILE_EXISTS)', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'move', path: 'src/main.js', newPath: '.actor/actor.json' }],
            });
            expect(text).toContain('failed with FILE_EXISTS. A file exists at .actor/actor.json');
        });

        it('refuses changes that remove .actor/actor.json', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'move', path: '.actor/actor.json', newPath: 'actor.json' }],
            });
            expect(text).toBe(
                "Nothing was written: the changes remove .actor/actor.json, which the build reads the Actor's " +
                    'configuration from. Keep it, or give its new content with a write.',
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('changes a version that never had .actor/actor.json', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceFiles: [{ name: 'Dockerfile', format: 'TEXT', content: 'FROM x\n' }, MAIN_JS],
                }),
            );
            await callTool({
                operations: [{ type: 'edit', path: 'src/main.js', edits: [{ oldText: 'a = 1', newText: 'a = 2' }] }],
            });
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it('refuses a move of a missing file (FILE_NOT_FOUND)', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'move', path: 'src/none.js', newPath: 'src/other.js' }],
            });
            expect(text).toContain('operations[0] (move src/none.js) failed with FILE_NOT_FOUND.');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it.each([
            ['/abs.js', 'is absolute'],
            ['../x.js', "has a '..' segment"],
            ['a\0b', 'contains a NUL character'],
            ['./', 'is not a file path'],
        ])('refuses the newPath %j before any request', async (newPath, reason) => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'move', path: 'src/main.js', newPath }],
            });
            expect(text).toContain(`operations[0] (move src/main.js) newPath`);
            expect(text).toContain(reason);
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('normalizes newPath', async () => {
            const result = await callTool({
                operations: [{ type: 'move', path: 'src/main.js', newPath: './src//index.js' }],
            });
            expect(result.structuredContent.changes[0]).toEqual(
                expect.objectContaining({ action: 'moved', newPath: 'src/index.js' }),
            );
            expect(getPutFiles().at(-1)?.name).toBe('src/index.js');
        });

        it('refuses a move onto a path that is a folder of other files', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'move', path: 'assets/logo.png', newPath: 'src' }],
            });
            expect(text).toContain('src would be a file and also a folder (src/main.js is inside it)');
        });

        it('reports a file deleted and written again as updated', async () => {
            const result = await callTool({
                operations: [
                    { type: 'delete', path: 'src/main.js', expectedHash: MAIN_JS_HASH },
                    { type: 'write', path: 'src/main.js', content: 'again\n' },
                ],
            });
            expect(result.structuredContent.changes).toEqual([
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('again\n'), sizeBytes: 6 },
            ]);
        });
    });

    describe('stored entries', () => {
        it('writes back untouched entries verbatim, duplicates that normalize to one path included', async () => {
            const first = { name: './lib/x.js', format: 'TEXT', content: 'old\n' };
            const second = { name: 'lib/x.js', format: 'TEXT', content: 'new\n' };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [ACTOR_JSON, first, MAIN_JS, second] }));
            await callTool({ operations: [{ type: 'write', path: 'b.js', content: 'b' }] });
            expect(getPutFiles()).toEqual([
                ACTOR_JSON,
                first,
                MAIN_JS,
                second,
                { name: 'b.js', format: 'TEXT', content: 'b' },
            ]);
        });

        it('replaces every entry of a changed path with one, in the place and with the name of the last', async () => {
            const first = { name: './lib/x.js', format: 'TEXT', content: 'old\n' };
            const second = { name: 'lib//x.js', format: 'TEXT', content: 'new\n' };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [ACTOR_JSON, first, MAIN_JS, second] }));
            const result = await callTool({
                operations: [{ type: 'edit', path: 'lib/x.js', edits: [{ oldText: 'new', newText: 'newer' }] }],
            });
            expect(getPutFiles()).toEqual([
                ACTOR_JSON,
                MAIN_JS,
                { name: 'lib//x.js', format: 'TEXT', content: 'newer\n' },
            ]);
            // The revision get-actor-version reads back from what was stored.
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: getPutFiles() }));
            const readAfter = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', paths: [] }, stubClient),
            )) as { structuredContent: { revision: string } };
            expect(result.structuredContent.revision).toBe(readAfter.structuredContent.revision);
        });
    });

    describe('cancellation', () => {
        it('writes nothing when the request is cancelled during the reads', async () => {
            const controller = new AbortController();
            versionGetMock.mockImplementation(async () => {
                controller.abort();
                return mockVersion();
            });
            const result = await callTool(
                { autoBuild: true, operations: [{ type: 'write', path: 'b.js', content: 'b' }] },
                undefined,
                controller.signal,
            );
            expect(result).toEqual({});
            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });
    });

    describe('all or nothing', () => {
        it('writes nothing when the third operation fails', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'write', path: 'src/a.js', content: 'a' },
                    {
                        type: 'edit',
                        path: 'src/main.js',
                        edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
                    },
                    { type: 'delete', path: 'src/none.js', expectedHash: MAIN_JS_HASH },
                ],
            });
            expect(text).toContain(
                'Nothing was written: operations[2] (delete src/none.js) failed with FILE_NOT_FOUND.',
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('starts no build when a precondition fails', async () => {
            await callToolExpectingUserError({
                autoBuild: true,
                operations: [{ type: 'write', path: 'src/main.js', content: 'new' }],
            });
            expect(buildMock).not.toHaveBeenCalled();
        });
    });

    describe('expectedRevision, replaceFiles, and gitRepoUrl', () => {
        const currentRevision = () =>
            buildFilesRevision([
                { path: '.actor/actor.json', hash: sha256Prefix(ACTOR_JSON.content) },
                { path: 'src/main.js', hash: MAIN_JS_HASH },
                { path: 'assets/logo.png', hash: sha256Prefix(LOGO_BYTES) },
            ]);

        it('checks expectedRevision before the operations (REVISION_MISMATCH)', async () => {
            const text = await callToolExpectingUserError({
                expectedRevision: 'aaaaaaaaaaaaaaaa',
                operations: [{ type: 'delete', path: 'src/none.js', expectedHash: MAIN_JS_HASH }],
            });
            expect(text).toBe(
                'Nothing was written: expectedRevision failed with REVISION_MISMATCH. ' +
                    `The version's revision is ${currentRevision()}, not aaaaaaaaaaaaaaaa; it changed since it was read. ` +
                    `Read the version again with ${HELPER_TOOLS.ACTOR_VERSION_GET} and retry.`,
            );
        });

        it('accepts an expectedRevision in upper case', async () => {
            await callTool({
                expectedRevision: currentRevision().toUpperCase(),
                operations: [{ type: 'write', path: 'b.js', content: 'b' }],
            });
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it('refuses replaceFiles with a stale revision (REVISION_MISMATCH)', async () => {
            const text = await callToolExpectingUserError({
                expectedRevision: 'aaaaaaaaaaaaaaaa',
                replaceFiles: [{ path: '.actor/actor.json', content: '{}' }],
            });
            expect(text).toContain('expectedRevision failed with REVISION_MISMATCH.');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses to detach a Git version with a stale revision (REVISION_MISMATCH)', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl: 'https://github.com/john/repo.git' }),
            );
            const text = await callToolExpectingUserError({
                expectedRevision: currentRevision(),
                replaceFiles: [{ path: '.actor/actor.json', content: '{}' }],
            });
            expect(text).toContain('expectedRevision failed with REVISION_MISMATCH.');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses gitRepoUrl with a stale revision (REVISION_MISMATCH)', async () => {
            const text = await callToolExpectingUserError({
                expectedRevision: 'aaaaaaaaaaaaaaaa',
                gitRepoUrl: 'https://github.com/john/repo.git',
            });
            expect(text).toContain('expectedRevision failed with REVISION_MISMATCH.');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses more than 2 MiB of replaceFiles content before any request', async () => {
            const text = await callToolExpectingUserError({
                expectedRevision: currentRevision(),
                replaceFiles: [
                    { path: '.actor/actor.json', content: '{}' },
                    { path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024) },
                ],
            });
            expect(text).toContain('MiB of content, oldText, and newText together, over the 2 MiB one call takes.');
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('caps replaceFiles at 500 in the input schema', () => {
            const { ajvValidate } = updateActorVersion as HelperTool;
            const files = Array.from({ length: 500 }, (_, index) => ({ path: `f${index}`, content: 'x' }));
            expect(ajvValidate({ actor: 'a/b', expectedRevision: 'r', replaceFiles: files })).toBe(true);
            const tooMany = [...files, { path: 'extra', content: 'x' }];
            expect(ajvValidate({ actor: 'a/b', expectedRevision: 'r', replaceFiles: tooMany })).toBe(false);
        });

        it('replaces the files of a version that never had .actor/actor.json without requiring it', async () => {
            const sourceFiles = [{ name: 'Dockerfile', format: 'TEXT', content: 'FROM x\n' }, MAIN_JS];
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles }));
            const revision = buildFilesRevision([
                { path: 'Dockerfile', hash: sha256Prefix('FROM x\n') },
                { path: 'src/main.js', hash: MAIN_JS_HASH },
            ]);
            await callTool({ expectedRevision: revision, replaceFiles: [{ path: 'Dockerfile', content: 'FROM y\n' }] });
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
        });

        it('replaces the whole file set, dropping folder entries', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceFiles: [...mockVersion().sourceFiles, { name: 'src', folder: true }] }),
            );
            const result = await callTool({
                expectedRevision: currentRevision(),
                replaceFiles: [
                    { path: '.actor/actor.json', content: ACTOR_JSON.content },
                    { path: 'src/main.js', content: 'replaced\n' },
                ],
            });
            expect(getPutFiles()).toEqual([
                { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content },
                { name: 'src/main.js', format: 'TEXT', content: 'replaced\n' },
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: 'assets/logo.png', action: 'deleted' },
                { path: 'src/main.js', action: 'updated', hash: sha256Prefix('replaced\n'), sizeBytes: 9 },
            ]);
        });

        it('keeps folder entries for operations', async () => {
            const folder = { name: 'empty', folder: true };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [...mockVersion().sourceFiles, folder] }));
            await callTool({ operations: [{ type: 'write', path: 'src/b.js', content: 'b' }] });
            expect(getPutFiles()).toContainEqual(folder);
        });

        it('needs expectedRevision for replaceFiles and gitRepoUrl', async () => {
            expect(
                await callToolExpectingUserError({ replaceFiles: [{ path: '.actor/actor.json', content: '{}' }] }),
            ).toContain('replaceFiles replaces the whole source, so it needs expectedRevision');
            expect(await callToolExpectingUserError({ gitRepoUrl: 'https://github.com/john/repo.git' })).toContain(
                'gitRepoUrl replaces the whole source, so it needs expectedRevision',
            );
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('refuses replaceFiles with operations, and gitRepoUrl with either', async () => {
            const write = { type: 'write', path: 'a.js', content: 'a' };
            const file = { path: '.actor/actor.json', content: '{}' };
            expect(
                await callToolExpectingUserError({ expectedRevision: 'r', replaceFiles: [file], operations: [write] }),
            ).toContain('replaceFiles cannot be combined with operations');
            expect(
                await callToolExpectingUserError({ expectedRevision: 'r', gitRepoUrl: 'u', operations: [write] }),
            ).toBe('gitRepoUrl cannot be combined with operations or replaceFiles.');
            expect(
                await callToolExpectingUserError({ expectedRevision: 'r', gitRepoUrl: 'u', replaceFiles: [file] }),
            ).toBe('gitRepoUrl cannot be combined with operations or replaceFiles.');
        });

        it('refuses duplicate paths in replaceFiles after normalization', async () => {
            const text = await callToolExpectingUserError({
                expectedRevision: 'r',
                replaceFiles: [
                    { path: 'src/a.js', content: 'a' },
                    { path: './src//a.js', content: 'b' },
                ],
            });
            expect(text).toBe('replaceFiles has src/a.js more than once.');
        });

        it('points a files version at a Git repository with sourceType and the URL', async () => {
            const gitRepoUrl = 'https://user:token@github.com/john/repo.git#main:actors/one';
            const result = await callTool({ expectedRevision: currentRevision(), gitRepoUrl });
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(getPutBody()).toEqual({ sourceType: 'GIT_REPO', gitRepoUrl });
            expect(result.structuredContent.sourceType).toBe('GIT_REPO');
            // The revision get-actor-version computes: over the URL without its credentials.
            expect(result.structuredContent.revision).toBe(
                buildUrlRevision('GIT_REPO', 'https://github.com/john/repo.git#main:actors/one'),
            );
            expect(result.structuredContent).not.toHaveProperty('totalSizeBytes');
            expect(result.content[1].text).not.toContain('token');
        });

        describe('a Git version', () => {
            const storedUrl = 'https://user:token@github.com/john/repo.git#main';
            const shownUrl = 'https://github.com/john/repo.git#main';
            const shownRevision = buildUrlRevision('GIT_REPO', shownUrl);

            beforeEach(() => {
                versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl: storedUrl }));
            });

            it('sends nothing for the URL get-actor-version shows, keeping the stored credentials', async () => {
                const result = await callTool({ expectedRevision: shownRevision, gitRepoUrl: shownUrl });
                expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
                expect(versionUpdateMock).not.toHaveBeenCalled();
                expect(result.structuredContent.changed).toBe(false);
            });

            it('sends only buildTag with the shown URL', async () => {
                await callTool({ expectedRevision: shownRevision, gitRepoUrl: shownUrl, buildTag: 'beta' });
                expect(getPutBody()).toEqual({ buildTag: 'beta' });
            });

            it('sends nothing for the same URL on a version without credentials', async () => {
                const plainUrl = 'https://github.com/john/repo.git';
                versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl: plainUrl }));
                const result = await callTool({
                    expectedRevision: buildUrlRevision('GIT_REPO', plainUrl),
                    gitRepoUrl: plainUrl,
                });
                expect(versionUpdateMock).not.toHaveBeenCalled();
                expect(result.structuredContent.changed).toBe(false);
            });

            it('keeps the stored credentials for another branch on the same host, with a warning', async () => {
                const result = await callTool({
                    expectedRevision: shownRevision,
                    gitRepoUrl: 'https://github.com/john/repo.git#dev',
                });
                expect(getPutBody()).toEqual({
                    sourceType: 'GIT_REPO',
                    gitRepoUrl: 'https://user:token@github.com/john/repo.git#dev',
                });
                expect(result.structuredContent.revision).toBe(
                    buildUrlRevision('GIT_REPO', 'https://github.com/john/repo.git#dev'),
                );
                expect(result.structuredContent.warnings).toEqual([
                    'The credentials stored with the previous Git URL were kept for https://github.com/john/repo.git#dev.',
                ]);
                expect(result.content[1].text).not.toContain('token');
            });

            it('refuses a URL on another host that would drop the stored credentials', async () => {
                const text = await callToolExpectingUserError({
                    expectedRevision: shownRevision,
                    gitRepoUrl: 'https://gitlab.com/john/repo.git',
                });
                expect(text).toContain('they cannot be kept for https://gitlab.com/john/repo.git');
                expect(text).not.toContain('token');
                expect(versionUpdateMock).not.toHaveBeenCalled();
            });

            it('replaces the credentials with ones sent in gitRepoUrl', async () => {
                const gitRepoUrl = 'https://user:new-token@github.com/john/repo.git#main';
                const result = await callTool({ expectedRevision: shownRevision, gitRepoUrl });
                expect(getPutBody()).toEqual({ sourceType: 'GIT_REPO', gitRepoUrl });
                expect(result.structuredContent.warnings).toEqual([]);
            });
        });

        it('refuses to detach a Git version without .actor/actor.json', async () => {
            const gitRepoUrl = 'https://github.com/john/repo.git';
            versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl }));
            const text = await callToolExpectingUserError({
                expectedRevision: buildUrlRevision('GIT_REPO', gitRepoUrl),
                replaceFiles: [{ path: 'Dockerfile', content: 'FROM x\n' }],
            });
            expect(text).toBe(
                'Nothing was written: to switch a version to stored files, this tool needs .actor/actor.json in ' +
                    "replaceFiles, since the build reads the Actor's configuration from it.",
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses file operations on a Git version, naming the URL without credentials', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({
                    sourceType: 'GIT_REPO',
                    gitRepoUrl: 'https://user:secret@github.com/john/repo.git',
                    sourceFiles: undefined,
                }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'src/a.js', content: 'a' }],
            });
            expect(text).toContain('builds from the Git repository https://github.com/john/repo.git, so its files');
            expect(text).not.toContain('secret');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses file operations on a GitHub gist version', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GITHUB_GIST', gitHubGistUrl: 'https://gist.github.com/john/1' }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'src/a.js', content: 'a' }],
            });
            expect(text).toContain('builds from the GitHub gist https://gist.github.com/john/1');
        });

        it('detaches a Git version into stored files with a warning', async () => {
            const gitRepoUrl = 'https://github.com/john/repo.git';
            versionGetMock.mockResolvedValue(mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl }));
            const result = await callTool({
                expectedRevision: buildUrlRevision('GIT_REPO', gitRepoUrl),
                replaceFiles: [{ path: '.actor/actor.json', content: '{}' }],
            });
            expect(getPutBody()).toEqual({
                sourceType: 'SOURCE_FILES',
                sourceFiles: [{ name: '.actor/actor.json', format: 'TEXT', content: '{}' }],
            });
            expect(result.structuredContent.previousRevision).toBe(buildUrlRevision('GIT_REPO', gitRepoUrl));
            expect(result.structuredContent.warnings).toEqual([
                `The version no longer builds from the Git repository ${gitRepoUrl}; it now builds from the files stored in the version.`,
            ]);
            expect(result.structuredContent.changes).toEqual([
                { path: '.actor/actor.json', action: 'created', hash: sha256Prefix('{}'), sizeBytes: 2 },
            ]);
        });

        it('sets only the build tag of a Git version', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'GIT_REPO', gitRepoUrl: 'https://github.com/john/repo.git' }),
            );
            const result = await callTool({ buildTag: 'beta' });
            expect(getPutBody()).toEqual({ buildTag: 'beta' });
            expect(result.structuredContent.buildTag).toBe('beta');
            expect(result.content[1].text).toContain('build tag set to beta');
        });
    });

    describe('storage refusals', () => {
        it('refuses a zip-stored version', async () => {
            versionGetMock.mockResolvedValue(
                mockVersion({ sourceType: 'TARBALL', tarballUrl: 'https://api.example.test/v2/x' }),
            );
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'src/a.js', content: 'a' }],
            });
            expect(text).toBe(
                'Version 0.1 of john/my-actor is stored as a zip (TARBALL), and zip-stored versions cannot be edited ' +
                    'with this tool yet. Push the whole source with the Apify CLI (apify push) instead.',
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses a result over the 3 MiB inline limit', async () => {
            const big = { name: 'data/big.txt', format: 'TEXT', content: 'x'.repeat(2.5 * 1024 * 1024) };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [ACTOR_JSON, big] }));
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'data/more.txt', content: 'y'.repeat(600 * 1024) }],
            });
            expect(text).toContain('over the 3 MiB a version can store as files');
            expect(text).toContain('apify push');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('counts astral characters as 5 bytes, as the platform does', async () => {
            // 629,146 four-byte characters: 2.4 MiB of UTF-8, 3.0000009 MiB as the platform counts them.
            const astral = '😀'.repeat(629_146);
            const big = { name: 'data/emoji.txt', format: 'TEXT', content: astral };
            versionGetMock.mockResolvedValue(mockVersion({ sourceFiles: [ACTOR_JSON, big] }));
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: 'data/a.txt', content: 'a' }],
            });
            expect(text).toContain('over the 3 MiB');
        });

        it('reports the size the platform measures', async () => {
            const result = await callTool({ operations: [{ type: 'write', path: 'b.txt', content: 'é' }] });
            const expected = ACTOR_JSON.content.length + MAIN_JS.content.length + LOGO.content.length + 2;
            expect(result.structuredContent.totalSizeBytes).toBe(expected);
        });

        it('refuses a call over 2 MiB of content before any request', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'write', path: 'a.txt', content: 'a'.repeat(1024 * 1024) },
                    { type: 'edit', path: 'b.txt', edits: [{ oldText: 'b', newText: 'c'.repeat(1024 * 1024) }] },
                ],
            });
            expect(text).toContain('over the 2 MiB one call takes');
            expect(actorGetMock).not.toHaveBeenCalled();
        });
    });

    describe('input rules', () => {
        it.each([
            ['/etc/passwd', 'is absolute'],
            ['C:\\x.js', 'is absolute'],
            ['src/../../x.js', "has a '..' segment"],
            ['src/\0x.js', 'contains a NUL character'],
            ['./', 'is not a file path'],
        ])('refuses the path %j', async (path, reason) => {
            const text = await callToolExpectingUserError({ operations: [{ type: 'write', path, content: 'x' }] });
            expect(text).toContain(reason);
            expect(actorGetMock).not.toHaveBeenCalled();
        });

        it('matches a path the way get-actor-version lists it', async () => {
            const result = await callTool({
                operations: [{ type: 'delete', path: './src//main.js', expectedHash: MAIN_JS_HASH }],
            });
            expect(result.structuredContent.changes).toEqual([{ path: 'src/main.js', action: 'deleted' }]);
        });

        it('refuses a path over 255 characters', async () => {
            const text = await callToolExpectingUserError({
                operations: [{ type: 'write', path: `${'a'.repeat(256)}.js`, content: 'x' }],
            });
            expect(text).toContain('is over 255 characters');
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it('refuses a field the operation type does not take', async () => {
            const text = await callToolExpectingUserError({
                operations: [
                    { type: 'edit', path: 'src/main.js', content: 'x', edits: [{ oldText: 'a', newText: 'b' }] },
                ],
            });
            expect(text).toBe('operations[0] (edit src/main.js) does not take content; edit takes path, edits.');
        });

        it.each([
            [{ type: 'write', path: 'a.js' }, 'content'],
            [{ type: 'edit', path: 'a.js' }, 'edits'],
            [{ type: 'delete', path: 'a.js' }, 'expectedHash'],
            [{ type: 'move', path: 'a.js' }, 'newPath'],
        ])('refuses %j without its required field', async (operation, field) => {
            const text = await callToolExpectingUserError({ operations: [operation] });
            expect(text).toBe(`operations[0] (${operation.type} a.js) needs ${field}.`);
        });

        it('caps operations at 100 and edits at 50 in the input schema', () => {
            const { ajvValidate } = updateActorVersion as HelperTool;
            const write = { type: 'write', path: 'a.js', content: 'a' };
            expect(ajvValidate({ actor: 'a/b', operations: Array.from({ length: 100 }, () => write) })).toBe(true);
            expect(ajvValidate({ actor: 'a/b', operations: Array.from({ length: 101 }, () => write) })).toBe(false);
            const edits = Array.from({ length: 51 }, () => ({ oldText: 'a', newText: 'b' }));
            expect(ajvValidate({ actor: 'a/b', operations: [{ type: 'edit', path: 'a.js', edits }] })).toBe(false);
        });

        it('keeps every operation field through AJV', () => {
            const { ajvValidate } = updateActorVersion as HelperTool;
            const operation = {
                type: 'write',
                path: 'a.js',
                content: 'a',
                encoding: 'utf8',
                expectedHash: 'h',
                edits: [{ oldText: 'a', newText: 'b', allOccurrences: true }],
                newPath: 'b.js',
            };
            const args = { actor: 'a/b', operations: [operation] };
            expect(ajvValidate(args)).toBe(true);
            expect(args.operations[0]).toEqual(operation);
        });

        it('refuses a call with nothing to write', async () => {
            expect(await callToolExpectingUserError({})).toBe(
                'Nothing to write. Give operations, replaceFiles, gitRepoUrl, or buildTag.',
            );
            expect(await callToolExpectingUserError({ operations: [] })).toContain('Nothing to write.');
        });

        it('refuses autoBuild alone, naming build-actor only when loaded', async () => {
            expect(await callToolExpectingUserError({ autoBuild: true })).toBe(
                'autoBuild alone has nothing to write. Give operations, replaceFiles, gitRepoUrl, or buildTag. ' +
                    `To build the version as it is, use ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
            const bare = await callToolExpectingUserError({ autoBuild: true }, [HELPER_TOOLS.ACTOR_VERSION_UPDATE]);
            expect(bare).toContain('To build the version as it is, start a build of it instead.');
            expectNoToolNamed(bare);
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('lists the versions when the Actor has several and none is given', async () => {
            actorGetMock.mockResolvedValue(
                mockActor({
                    versions: [
                        { versionNumber: '0.1', sourceType: 'SOURCE_FILES', buildTag: 'latest' },
                        { versionNumber: '0.2', sourceType: 'GIT_REPO' },
                    ],
                }),
            );
            const text = await callToolExpectingUserError({ operations: [{ type: 'write', path: 'a', content: 'a' }] });
            expect(text).toBe(
                'Specify versionNumber; this Actor has versions: 0.1 (SOURCE_FILES, build tag latest), 0.2 (GIT_REPO).',
            );
        });
    });

    describe('buildTag', () => {
        it('sends only buildTag when the files do not change', async () => {
            const result = await callTool({ buildTag: 'beta' });
            expect(getPutBody()).toEqual({ buildTag: 'beta' });
            expect(result.structuredContent.changed).toBe(true);
            expect(result.structuredContent.buildTag).toBe('beta');
        });

        it('sends buildTag with the files', async () => {
            await callTool({ buildTag: 'beta', operations: [{ type: 'write', path: 'b.js', content: 'b' }] });
            expect(Object.keys(getPutBody()).sort()).toEqual(['buildTag', 'sourceFiles', 'sourceType']);
        });

        it('sends nothing for the build tag the version already has', async () => {
            const result = await callTool({ buildTag: 'latest' });
            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(result.structuredContent.changed).toBe(false);
        });
    });

    describe('autoBuild', () => {
        it('starts a build without waiting and points at get-actor-build', async () => {
            const result = await callTool({
                autoBuild: true,
                operations: [{ type: 'write', path: 'b.js', content: 'b' }],
            });
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
            expect(result.content[1].text).toContain(
                `Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId build-1`,
            );
        });

        it('names no tool after a build when get-actor-build is not loaded', async () => {
            const result = await callTool(
                { autoBuild: true, operations: [{ type: 'write', path: 'b.js', content: 'b' }] },
                [HELPER_TOOLS.ACTOR_VERSION_UPDATE],
            );
            expect(result.content[1].text).toContain('The build is still running');
            expectNoToolNamed(result.content[1].text);
        });

        it('still starts a build when nothing changed', async () => {
            const result = await callTool({
                autoBuild: true,
                operations: [{ type: 'write', path: 'src/main.js', content: MAIN_JS.content }],
            });
            expect(versionUpdateMock).not.toHaveBeenCalled();
            expect(buildMock).toHaveBeenCalledTimes(1);
            expect(result.structuredContent.changed).toBe(false);
            expect(result.structuredContent.build?.id).toBe('build-1');
        });

        it('reports a build that failed to start with the write still done', async () => {
            buildMock.mockRejectedValue(apiError(402, 'Not enough credit'));
            const result = await callTool({
                autoBuild: true,
                operations: [{ type: 'write', path: 'b.js', content: 'b' }],
            });
            expectSchemaConformingStructuredContent(result, updateActorVersionToolOutputSchema);
            expect(versionUpdateMock).toHaveBeenCalledTimes(1);
            expect(result.structuredContent.buildError).toBe('Not enough credit');
            expect(result.structuredContent).not.toHaveProperty('build');
            expect(result.content[1].text).toContain(
                `The change was saved, but the build could not be started: Not enough credit. Start it again with ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
            const bare = await callTool(
                { autoBuild: true, operations: [{ type: 'write', path: 'b.js', content: 'b' }] },
                [HELPER_TOOLS.ACTOR_VERSION_UPDATE],
            );
            expect(bare.content[1].text).toContain('Start the build again to make this version runnable.');
            expectNoToolNamed(bare.content[1].text);
        });

        it('names build-actor after a write without autoBuild only when loaded', async () => {
            const write = { operations: [{ type: 'write', path: 'b.js', content: 'b' }] };
            expect((await callTool(write)).content[1].text).toContain(`Build it with ${HELPER_TOOLS.ACTOR_BUILD}.`);
            const bare = await callTool(write, [HELPER_TOOLS.ACTOR_VERSION_UPDATE]);
            expectNoToolNamed(bare.content[1].text);
        });
    });

    describe('ownership', () => {
        const write = { operations: [{ type: 'write', path: 'b.js', content: 'b' }] };

        it('refuses a session without a token before any request', async () => {
            const context = {
                ...stubToolCallContext({ actor: 'john/my-actor', ...write }, stubClient),
                apifyToken: '',
            };
            const result = (await (updateActorVersion as HelperTool).call(context)) as UpdateResult;
            expect(result.isError).toBe(true);
            expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
            expect(result.content[0].text).toBe(
                "Changing an Actor's source needs an Apify API token, and this session has none.",
            );
            expect(actorMock).not.toHaveBeenCalled();
        });

        it('refuses an Actor that does not exist or a bare name', async () => {
            actorGetMock.mockResolvedValue(undefined);
            expect(await callToolExpectingUserError({ ...write, actor: 'my-actor' })).toBe(
                'Actor my-actor not found. Give its ID or its full name, username/name; a name without the username is not enough.',
            );
        });

        it('refuses when the account cannot be confirmed', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo({ userId: null }));
            const result = await callTool(write);
            expect(result.toolTelemetry).toEqual(
                expect.objectContaining({ toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.AUTH }),
            );
            expect(result.content[0].text).toContain(
                'Could not confirm which account this token belongs to, so john/my-actor was not changed.',
            );
            expect(versionGetMock).not.toHaveBeenCalled();
        });

        it('reports a sub-resource reached by extra path segments as not found', async () => {
            actorGetMock.mockResolvedValue({ id: 'run-1', userId: 'user-1', actId: 'actor-1' });
            expect(await callToolExpectingUserError({ ...write, actor: 'john/my-actor/runs/last' })).toBe(
                'Actor john/my-actor/runs/last not found. Give its ID or its full name, username/name; a name ' +
                    'without the username is not enough.',
            );
            expect(versionGetMock).not.toHaveBeenCalled();
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });

        it("refuses someone else's Actor", async () => {
            actorGetMock.mockResolvedValue(mockActor({ userId: 'someone-else' }));
            expect(await callToolExpectingUserError(write)).toBe(
                'john/my-actor is not in your account; this tool changes only your own Actors.',
            );
            expect(versionUpdateMock).not.toHaveBeenCalled();
        });
    });

    describe('API errors', () => {
        it('returns a 4xx from the PUT as the API message', async () => {
            versionUpdateMock.mockRejectedValue(apiError(400, 'Invalid source files'));
            const result = await callTool({ operations: [{ type: 'write', path: 'b.js', content: 'b' }] });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Invalid source files');
        });

        it('rethrows a 5xx', async () => {
            versionGetMock.mockRejectedValue(apiError(500, 'Internal'));
            await expect(callTool({ operations: [{ type: 'write', path: 'b.js', content: 'b' }] })).rejects.toThrow(
                'Internal',
            );
        });
    });
});
