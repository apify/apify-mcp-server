import { createHash } from 'node:crypto';

import { ApifyApiError } from 'apify-client';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../src/const.js';
import { createActor } from '../../src/tools/source/create_actor.js';
import { getActorVersion } from '../../src/tools/source/get_actor_version.js';
import { buildFilesRevision, buildUrlRevision } from '../../src/tools/source/source_files.js';
import { createActorToolOutputSchema } from '../../src/tools/structured_output_schemas.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    only,
    stubToolCallContext,
    type TextToolResult,
    type ToolTelemetrySnapshot,
} from './helpers/tool_context.js';

const actorsCreateMock = vi.fn();
const buildMock = vi.fn();
const userGetMock = vi.fn();
const actorGetMock = vi.fn();
const versionGetMock = vi.fn();
const actorMock = vi.fn(() => ({ build: buildMock, get: actorGetMock, version: () => ({ get: versionGetMock }) }));

const stubClient = {
    actors: () => ({ create: actorsCreateMock }),
    actor: actorMock,
    user: () => ({ get: userGetMock }),
    baseUrl: 'https://api.example.test/v2',
} as unknown as InternalToolArgs['apifyClient'];

/** Already names the Actor, so the platform stores it unchanged. */
const ACTOR_JSON = { path: '.actor/actor.json', content: '{"actorSpecification": 1, "name": "my-actor"}' };
const DOCKERFILE = { path: 'Dockerfile', content: 'FROM apify/actor-node:20\n' };
const MAIN_JS = { path: 'src/main.js', content: 'console.log(1);\n' };

const TOOL_NAMES = Object.values(HELPER_TOOLS);

type CreateOutput = {
    actorId: string;
    fullName: string;
    versionNumber: string;
    sourceType: string;
    buildTag: string;
    revision: string;
    files: { path: string; sizeBytes: number; hash: string; format: string }[];
    warnings: string[];
    build?: Record<string, unknown>;
    buildError?: string;
};

type CreateResult = TextToolResult & { structuredContent: CreateOutput; toolTelemetry?: ToolTelemetrySnapshot };

type SentVersion = { versionNumber: string; sourceType: string; sourceFiles?: { name: string; content: string }[] };

/**
 * What the platform stores on create: `.actor/actor.json` gets `name` set to the Actor name (insertActor rewrites
 * the file when the name differs), and the response carries the stored versions.
 */
function buildStoredVersions(body: { name: string; versions: SentVersion[] }): SentVersion[] {
    return body.versions.map((version) => ({
        ...version,
        ...(version.sourceFiles && {
            sourceFiles: version.sourceFiles.map((file) => {
                if (file.name !== '.actor/actor.json') return file;
                const config = JSON.parse(file.content) as { name?: string };
                if (config.name === body.name) return file;
                return { ...file, content: JSON.stringify({ ...config, name: body.name }, null, 4) };
            }),
        }),
    }));
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
): Promise<CreateResult> {
    const context = stubToolCallContext({ name: 'my-actor', ...args }, stubClient);
    const withTools = loadedToolNames === undefined ? context : { ...context, loadedToolNames };
    const withSignal = signal === undefined ? withTools : { ...withTools, signal };
    return (await (createActor as HelperTool).call(withSignal)) as CreateResult;
}

async function callToolExpectingUserError(args: Record<string, unknown>, loadedToolNames?: string[]) {
    const result = await callTool(args, loadedToolNames);
    expectSoftFailInvalidInput(result);
    return result.content[0].text;
}

