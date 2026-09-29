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
const actorMock = vi.fn(() => ({
    get: actorGetMock,
    versions: () => ({ create: versionsCreateMock }),
    build: buildMock,
}));

const stubClient = { actor: actorMock } as unknown as InternalToolArgs['apifyClient'];

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

function apiError(status: number, message: string, type = 'some-error'): ApifyApiError {
    return new ApifyApiError({ data: { error: { type, message } }, status } as AxiosResponse, 1);
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
                'Created version 0.2 of john/my-actor.\nRuns use these files once the version is built.',
            );
            expect(result.content.map(({ text }) => text).join('\n')).not.toContain(LOGO_BYTES.toString('base64'));
        });

        it('copies the non-secret env vars and applyEnvVarsToBuild, never the build tag', async () => {
            mockActorRead({ applyEnvVarsToBuild: true });

            await callTool({ copyFromVersion: '0.1' });

            const body = getPostBody();
            expect(body.envVars).toEqual([
                { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
                { name: 'REGION', value: 'eu' },
            ]);
            expect(body.applyEnvVarsToBuild).toBe(true);
            expect(body).not.toHaveProperty('buildTag');
        });

        it('refuses a version not stored as files, naming its URL without credentials', async () => {
            mockActorRead({
                sourceType: 'TARBALL',
                tarballUrl: 'https://api.example.test/v2/key-value-stores/s/records/version-0.1.zip?signature=secret',
                sourceFiles: undefined,
            });

            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toBe(
                'Version 0.1 of john/my-actor is not stored as files (source type TARBALL, ' +
                    'https://api.example.test/v2/key-value-stores/s/records/version-0.1.zip), and this tool works ' +
                    'only on versions stored as files.',
            );
        });

        it('refuses a version whose source the API hides', async () => {
            mockActorRead({ sourceFiles: undefined });

            expect(await callToolExpectingUserError({ copyFromVersion: '0.1' })).toContain(
                'Version 0.1 of john/my-actor came back without its source',
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

        it('warns about empty files, which the build skips', async () => {
            const result = await callTool({ files: [ACTOR_JSON, { path: 'src/__init__.py', content: '' }] });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(result.structuredContent.warnings).toEqual([
                'These files are empty, and the build skips empty files, so they will not exist in the build: src/__init__.py.',
            ]);
        });

        it('leaves a call with neither files nor copyFromVersion to the platform', async () => {
            await callTool({});

            expect(getPostBody()).toEqual({ versionNumber: '0.2', sourceType: 'SOURCE_FILES', sourceFiles: [] });
        });

        it('refuses both files and copyFromVersion before any request', async () => {
            expect(await callToolExpectingUserError({ copyFromVersion: '0.1', files: [ACTOR_JSON] })).toBe(
                'Give files or copyFromVersion, not both.',
            );
            expect(actorMock).not.toHaveBeenCalled();
        });
    });

    it('sends buildTag only when given', async () => {
        await callTool({ copyFromVersion: '0.1', buildTag: 'beta' });
        expect(getPostBody().buildTag).toBe('beta');
        vi.clearAllMocks();

        await callTool({ files: [ACTOR_JSON] });
        expect(getPostBody()).not.toHaveProperty('buildTag');
    });

    describe('Actor and API errors', () => {
        it('reports a missing Actor', async () => {
            actorGetMock.mockResolvedValue(undefined);

            expect(await callToolExpectingUserError({ actor: 'my-actor', files: [ACTOR_JSON] })).toBe(
                "Actor 'my-actor' not found. Give its ID or its full name, username/name; a name without the username is not enough.",
            );
        });

        it('lets an API error from the POST through unchanged, such as a version number already taken', async () => {
            const error = apiError(403, 'Version with this number already exists', 'version-already-exists');
            versionsCreateMock.mockRejectedValue(error);

            await expect(callTool({ versionNumber: '0.1', files: [ACTOR_JSON] })).rejects.toBe(error);
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
            expect(buildMock).not.toHaveBeenCalled();
        });

        it('starts no build when the request is cancelled during the POST', async () => {
            const controller = new AbortController();
            versionsCreateMock.mockImplementation(async () => controller.abort());

            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true }, controller.signal);

            expect(result).toEqual({});
            expect(versionsCreateMock).toHaveBeenCalledTimes(1);
            expect(buildMock).not.toHaveBeenCalled();
        });
    });

    describe('autoBuild', () => {
        it('starts a build without waiting', async () => {
            const result = await callTool({ copyFromVersion: '0.1', autoBuild: true });

            expectSchemaConformingStructuredContent(result, createActorVersionToolOutputSchema);
            expect(buildMock).toHaveBeenCalledWith('0.2', { useCache: true });
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
            await callTool({ copyFromVersion: '0.1' });

            expect(buildMock).not.toHaveBeenCalled();
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
