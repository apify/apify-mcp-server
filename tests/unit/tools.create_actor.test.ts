import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { prepareToolCallContext } from '../../src/payments/helpers.js';
import { createActor } from '../../src/tools/source/create_actor.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { buildFilesRevision } from '../../src/tools/source/source_files.js';
import { createActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
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

const actorsCreateMock = vi.fn();
const buildMock = vi.fn();
const actorGetMock = vi.fn();
const actorMock = vi.fn(() => ({ build: buildMock, get: actorGetMock }));
// The build client, which only waiting for a build uses.
const buildClientMock = vi.fn();

const stubClient = {
    actors: () => ({ create: actorsCreateMock }),
    actor: actorMock,
    build: buildClientMock,
} as unknown as InternalToolArgs['apifyClient'];

/** Already names the Actor, so the platform stores it unchanged. */
const ACTOR_JSON = { path: '.actor/actor.json', content: '{"actorSpecification": 1, "name": "my-actor"}' };
const DOCKERFILE = { path: 'Dockerfile', content: 'FROM apify/actor-node:20\n' };
const MAIN_JS = { path: 'src/main.js', content: 'console.log(1);\n' };

type CreateOutput = {
    actorId: string;
    fullName: string;
    versionNumber: string;
    revision: string;
    files: { path: string; sizeBytes: number; hash: string }[];
    warnings?: string[];
    build?: Record<string, unknown>;
    buildError?: string;
};

type CreateResult = TextToolResult & { structuredContent: CreateOutput; toolTelemetry?: ToolTelemetrySnapshot };

type SentVersion = {
    versionNumber?: string;
    buildTag?: string;
    sourceFiles: { name: string; format: string; content: string }[];
};

/**
 * What the platform stores on create: the only version gets the build tag latest when none is sent, and
 * `.actor/actor.json` gets `name` set to the Actor name, or stays as sent when it is not JSON. The version number is
 * not defaulted: the platform refuses a version without one.
 */
function buildStoredVersions(body: { name: string; versions: SentVersion[] }) {
    return body.versions.map((version) => ({
        buildTag: 'latest',
        ...version,
        sourceFiles: version.sourceFiles.map((file) => {
            if (file.name !== '.actor/actor.json') return file;
            let config: { name?: string };
            try {
                config = JSON.parse(file.content) as { name?: string };
            } catch {
                return file;
            }
            if (config.name === body.name) return file;
            return { ...file, content: JSON.stringify({ ...config, name: body.name }, null, 4) };
        }),
    }));
}

function sha256Prefix(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** `attempt` counts apify-client's tries of the request, retries included. */
function apiError(status: number, message: string, type = 'some-error', attempt = 1): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, attempt);
}

async function callTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<CreateResult> {
    const context = stubToolCallContext({ name: 'my-actor', ...args }, stubClient);
    const withSignal = signal === undefined ? context : { ...context, signal };
    return (await (createActor as HelperTool).call(withSignal)) as CreateResult;
}

/** The listing get-actor-version returns for the version the platform stored from the POST. */
async function readCreatedVersion(): Promise<{ revision: string; files: unknown[] }> {
    const [body] = actorsCreateMock.mock.calls[0] as [{ name: string; versions: SentVersion[] }];
    actorGetMock.mockResolvedValue({
        id: 'actor-9',
        name: 'my-actor',
        username: 'john',
        versions: buildStoredVersions(body),
    });
    const read = (await (getActorVersion as HelperTool).call(
        stubToolCallContext({ actor: 'john/my-actor' }, stubClient),
    )) as { structuredContent: { revision: string; files: unknown[] } };
    return read.structuredContent;
}

function getSentVersion(): SentVersion & Record<string, unknown> {
    const [body] = actorsCreateMock.mock.calls[0] as [{ versions: (SentVersion & Record<string, unknown>)[] }];
    return body.versions[0];
}