function expectNoToolNamed(text: string) {
    for (const name of TOOL_NAMES) expect(text).not.toContain(name);
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
        userGetMock.mockResolvedValue({ id: 'user-1', username: 'john' });
        buildMock.mockResolvedValue({
            id: 'build-1',
            actId: 'actor-9',
            buildNumber: '0.0.1',
            status: 'READY',
            startedAt: new Date('2026-09-01T10:00:00.000Z'),
        });
    });

    it('is a non-destructive, non-idempotent, closed-world tool without payment', () => {
        expect(createActor.name).toBe(HELPER_TOOLS.ACTOR_CREATE);
        expect(createActor.annotations).toEqual({
            title: 'Create Actor',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        });
        expect((createActor as HelperTool).paymentRequired).toBeUndefined();
    });

    it('names update-actor-version and get-actor-build in its description only when the session has them', () => {
        const { buildDescription } = createActor as HelperTool;
        const full = buildDescription?.(only(HELPER_TOOLS.ACTOR_VERSION_UPDATE, HELPER_TOOLS.ACTOR_BUILD_GET)) ?? '';
        expect(full).toBe(createActor.description);
        expect(full).toContain(`To change an existing Actor, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`);
        expect(full).toContain(`Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`);
        const bare = buildDescription?.(only()) ?? '';
        for (const name of TOOL_NAMES.filter((tool) => tool !== HELPER_TOOLS.ACTOR_CREATE)) {
            expect(bare).not.toContain(name);
        }
        expect(full).not.toMatch(/[–—]/);
    });

    it('creates the Actor and its version in one POST', async () => {
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
                    buildTag: 'latest',
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
            format: 'TEXT',
        }));
        expect(result.structuredContent).toEqual({
            actorId: 'actor-9',
            fullName: 'john/my-actor',
            versionNumber: '0.0',
            sourceType: 'SOURCE_FILES',
            buildTag: 'latest',
            revision: buildFilesRevision(files),
            files,
            warnings: [],
        });
        expect(buildMock).not.toHaveBeenCalled();
        expect(result.content[1].text).toBe(
            `Created the private Actor john/my-actor (ID actor-9) with version 0.0 from 3 files, build tag latest, revision ${buildFilesRevision(files)}.\n` +
                `The Actor has no build yet, so it cannot run until this version is built. Build it with ${HELPER_TOOLS.ACTOR_BUILD}.`,
        );
    });

    it('takes versionNumber and buildTag', async () => {
        await callTool({ versionNumber: '1.2', buildTag: 'beta', files: [ACTOR_JSON, DOCKERFILE] });
        const [body] = actorsCreateMock.mock.calls[0] as [{ versions: Record<string, unknown>[] }];
        expect(body.versions[0]).toEqual(expect.objectContaining({ versionNumber: '1.2', buildTag: 'beta' }));
    });

    it('creates a version built from Git', async () => {
        const gitRepoUrl = 'https://user:token@github.com/john/repo.git#main:actor';
        const result = await callTool({ gitRepoUrl });
        expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
        const [body] = actorsCreateMock.mock.calls[0] as [{ versions: Record<string, unknown>[] }];
        expect(body.versions).toEqual([
            { versionNumber: '0.0', buildTag: 'latest', sourceType: 'GIT_REPO', gitRepoUrl },
        ]);
        expect(result.structuredContent.revision).toBe(
            buildUrlRevision('GIT_REPO', 'https://github.com/john/repo.git#main:actor'),
        );
        expect(result.structuredContent.files).toEqual([]);
        expect(result.content[1].text).toContain('from the Git repository https://github.com/john/repo.git#main:actor');
        expect(result.content[1].text).not.toContain('token');
    });

    it('needs exactly one of files or gitRepoUrl', async () => {
        expect(await callToolExpectingUserError({})).toBe('Give exactly one of files or gitRepoUrl.');
        expect(await callToolExpectingUserError({ files: [ACTOR_JSON], gitRepoUrl: 'https://x' })).toBe(
            'Give exactly one of files or gitRepoUrl.',
        );
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it('needs .actor/actor.json', async () => {
        const text = await callToolExpectingUserError({ files: [MAIN_JS, DOCKERFILE] });
        expect(text).toContain('files must include .actor/actor.json');
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it.each([
        ['ab', 'is not valid'],
        ['-scraper', 'is not valid'],
        ['scraper-', 'is not valid'],
        ['my_scraper', 'is not valid'],
        ['a'.repeat(64), 'is not valid'],
        ['john/my-actor', 'Give the Actor name without a username, for example my-actor'],
        ['john~my-actor', 'Give the Actor name without a username, for example my-actor'],
    ])('refuses the name %j before any request', async (name, reason) => {
        const text = await callToolExpectingUserError({ name, files: [ACTOR_JSON, DOCKERFILE] });
        expect(text).toContain(reason);
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    it('accepts names of 3 and 63 characters', async () => {
        await callTool({ name: 'abc', files: [ACTOR_JSON, DOCKERFILE] });
        await callTool({ name: 'a'.repeat(63), files: [ACTOR_JSON, DOCKERFILE] });
        expect(actorsCreateMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a taken name with the full name, naming update-actor-version only when loaded', async () => {
        actorsCreateMock.mockRejectedValue(
            apiError(409, 'Some other Actor already has this name ("my-actor").', 'actor-name-not-unique'),
        );
        const text = await callToolExpectingUserError({ files: [ACTOR_JSON, DOCKERFILE] });
        expect(text).toBe(
            'Your account already has an Actor named john/my-actor, and this tool never changes an existing Actor. ' +
                `To change its source, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE} with actor john/my-actor.`,
        );
        const bare = await callToolExpectingUserError({ files: [ACTOR_JSON, DOCKERFILE] }, [HELPER_TOOLS.ACTOR_CREATE]);
        expect(bare).toContain('Pick another name, or change the existing Actor instead.');
        expectNoToolNamed(bare);
    });

    it('treats the unique-index error of a racing create as a taken name', async () => {
        actorsCreateMock.mockRejectedValue(apiError(400, 'Actor name is not unique for this user.', 'name-not-unique'));
        const text = await callToolExpectingUserError({ files: [ACTOR_JSON, DOCKERFILE] });
        expect(text).toContain('Your account already has an Actor named john/my-actor');
    });

    it('asks for username/name when users/me does not give the username', async () => {
        actorsCreateMock.mockRejectedValue(apiError(409, 'Taken', 'actor-name-not-unique'));
        userGetMock.mockRejectedValue(apiError(403, 'Forbidden'));
        const text = await callToolExpectingUserError({ files: [ACTOR_JSON, DOCKERFILE] });
        expect(text).toBe(
            'Your account already has an Actor named my-actor, and this tool never changes an existing Actor. ' +
                `To change its source, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE} with actor set to your username/name.`,
        );
    });

    it('creates nothing when the request is cancelled before the POST', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await callTool({ files: [ACTOR_JSON, DOCKERFILE] }, undefined, controller.signal);
        expect(actorsCreateMock).not.toHaveBeenCalled();
        expect(result).toEqual({});
    });

    it('refuses a session without a token before any request', async () => {
        const context = {
            ...stubToolCallContext({ name: 'my-actor', files: [ACTOR_JSON, DOCKERFILE] }, stubClient),
            apifyToken: '',
        };
        const result = (await (createActor as HelperTool).call(context)) as CreateResult;
        expect(result.isError).toBe(true);
        expect(result.toolTelemetry).toEqual(expect.objectContaining({ failureCategory: FAILURE_CATEGORY.AUTH }));
        expect(result.content[0].text).toBe('Creating an Actor needs an Apify API token, and this session has none.');
        expect(actorsCreateMock).not.toHaveBeenCalled();
    });

    describe('warnings', () => {
        it('warns when no Dockerfile is found', async () => {
            const result = await callTool({ files: [ACTOR_JSON, MAIN_JS] });
            expect(result.structuredContent.warnings).toEqual([
                "No Dockerfile found: there is no Dockerfile or .actor/Dockerfile, and .actor/actor.json names none, so the build uses the platform's default Node.js Dockerfile; an Actor in another language needs its own.",
            ]);
        });

        it.each([
            ['.actor/Dockerfile', [ACTOR_JSON, { path: '.actor/Dockerfile', content: 'FROM x\n' }]],
            ['a lowercase dockerfile', [ACTOR_JSON, { path: 'dockerfile', content: 'FROM x\n' }]],
            [
                'a dockerfile field',
                [
                    {
                        path: '.actor/actor.json',
                        content: '{"actorSpecification": 1, "name": "my-actor", "dockerfile": "../docker/Dockerfile"}',
                    },
                ],
            ],
        ])('finds a Dockerfile given as %s', async (_label, files) => {
            const result = await callTool({ files });
            expect(result.structuredContent.warnings).toEqual([]);
        });

        it('warns about empty files, which the build skips', async () => {
            const result = await callTool({
                files: [ACTOR_JSON, DOCKERFILE, { path: 'storage/.gitkeep', content: '' }],
            });
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: storage/.gitkeep.',
            ]);
            expect(result.content[1].text).toContain('These files are empty');
        });
    });

    describe('stored files', () => {
        const unnamedConfig = { path: '.actor/actor.json', content: '{"actorSpecification": 1}' };
        const storedConfig = JSON.stringify({ actorSpecification: 1, name: 'my-actor' }, null, 4);

        it('lists the actor.json the platform stored, with its name set, and warns about the rewrite', async () => {
            const result = await callTool({ files: [unnamedConfig, DOCKERFILE] });
            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            const files = [
                { path: '.actor/actor.json', content: storedConfig },
                { path: 'Dockerfile', content: DOCKERFILE.content },
            ].map(({ path, content }) => ({
                path,
                sizeBytes: content.length,
                hash: sha256Prefix(content),
                format: 'TEXT',
            }));
            expect(result.structuredContent.files).toEqual(files);
            expect(result.structuredContent.revision).toBe(buildFilesRevision(files));
            expect(result.structuredContent.warnings).toEqual([
                'The platform set the name field of .actor/actor.json to the Actor name, so the stored file differs ' +
                    'from the one sent; its hash in files, and the revision, are those of the stored file.',
            ]);
        });

        it('returns the revision and hashes a later get-actor-version read returns', async () => {
            const result = await callTool({ files: [unnamedConfig, DOCKERFILE, MAIN_JS] });
            const [body] = actorsCreateMock.mock.calls[0] as [{ name: string; versions: SentVersion[] }];
            const [storedVersion] = buildStoredVersions(body);
            actorGetMock.mockResolvedValue({
                id: 'actor-9',
                userId: 'user-1',
                name: 'my-actor',
                username: 'john',
                versions: [{ versionNumber: '0.0', sourceType: 'SOURCE_FILES', buildTag: 'latest' }],
            });
            versionGetMock.mockResolvedValue({ ...storedVersion, buildTag: 'latest', envVars: [] });
            const read = (await (getActorVersion as HelperTool).call(
                stubToolCallContext({ actor: 'john/my-actor', paths: [] }, stubClient),
            )) as { structuredContent: { revision: string; files: { path: string; hash: string }[] } };
            expect(result.structuredContent.revision).toBe(read.structuredContent.revision);
            expect(result.structuredContent.files.map(({ path, hash }) => ({ path, hash }))).toEqual(
                read.structuredContent.files.map(({ path, hash }) => ({ path, hash })),
            );
        });

        it('falls back to the sent files when the response carries no version', async () => {
            actorsCreateMock.mockResolvedValue({ id: 'actor-9', name: 'my-actor', username: 'john' });
            const result = await callTool({ files: [unnamedConfig, DOCKERFILE] });
            expect(result.structuredContent.files[0].hash).toBe(sha256Prefix(unnamedConfig.content));
            expect(result.structuredContent.warnings).toEqual([]);
        });
    });

    describe('files', () => {
        it('stores binary files as base64 and lists them by their decoded bytes', async () => {
            const bytes = Buffer.from([137, 80, 78, 71]);
            const result = await callTool({
                files: [ACTOR_JSON, DOCKERFILE, { path: 'assets/logo.png', content: bytes.toString('base64') }],
            });
            const [body] = actorsCreateMock.mock.calls[0] as [{ versions: { sourceFiles: unknown[] }[] }];
            expect(body.versions[0].sourceFiles).toContainEqual({
                name: 'assets/logo.png',
                format: 'BASE64',
                content: bytes.toString('base64'),
            });
            expect(result.structuredContent.files).toContainEqual({
                path: 'assets/logo.png',
                sizeBytes: 4,
                hash: sha256Prefix(bytes),
                format: 'BASE64',
            });
        });

        it('refuses content that is not strict base64', async () => {
            const text = await callToolExpectingUserError({
                files: [ACTOR_JSON, { path: 'logo.png', content: 'not base64!' }],
            });
            expect(text).toContain(
                'files[1] content for logo.png has encoding base64, but its content is not valid base64',
            );
        });

        it('normalizes paths and refuses duplicates', async () => {
            const text = await callToolExpectingUserError({
                files: [ACTOR_JSON, { path: './.actor//actor.json', content: '{}' }],
            });
            expect(text).toBe('files has .actor/actor.json more than once.');
        });

        it.each([
            ['/abs.js', 'is absolute'],
            ['../x.js', "has a '..' segment"],
            ['a\0b', 'contains a NUL character'],
            [`${'a'.repeat(256)}`, 'is over 255 characters'],
        ])('refuses the path %j', async (path, reason) => {
            const text = await callToolExpectingUserError({ files: [ACTOR_JSON, { path, content: 'x' }] });
            expect(text).toContain(reason);
            expect(actorsCreateMock).not.toHaveBeenCalled();
        });

        it('refuses more than 2 MiB of content, which also keeps the files within the 3 MiB inline limit', async () => {
            const text = await callToolExpectingUserError({
                files: [ACTOR_JSON, { path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024) }],
            });
            expect(text).toContain('MiB of content, over the 2 MiB one call takes.');
            expect(text).toContain(
                `Create the Actor with fewer files, then add the rest in later calls with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`,
            );
            expect(actorsCreateMock).not.toHaveBeenCalled();
            const bare = await callToolExpectingUserError(
                { files: [ACTOR_JSON, { path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024) }] },
                [HELPER_TOOLS.ACTOR_CREATE],
            );
            expect(bare).toContain('Create the Actor with fewer files, then add the rest in later calls.');
            expectNoToolNamed(bare);
        });

        it('caps files at 500 in the input schema', () => {
            const { ajvValidate } = createActor as HelperTool;
            const files = Array.from({ length: 500 }, (_, index) => ({ path: `f${index}`, content: 'x' }));
            expect(ajvValidate({ name: 'abc', files })).toBe(true);
            expect(ajvValidate({ name: 'abc', files: [...files, { path: 'extra', content: 'x' }] })).toBe(false);
        });
    });

    describe('autoBuild', () => {
        it('starts a build without waiting and points at get-actor-build only when loaded', async () => {
            const result = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] });
            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            expect(actorMock).toHaveBeenCalledWith('actor-9');
            expect(buildMock).toHaveBeenCalledWith('0.0', { useCache: true });
            expect(result.structuredContent.build).toEqual(
                expect.objectContaining({ id: 'build-1', buildNumber: '0.0.1', status: 'READY' }),
            );
            expect(result.content[1].text).toContain(`Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET}`);
            const bare = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] }, [
                HELPER_TOOLS.ACTOR_CREATE,
            ]);
            expectNoToolNamed(bare.content[1].text);
        });

        it('reports a build that failed to start with the Actor still created', async () => {
            buildMock.mockRejectedValue(apiError(403, 'Build limit reached'));
            const result = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] });
            expectSchemaConformingStructuredContent(result, createActorToolOutputSchema);
            expect(result.structuredContent.actorId).toBe('actor-9');
            expect(result.structuredContent.buildError).toBe('Build limit reached');
            expect(result.content[1].text).toContain(
                `The Actor was created, but the build could not be started: Build limit reached. Start it again with ${HELPER_TOOLS.ACTOR_BUILD}.`,
            );
            const bare = await callTool({ autoBuild: true, files: [ACTOR_JSON, DOCKERFILE] }, [
                HELPER_TOOLS.ACTOR_CREATE,
            ]);
            expect(bare.content[1].text).toContain('Start the build again to make this version runnable.');
            expectNoToolNamed(bare.content[1].text);
        });
    });

    it('returns another 4xx as the API message and rethrows a 5xx', async () => {
        actorsCreateMock.mockRejectedValueOnce(
            apiError(403, 'User cannot have more than 100 Actors.', 'too-many-actors'),
        );
        const result = await callTool({ files: [ACTOR_JSON, DOCKERFILE] });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('User cannot have more than 100 Actors.');
        actorsCreateMock.mockRejectedValueOnce(apiError(500, 'Internal'));
        await expect(callTool({ files: [ACTOR_JSON, DOCKERFILE] })).rejects.toThrow('Internal');
    });
});