describe('create-actor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actorsCreateMock.mockImplementation(async (body: { name: string; versions: SentVersion[] }) => ({
            id: 'actor-9',
            name: body.name,
            username: 'john',
            versions: buildStoredVersions(body),
        }));
        buildMock.mockResolvedValue({
            id: 'build-1',
            actId: 'actor-9',
            buildNumber: '0.0.1',
            status: 'READY',
            startedAt: new Date('2026-09-01T10:00:00.000Z'),
        });
    });

    describe('input schema', () => {
        const validate = (args: Record<string, unknown>) => (createActor as HelperTool).ajvValidate(args);
        const file = { path: 'src/main.js', content: 'x' };

        it('requires only name and files', () => {
            expect((createActor as HelperTool).inputSchema.required).toEqual(['name', 'files']);
        });

        it('keeps every field it declares and strips unknown keys', () => {
            const args = {
                name: 'my-actor',
                title: 'My Actor',
                description: '',
                files: [{ ...file, encoding: 'base64', extra: 1 }],
                versionNumber: '1.0',
                buildTag: 'beta',
                autoBuild: true,
                unknown: 'x',
            };

            expect(validate(args)).toBe(true);
            expect(args).toStrictEqual({
                name: 'my-actor',
                title: 'My Actor',
                description: '',
                files: [{ ...file, encoding: 'base64' }],
                versionNumber: '1.0',
                buildTag: 'beta',
                autoBuild: true,
            });
        });

        it.each<[string, Record<string, unknown>]>([
            ['no name', { files: [file] }],
            ['an empty name', { name: '', files: [file] }],
            ['no files', { name: 'x' }],
            ['empty files', { name: 'x', files: [] }],
            ['an empty title', { name: 'x', title: '', files: [file] }],
            ['an empty buildTag', { name: 'x', buildTag: '', files: [file] }],
            ['an empty path', { name: 'x', files: [{ path: '', content: 'x' }] }],
            ['a file without a path', { name: 'x', files: [{ content: 'x' }] }],
            ['a file without content', { name: 'x', files: [{ path: 'a.js' }] }],
            ['an unknown encoding', { name: 'x', files: [{ ...file, encoding: 'hex' }] }],
        ])('rejects %s', (_, args) => {
            expect(validate(args)).toBe(false);
        });

        it('accepts one empty file', () => {
            expect(validate({ name: 'x', files: [{ path: 'a.js', content: '' }] })).toBe(true);
        });
    });

    describe('logged arguments', () => {
        const SECRET = 'synthetic-secret-4f2a';
        const getLoggedArgs = (args: Record<string, unknown>) =>
            prepareToolCallContext({ provider: undefined, tool: createActor, args, apifyToken: 'test-token' })
                .toolArgsRedacted;

        it('keep the paths and other metadata, and replace file content with a marker', () => {
            const args = {
                name: 'my-actor',
                title: 'My Actor',
                description: 'Scrapes pages',
                versionNumber: '1.0',
                buildTag: 'beta',
                autoBuild: true,
                files: [
                    { path: 'src/config.js', content: `export const key = '${SECRET}';\n`, encoding: 'utf8' },
                    { path: 'assets/key.bin', content: Buffer.from(SECRET).toString('base64'), extra: SECRET },
                ],
                undeclared: SECRET,
            };
            const argsBefore = structuredClone(args);

            const logged = getLoggedArgs(args);

            expect(JSON.stringify(logged)).not.toContain(SECRET);
            expect(JSON.stringify(logged)).not.toContain(Buffer.from(SECRET).toString('base64'));
            expect(logged).toStrictEqual({
                name: 'my-actor',
                title: 'My Actor',
                description: 'Scrapes pages',
                versionNumber: '1.0',
                buildTag: 'beta',
                autoBuild: true,
                files: [
                    { path: 'src/config.js', encoding: 'utf8', content: '[REDACTED]' },
                    { path: 'assets/key.bin', content: '[REDACTED]' },
                ],
            });
            expect(args).toStrictEqual(argsBefore);
        });

        it.each<[string, Record<string, unknown>]>([
            ['no arguments', {}],
            ['files that are not a list', { files: SECRET }],
            ['files that are not objects', { files: [SECRET, null, 1, [SECRET]] }],
            ['a path that is not a string', { files: [{ path: { text: SECRET }, content: 'x' }] }],
            ['content that is not a string', { files: [{ path: 'a.js', content: { text: SECRET } }] }],
            ['a name that is not a string', { name: [SECRET], files: [] }],
        ])('accept %s without throwing or logging their values', (_, args) => {
            const argsBefore = structuredClone(args);

            expect(JSON.stringify(getLoggedArgs(args))).not.toContain(SECRET);
            expect(args).toStrictEqual(argsBefore);
        });
    });

    it('is a non-destructive, non-idempotent, open-world tool without payment, since autoBuild starts a build', () => {
        expect(createActor.name).toBe(HELPER_TOOLS.ACTOR_CREATE);
        expect(createActor.annotations).toEqual({
            title: 'Create Actor',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        });
        expect((createActor as HelperTool).paymentRequired).toBeUndefined();
    });

    it('creates the Actor and version 0.0 in one POST, with no env vars and no build tag', async () => {
        const result = await callTool({
            title: 'My Actor',
            description: 'Does things.',
            files: [MAIN_JS, ACTOR_JSON, DOCKERFILE],
        });

        expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
        expect(actorsCreateMock).toHaveBeenCalledTimes(1);
        expect(actorsCreateMock).toHaveBeenCalledWith({
            name: 'my-actor',
            title: 'My Actor',
            description: 'Does things.',
            versions: [
                {
                    versionNumber: '0.0',
                    sourceType: 'SOURCE_FILES',
                    sourceFiles: [
                        { name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content },
                        { name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content },
                        { name: 'Dockerfile', format: 'TEXT', content: DOCKERFILE.content },
                    ],
                },
            ],
        });
        const files = [ACTOR_JSON, DOCKERFILE, MAIN_JS].map(({ path, content }) => ({
            path,
            sizeBytes: content.length,
            hash: sha256Prefix(content),
        }));
        expect(result.structuredContent).toEqual({
            actorId: 'actor-9',
            fullName: 'john/my-actor',
            versionNumber: '0.0',
            revision: buildFilesRevision(files),
            files,
        });
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(result.content[1].text).toBe(
            'Created the private Actor john/my-actor.\nNo build was started; runs use these files only after the version is built.',
        );
        // No other call: nothing reads or updates an existing Actor, and no build starts.
        expect(actorMock).not.toHaveBeenCalled();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('sends only the name and the version when title and description are not given', async () => {
        await callTool({ files: [MAIN_JS] });

        expect(actorsCreateMock.mock.calls).toStrictEqual([
            [
                {
                    name: 'my-actor',
                    versions: [
                        {
                            versionNumber: '0.0',
                            sourceType: 'SOURCE_FILES',
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content }],
                        },
                    ],
                },
            ],
        ]);
    });

    it('sends an empty description as given', async () => {
        await callTool({ description: '', files: [MAIN_JS] });

        expect(actorsCreateMock.mock.calls).toStrictEqual([
            [
                {
                    name: 'my-actor',
                    description: '',
                    versions: [
                        {
                            versionNumber: '0.0',
                            sourceType: 'SOURCE_FILES',
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: MAIN_JS.content }],
                        },
                    ],
                },
            ],
        ]);
    });

    it('sends versionNumber and buildTag when given', async () => {
        const result = await callTool({ versionNumber: '1.2', buildTag: 'beta', files: [ACTOR_JSON] });

        expect(actorsCreateMock.mock.calls).toStrictEqual([
            [
                {
                    name: 'my-actor',
                    versions: [
                        {
                            versionNumber: '1.2',
                            buildTag: 'beta',
                            sourceType: 'SOURCE_FILES',
                            sourceFiles: [{ name: '.actor/actor.json', format: 'TEXT', content: ACTOR_JSON.content }],
                        },
                    ],
                },
            ],
        ]);
        expect(result.structuredContent.versionNumber).toBe('1.2');
    });

    it('returns the hashes and revision of the files as stored, which a later read returns', async () => {
        const unnamedConfig = { path: '.actor/actor.json', content: '{"actorSpecification": 1}' };
        const result = await callTool({ files: [unnamedConfig, MAIN_JS] });
        const storedConfig = JSON.stringify({ actorSpecification: 1, name: 'my-actor' }, null, 4);
        const [body] = actorsCreateMock.mock.calls[0] as [{ name: string; versions: SentVersion[] }];
        actorGetMock.mockResolvedValue({
            id: 'actor-9',
            name: 'my-actor',
            username: 'john',
            versions: buildStoredVersions(body),
        });
        const read = (await (getActorVersion as HelperTool).call(
            stubToolCallContext({ actor: 'john/my-actor' }, stubClient),
        )) as { structuredContent: { revision: string; files: unknown[] } };

        expect(result.structuredContent.files[0]).toEqual({
            path: '.actor/actor.json',
            sizeBytes: storedConfig.length,
            hash: sha256Prefix(storedConfig),
        });
        expect(result.structuredContent.revision).toBe(read.structuredContent.revision);
        expect(result.structuredContent.files).toEqual(read.structuredContent.files);
    });

    it('stores binary files as BASE64 and lists them by their decoded bytes', async () => {
        const bytes = Buffer.from([137, 80, 78, 71]);
        const readme = Buffer.from('hello\n').toString('base64');
        const result = await callTool({
            files: [
                { path: 'assets/logo.png', content: bytes.toString('base64') },
                { path: 'README.md', content: readme, encoding: 'base64' },
            ],
        });

        expect(getSentVersion().sourceFiles).toEqual([
            { name: 'assets/logo.png', format: 'BASE64', content: bytes.toString('base64') },
            { name: 'README.md', format: 'BASE64', content: readme },
        ]);
        expect(result.structuredContent.files).toContainEqual({
            path: 'assets/logo.png',
            sizeBytes: 4,
            hash: sha256Prefix(bytes),
        });
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
    ])('stores %s with encoding %s as %s, with the content as sent', async (path, encoding, format) => {
        const content = 'aGk=';

        await callTool({ files: [{ path, content, ...(encoding !== undefined && { encoding }) }] });

        expect(getSentVersion().sourceFiles).toStrictEqual([{ name: path, format, content }]);
    });

    it('sends utf8 content byte for byte', async () => {
        const content = '\uFEFFline one  \r\nnázev = "🙂"\n\tend\r';

        await callTool({ files: [{ path: 'src/main.js', content, encoding: 'utf8' }] });

        expect(getSentVersion().sourceFiles).toStrictEqual([{ name: 'src/main.js', format: 'TEXT', content }]);
    });

    it('sends non-ASCII paths as given, NFC and NFD forms as two files, with the hashes and revision a later read returns', async () => {
        const nfcPath = 'src/n\u00e1zev.js';
        const nfdPath = 'src/na\u0301zev.js';

        const result = await callTool({
            files: [
                { path: nfcPath, content: 'x' },
                { path: nfdPath, content: 'y' },
            ],
        });

        expect(getSentVersion().sourceFiles).toStrictEqual([
            { name: nfcPath, format: 'TEXT', content: 'x' },
            { name: nfdPath, format: 'TEXT', content: 'y' },
        ]);
        const read = await readCreatedVersion();
        expect(result.structuredContent.files).toEqual(read.files);
        expect(result.structuredContent.revision).toBe(read.revision);
        // NFD sorts first: its 'a' comes before the NFC 'á'.
        expect(result.structuredContent.files.map(({ path }) => path)).toEqual([nfdPath, nfcPath]);
    });

    it('normalizes paths the way get-actor-version lists them', async () => {
        const result = await callTool({
            files: [
                { path: './src//main.js', content: 'x' },
                { path: 'src/../README.md', content: 'y' },
                { path: 'src/./lib/util.js', content: 'z' },
            ],
        });

        expect(getSentVersion().sourceFiles).toEqual([
            { name: 'src/main.js', format: 'TEXT', content: 'x' },
            { name: 'README.md', format: 'TEXT', content: 'y' },
            { name: 'src/lib/util.js', format: 'TEXT', content: 'z' },
        ]);
        expect(result.structuredContent.files.map(({ path }) => path)).toEqual([
            'README.md',
            'src/lib/util.js',
            'src/main.js',
        ]);
    });

    it.each(['/src/main.js', '..', '../x.js', 'src/../../x.js'])(
        'refuses a file at %s, outside the Actor root, which the build refuses, and creates nothing',
        async (path) => {
            const result = await callTool({ autoBuild: true, files: [MAIN_JS, { path, content: 'x' }] });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(
                `files[1] (${path}) has a path outside the Actor root; paths are relative to it, such as src/main.js.`,
            );
            expect(actorsCreateMock).not.toHaveBeenCalled();
            expect(buildMock).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['U+0000', 'src/a\0.js'],
        ['U+000A', 'src/\nmain.js'],
        ['U+0009', 'src/a\tb.js'],
        ['U+001F', 'src/a\u001f.js'],
        ['U+007F', 'src/a\u007f.js'],
    ])('refuses a path with the control character %s, and creates nothing', async (character, path) => {
        const result = await callTool({ autoBuild: true, files: [MAIN_JS, { path, content: 'x' }] });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            `files[1] has the control character ${character} in its path; ` +
                'a path cannot hold characters U+0000 to U+001F or U+007F.',
        );
        expect(actorsCreateMock).not.toHaveBeenCalled();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('refuses a path with a lone UTF-16 surrogate, and creates nothing', async () => {
        const result = await callTool({ autoBuild: true, files: [MAIN_JS, { path: 'src/a\uD83D.js', content: 'x' }] });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'files[1] has a lone UTF-16 surrogate in its path, which UTF-8 cannot store.',
        );
        expect(actorsCreateMock).not.toHaveBeenCalled();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it.each(['.', 'src/', 'src/..'])(
        'refuses a file at %s, which names a folder, and creates nothing',
        async (path) => {
            const result = await callTool({ files: [{ path, content: 'x' }] });

            expectSoftFailInvalidInput(result);
            expect(result.content[0].text).toBe(`files[0] (${path}) has a path that names a folder, not a file.`);
            expect(actorsCreateMock).not.toHaveBeenCalled();
        },
    );

    it.each([
        [
            'a file under another file',
            [{ path: 'src', content: 'x' }, MAIN_JS],
            'files[1] (src/main.js) collides with src',
        ],
        [
            'a file at the folder of another file',
            [MAIN_JS, { path: 'src', content: 'x' }],
            'files[1] (src) collides with src/main.js',
        ],
        [
            'a file two folders under another file',
            [
                { path: 'src', content: 'x' },
                { path: 'src/lib/util.js', content: 'x' },
            ],
            'files[1] (src/lib/util.js) collides with src',
        ],
        [
            'a file at a folder two levels above another file',
            [
                { path: 'src/lib/util.js', content: 'x' },
                { path: 'src', content: 'x' },
            ],
            'files[1] (src) collides with src/lib/util.js',
        ],
        [
            'a file at a nested folder of an earlier file',
            [MAIN_JS, { path: 'src/lib/util.js', content: 'x' }, { path: 'src/lib', content: 'x' }],
            'files[2] (src/lib) collides with src/lib/util.js',
        ],
    ])('refuses %s, since a path cannot be both a file and a folder, and creates nothing', async (_, files, prefix) => {
        const result = await callTool({ files });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(`${prefix}; one path cannot be both a file and a folder.`);
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it('checks 20,000 files for repeated and colliding paths within a second', async () => {
        const files = Array.from({ length: 20_000 }, (_, i) => ({ path: `src/d${i % 50}/f${i}.js`, content: 'x' }));

        const startedAt = performance.now();
        await callTool({ files });

        expect(performance.now() - startedAt).toBeLessThan(1000);
        expect(getSentVersion().sourceFiles).toHaveLength(20_000);
    });

    it.each([
        ['a.js', './a.js', 'a.js'],
        ['.actor/actor.json', '.actor//actor.json', '.actor/actor.json'],
        ['src/main.js', 'src/main.js', 'src/main.js'],
    ])('refuses %s and %s, two files at the same path, and creates nothing', async (first, second, path) => {
        const result = await callTool({
            files: [
                { path: first, content: '1' },
                { path: second, content: '2' },
            ],
        });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            `files[1] (${second}) repeats the path ${path}; each path can be sent only once.`,
        );
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it.each([
        ['base64 that is a data URI', { path: 'assets/a.png', content: 'data:image/png;base64,iVBORw0KGgo=' }],
        ['text sent to a binary extension', { path: 'assets/a.png', content: 'hello world' }],
        ['text sent with encoding base64', { path: 'README.md', content: '# Title\n', encoding: 'base64' }],
    ])('refuses %s, which would be stored corrupted, and creates nothing', async (_, file) => {
        const result = await callTool({ files: [MAIN_JS, file] });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            `files[1] (${file.path}) has content that is not valid base64; encoding base64 takes binary content as base64, and text takes encoding utf8.`,
        );
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it('refuses text with a lone UTF-16 surrogate, and creates nothing', async () => {
        const result = await callTool({ files: [{ path: 'src/a.js', content: 'smile \uD83D' }] });

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'files[0] (src/a.js) has text with a lone UTF-16 surrogate, which UTF-8 cannot store.',
        );
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it('warns about empty files, which the build skips', async () => {
        const result = await callTool({ files: [ACTOR_JSON, { path: 'src/__init__.py', content: '' }] });

        expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
        expect(result.structuredContent.warnings).toEqual([
            'These files are empty, and the build skips empty files, so they will not exist in the build: src/__init__.py.',
        ]);
    });

    it('creates nothing when the request is cancelled before the POST', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await callTool({ files: [ACTOR_JSON] }, controller.signal);

        expect(actorsCreateMock).not.toHaveBeenCalled();
        expect(result).toEqual({});
    });

    it('keeps the Actor and starts no build when the request is cancelled during the POST', async () => {
        const controller = new AbortController();
        const create = actorsCreateMock.getMockImplementation();
        actorsCreateMock.mockImplementation(async (body: { name: string; versions: SentVersion[] }) => {
            controller.abort();
            return create?.(body);
        });

        const result = await callTool({ autoBuild: true, files: [ACTOR_JSON] }, controller.signal);

        expect(result).toEqual({});
        expect(actorsCreateMock).toHaveBeenCalledTimes(1);
        expect(actorMock).not.toHaveBeenCalled();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('keeps the Actor and starts no build when the request is cancelled during the Console link lookup', async () => {
        const controller = new AbortController();
        vi.mocked(getUserInfoCached).mockImplementationOnce(async () => {
            controller.abort();
            return mockUserInfo();
        });

        const result = await (createActor as HelperTool).call({
            ...stubToolCallContext({ name: 'my-actor', autoBuild: true, files: [ACTOR_JSON] }, stubClient),
            apifyToken: 'apify_ui_test',
            signal: controller.signal,
        });

        expect(result).toEqual({});
        expect(getUserInfoCached).toHaveBeenCalledTimes(1);
        expect(actorsCreateMock).toHaveBeenCalledTimes(1);
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('keeps the build it started when the request is cancelled during the build start', async () => {
        const controller = new AbortController();
        buildMock.mockImplementationOnce(async () => {
            controller.abort();
            return { id: 'build-1', actId: 'actor-9', buildNumber: '0.0.1', status: 'RUNNING' };
        });
        // The build client is what aborts a build.
        const abortMock = vi.fn(async () => ({}));
        buildClientMock.mockReturnValueOnce({ abort: abortMock });

        const result = await callTool({ autoBuild: true, files: [ACTOR_JSON] }, controller.signal);

        expect(buildMock).toHaveBeenCalledTimes(1);
        expect(buildClientMock).not.toHaveBeenCalled();
        expect(abortMock).not.toHaveBeenCalled();
        expect(result.structuredContent.build).toEqual(expect.objectContaining({ id: 'build-1', status: 'RUNNING' }));
    });

    it('lets an API error through unchanged, such as a name already taken, with no other call', async () => {
        const error = apiError(409, 'Some other Actor already has this name.', 'actor-name-not-unique');
        actorsCreateMock.mockRejectedValue(error);

        await expect(callTool({ autoBuild: true, files: [ACTOR_JSON] })).rejects.toBe(error);
        expect(actorsCreateMock).toHaveBeenCalledTimes(1);
        expect(actorMock).not.toHaveBeenCalled();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('says an earlier attempt may have created the Actor when the platform refuses the name on a retried POST', async () => {
        // apify-client retries a POST that timed out or got a 5xx, and the platform may have saved the attempt.
        actorsCreateMock.mockRejectedValue(
            apiError(409, 'Some other Actor already has this name ("my-actor").', 'actor-name-not-unique', 2),
        );

        const result = await callTool({ autoBuild: true, files: [ACTOR_JSON] });

        expectSoftFailInvalidInput(result);
        expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureHttpStatus: 409 }));
        expect(result.structuredContent).toBeUndefined();
        expect(result.content).toStrictEqual([
            {
                type: 'text',
                text:
                    'The platform refused the name my-actor as taken when the request was retried, so an earlier ' +
                    'attempt of this call may have created the Actor my-actor. ' +
                    'If it holds the files you sent, this call created it; get-actor-version reads its files.',
            },
        ]);
        expect(actorsCreateMock).toHaveBeenCalledTimes(1);
        expect(actorMock).not.toHaveBeenCalled();
        expect(buildMock).not.toHaveBeenCalled();
    });

    it('names get-actor-version on a retried POST only when the session has it', async () => {
        actorsCreateMock.mockRejectedValue(
            apiError(409, 'Some other Actor already has this name ("my-actor").', 'actor-name-not-unique', 2),
        );
        const loadedToolNames = Object.values(HELPER_TOOLS).filter((name) => name !== HELPER_TOOLS.ACTOR_VERSION_GET);
        const context = stubToolCallContext({ name: 'my-actor', files: [ACTOR_JSON] }, stubClient, { loadedToolNames });

        const result = (await (createActor as HelperTool).call(context)) as CreateResult;

        expectSoftFailInvalidInput(result);
        expect(result.content[0].text).toBe(
            'The platform refused the name my-actor as taken when the request was retried, so an earlier attempt ' +
                'of this call may have created the Actor my-actor. If it holds the files you sent, this call created it.',
        );
    });

    it('lets any other API error of a retried POST through unchanged', async () => {
        const error = apiError(400, 'Invalid version number.', 'invalid-input', 2);
        actorsCreateMock.mockRejectedValue(error);

        await expect(callTool({ files: [ACTOR_JSON] })).rejects.toBe(error);
    });

    describe('version number from .actor/actor.json', () => {
        const actorJsonWith = (content: string) => ({ path: '.actor/actor.json', content });

        it('takes the version of .actor/actor.json when versionNumber is not given', async () => {
            const result = await callTool({
                autoBuild: true,
                files: [actorJsonWith('{"actorSpecification": 1, "name": "my-actor", "version": "0.1"}')],
            });

            expect(getSentVersion().versionNumber).toBe('0.1');
            expect(result.structuredContent.versionNumber).toBe('0.1');
            expect(buildMock).toHaveBeenCalledWith('0.1', { useCache: true });
        });

        it.each<[string, { path: string; content: string }[]]>([
            ['no .actor/actor.json', [MAIN_JS]],
            ['an actor.json without a version', [ACTOR_JSON]],
            ['an actor.json whose version is not a string', [actorJsonWith('{"version": 0.1}')]],
            ['an actor.json with an empty version', [actorJsonWith('{"version": ""}')]],
            ['an actor.json that is not JSON', [actorJsonWith('{"version": "0.1",')]],
        ])('sends version 0.0 for %s', async (_, files) => {
            const result = await callTool({ files });

            expect(getSentVersion().versionNumber).toBe('0.0');
            expect(result.structuredContent.versionNumber).toBe('0.0');
        });

        it.each([
            ['the version of .actor/actor.json', actorJsonWith('{"version": "0.1"}'), '0.1'],
            ['version 0.0 when .actor/actor.json has none', ACTOR_JSON, '0.0'],
        ])('sends %s for a null versionNumber', async (_, file, versionNumber) => {
            const args = { name: 'my-actor', versionNumber: null, files: [file] };

            expect((createActor as HelperTool).ajvValidate(args)).toBe(true);
            await callTool(args);

            expect(getSentVersion().versionNumber).toBe(versionNumber);
        });

        it('sends versionNumber when .actor/actor.json has another version', async () => {
            await callTool({ versionNumber: '0.2', files: [actorJsonWith('{"version": "0.1"}')] });

            expect(getSentVersion().versionNumber).toBe('0.2');
        });

        it('sends a version of .actor/actor.json that is not MAJOR.MINOR as is, for the API to refuse', async () => {
            const error = apiError(400, 'Invalid version number.', 'invalid-input');
            actorsCreateMock.mockRejectedValue(error);

            await expect(callTool({ files: [actorJsonWith('{"version": "1.0.0"}')] })).rejects.toBe(error);
            expect(getSentVersion().versionNumber).toBe('1.0.0');
        });
    });

    describe('autoBuild', () => {
        it('starts a build without waiting', async () => {
            const result = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] });

            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            expect(actorMock).toHaveBeenCalledWith('actor-9');
            expect(buildMock).toHaveBeenCalledWith('0.0', { useCache: true });
            expect(result.structuredContent.build).toEqual(
                expect.objectContaining({ id: 'build-1', buildNumber: '0.0.1', status: 'READY' }),
            );
            expect(result.content).toHaveLength(2);
            expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        });

        it('adds the build Console link for an Apify Console session', async () => {
            vi.mocked(getUserInfoCached).mockResolvedValue(mockUserInfo());

            const result = (await (createActor as HelperTool).call({
                ...stubToolCallContext({ name: 'my-actor', autoBuild: true, files: [ACTOR_JSON] }, stubClient),
                apifyToken: 'apify_ui_test',
            })) as CreateResult;

            const consoleUrl = 'https://console.apify.com/actors/actor-9/builds/0.0.1';
            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            expect(getUserInfoCached).toHaveBeenCalledWith('apify_ui_test', stubClient);
            expect(result.structuredContent.build?.apifyConsoleUrl).toBe(consoleUrl);
            expect(result.content).toHaveLength(3);
            expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
            expect(result.content[2].text).toBe(`Apify Console: ${consoleUrl}\n${VERBATIM_LINKS_NUDGE}`);
        });

        it('builds the version it created without waiting for the build', async () => {
            buildMock.mockResolvedValue({ id: 'build-2', actId: 'actor-9', buildNumber: '1.2.1', status: 'RUNNING' });

            const result = await callTool({ autoBuild: true, versionNumber: '1.2', files: [ACTOR_JSON] });

            expect(actorMock.mock.calls).toEqual([['actor-9']]);
            expect(buildMock.mock.calls).toEqual([['1.2', { useCache: true }]]);
            expect(buildClientMock).not.toHaveBeenCalled();
            expect(result.structuredContent.build).toEqual(
                expect.objectContaining({ id: 'build-2', buildNumber: '1.2.1', status: 'RUNNING' }),
            );
        });

        it('reports a build start that failed on the network as buildError, with the Actor still created', async () => {
            buildMock.mockRejectedValue(
                Object.assign(new Error('socket hang up'), { request: {}, config: {}, code: 'ECONNRESET' }),
            );

            const result = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] });

            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            expect(actorsCreateMock).toHaveBeenCalledTimes(1);
            expect(result.structuredContent.actorId).toBe('actor-9');
            expect(result.structuredContent.buildError).toBe('socket hang up');
            expect(result.content[1].text).toBe(
                'Created the private Actor john/my-actor.\nThe build could not be started; runs use these files only after the version is built.',
            );
        });

        it('reports a build that failed to start with the Actor still created', async () => {
            buildMock.mockRejectedValue(apiError(403, 'Build limit reached'));

            const result = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] });

            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            expect(result.structuredContent.actorId).toBe('actor-9');
            expect(result.structuredContent.buildError).toBe('Build limit reached');
        });
    });
});
