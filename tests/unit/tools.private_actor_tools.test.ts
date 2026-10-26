import type { Actor, ActorRun, ActorVersion, Build } from 'apify-client';
import { ActorSourceType } from 'apify-client';
import { describe, expect, it, vi } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import {
    buildPrivateActor,
    createPrivateActor,
    createPrivateActorVersion,
    getPrivateActorBuild,
    getPrivateActorBuildList,
    getPrivateActorBuildLog,
    getPrivateActorVersion,
    PRIVATE_ACTOR_RUN_LIMITS,
    privateActorTools,
    runOwnedActor,
    updatePrivateActorVersion,
} from '../../src/tools/actors/private_actor_tools.js';
import type { HelperTool, InternalToolArgs } from '../../src/types.js';
import {
    expectSchemaConformingStructuredContent,
    expectSoftFailInvalidInput,
    mockApifyClient,
    stubToolCallContext,
    textOf,
} from './helpers/tool_context.js';

const ACTOR_ID = 'privateActor12345';
const BUILD_ID = 'privateBuild12345';
const RUN_ID = 'privateRun1234567';
const FILE = { path: 'src/main.js', content: 'console.log("hello");' };

function actorDocument(overrides: Partial<Actor> = {}) {
    return {
        id: ACTOR_ID,
        userId: 'account-owner',
        name: 'private-scraper',
        username: 'developer',
        isPublic: false,
        versions: [
            {
                versionNumber: '0.1',
                sourceType: ActorSourceType.SourceFiles,
                buildTag: 'latest',
                sourceFiles: [{ name: FILE.path, content: FILE.content, format: 'TEXT' }],
            },
        ],
        ...overrides,
    } satisfies Partial<Actor>;
}

function buildDocument(overrides: Partial<Build> = {}) {
    return {
        id: BUILD_ID,
        actId: ACTOR_ID,
        buildNumber: '0.1.12',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-10-25T10:00:00Z'),
        finishedAt: new Date('2026-10-25T10:01:00Z'),
        ...overrides,
    } satisfies Partial<Build>;
}

function runDocument(overrides: Partial<ActorRun> = {}) {
    return {
        id: RUN_ID,
        actId: ACTOR_ID,
        buildId: BUILD_ID,
        status: 'RUNNING',
        startedAt: new Date('2026-10-25T10:02:00Z'),
        ...overrides,
    } satisfies Partial<ActorRun>;
}

/** Fresh API fake per test; every non-API helper and tool handler remains real. */
function privateApi() {
    const actorGet = vi.fn().mockResolvedValue(actorDocument());
    const buildGet = vi.fn().mockResolvedValue(buildDocument());
    const sourceUpdate = vi.fn().mockResolvedValue({});
    const versionCreate = vi.fn().mockImplementation(async (version: ActorVersion) => version);
    const actorCreate = vi.fn().mockImplementation(async (options: Partial<Actor>) => actorDocument(options));
    // The API can return a running build, although the installed client types list only terminal statuses.
    const buildStart = vi.fn().mockResolvedValue({ ...buildDocument(), status: 'RUNNING', finishedAt: undefined });
    const buildList = vi
        .fn()
        .mockResolvedValue({ total: 1, count: 1, offset: 0, limit: 10, desc: true, items: [buildDocument()] });
    const logGet = vi.fn().mockResolvedValue('Compiling source\nBuild succeeded\n');
    const runStart = vi.fn().mockResolvedValue(runDocument());
    const runGet = vi.fn().mockResolvedValue(runDocument());
    const runWait = vi
        .fn()
        .mockResolvedValue(runDocument({ status: 'SUCCEEDED', finishedAt: new Date('2026-10-25T10:03:00Z') }));
    const runAbort = vi.fn().mockResolvedValue(runDocument({ status: 'ABORTED' }));
    const userGet = vi.fn().mockResolvedValue({ id: 'account-owner' });
    const actor = vi.fn(() => ({
        get: actorGet,
        version: vi.fn(() => ({ update: sourceUpdate })),
        versions: vi.fn(() => ({ create: versionCreate })),
        build: buildStart,
        builds: vi.fn(() => ({ list: buildList })),
        start: runStart,
    }));
    const client = mockApifyClient({
        actor,
        actors: vi.fn(() => ({ create: actorCreate })),
        build: vi.fn(() => ({ get: buildGet, log: vi.fn(() => ({ get: logGet })) })),
        run: vi.fn(() => ({ get: runGet, waitForFinish: runWait, abort: runAbort })),
        user: vi.fn(() => ({ get: userGet })),
    });
    const call = (tool: HelperTool, args: Record<string, unknown>, options: Partial<InternalToolArgs> = {}) =>
        tool.call({
            ...stubToolCallContext(args, client, { loadedToolNames: privateActorTools.map(({ name }) => name) }),
            ...options,
        });
    return {
        client,
        call,
        actor,
        actorGet,
        actorCreate,
        sourceUpdate,
        versionCreate,
        buildGet,
        buildStart,
        buildList,
        logGet,
        runStart,
        runGet,
        runWait,
        runAbort,
        userGet,
    };
}

describe('private development argument boundaries', () => {
    it.each(
        [
            [createPrivateActor, { name: 'private-scraper', files: [FILE], autoBuild: true }],
            [createPrivateActor, { name: 'private-scraper', files: [{ ...FILE, envVars: [] }] }],
            [
                createPrivateActorVersion,
                { actor: ACTOR_ID, versionNumber: '0.2', files: [FILE], copyFromVersion: '0.1' },
            ],
            [updatePrivateActorVersion, { actor: ACTOR_ID, operations: [{ type: 'write', ...FILE, webhooks: [] }] }],
            [buildPrivateActor, { actor: ACTOR_ID, versionNumber: '0.1', tag: 'latest' }],
            [
                runOwnedActor,
                { actor: ACTOR_ID, buildId: BUILD_ID, input: {}, forcePermissionLevel: 'FULL_PERMISSIONS' },
            ],
        ].map(([tool, args]) => ({
            tool: tool as HelperTool,
            args: args as Record<string, unknown>,
            name: (tool as HelperTool).name,
        })),
    )('rejects excluded fields in $name without stripping them', async ({ tool, args }) => {
        const api = privateApi();
        const original = structuredClone(args);
        expect(tool.ajvValidate(args)).toBe(false);
        expectSoftFailInvalidInput(await api.call(tool, args));
        expect(args).toEqual(original);
        expect(api.userGet).not.toHaveBeenCalled();
    });

    it('requires an explicit build version and actor-scoped build listing', () => {
        expect(buildPrivateActor.ajvValidate({ actor: ACTOR_ID })).toBe(false);
        expect(getPrivateActorBuildList.ajvValidate({})).toBe(false);
        expect(getPrivateActorBuildLog.ajvValidate({ buildId: BUILD_ID, lines: 0 })).toBe(false);
        expect(createPrivateActorVersion.ajvValidate({ actor: ACTOR_ID, versionNumber: '0.2' })).toBe(false);
    });

    it.each([
        { timeoutSecs: 0 },
        { timeoutSecs: PRIVATE_ACTOR_RUN_LIMITS.timeoutSecs.max + 1 },
        { memoryMbytes: PRIVATE_ACTOR_RUN_LIMITS.memoryMbytes.max * 2 },
        { maxTotalChargeUsd: PRIVATE_ACTOR_RUN_LIMITS.maxTotalChargeUsd.max + 1 },
        { waitSecs: PRIVATE_ACTOR_RUN_LIMITS.waitSecs.max + 1 },
    ])('rejects invalid run resource limits %j', (overrides) => {
        expect(runOwnedActor.ajvValidate({ actor: ACTOR_ID, buildId: BUILD_ID, input: {}, ...overrides })).toBe(false);
    });

    it('redacts nested and excluded arguments even before validation', () => {
        for (const tool of privateActorTools) {
            const redacted = tool.redactArgs?.({
                actor: { token: 'secret-account-token' },
                buildId: { token: 'secret-build-token' },
                input: { token: 'secret-input-token' },
                files: [{ path: FILE.path, content: 'secret-source-token' }],
                operations: [{ type: 'write', ...FILE, content: 'secret-edit-token' }],
                webhook: 'secret-webhook-token',
            });
            expect(JSON.stringify(redacted)).not.toContain('secret-');
        }
    });
});

describe('private Actor ownership and source writes', () => {
    it.each([{ userId: 'another-account' }, { isPublic: true }, { isPublic: undefined }])(
        'rejects an Actor outside the private owner boundary %j',
        async (overrides) => {
            const api = privateApi();
            api.actorGet.mockResolvedValue(actorDocument(overrides));
            expectSoftFailInvalidInput(
                await api.call(createPrivateActorVersion, { actor: ACTOR_ID, versionNumber: '0.2', files: [FILE] }),
            );
            expect(api.versionCreate).not.toHaveBeenCalled();
        },
    );

    it('requires an authenticated account before creating source', async () => {
        const api = privateApi();
        expectSoftFailInvalidInput(
            await api.call(createPrivateActor, { name: 'private-scraper', files: [FILE] }, { apifyToken: undefined }),
        );
        expect(api.actorCreate).not.toHaveBeenCalled();
        expect(api.userGet).not.toHaveBeenCalled();
    });

    it('forces private creation with limited permissions and never builds', async () => {
        const api = privateApi();
        const result = await api.call(createPrivateActor, { name: 'private-scraper', files: [FILE] });
        expect(api.actorCreate).toHaveBeenCalledWith(
            expect.objectContaining({ isPublic: false, actorPermissionLevel: 'LIMITED_PERMISSIONS' }),
        );
        expect(api.buildStart).not.toHaveBeenCalled();
        expectSchemaConformingStructuredContent(result, createPrivateActor.outputSchema!);
    });

    it('pins a resolved name to the immutable Actor ID and retains source hashes for updates', async () => {
        const api = privateApi();
        const read = await api.call(getPrivateActorVersion, { actor: 'developer/private-scraper' });
        const { revision, files } = read.structuredContent as {
            revision: string;
            files: { path: string; hash: string }[];
        };
        const result = await api.call(updatePrivateActorVersion, {
            actor: 'developer/private-scraper',
            expectedRevision: revision,
            operations: [
                { type: 'write', path: FILE.path, content: 'console.log("updated");', expectedHash: files[0].hash },
            ],
        });
        expect(api.actor).toHaveBeenCalledWith(ACTOR_ID);
        expect(api.sourceUpdate).toHaveBeenCalledWith({
            sourceType: ActorSourceType.SourceFiles,
            sourceFiles: [{ name: FILE.path, content: 'console.log("updated");', format: 'TEXT' }],
        });
        expect(api.buildStart).not.toHaveBeenCalled();
        expectSchemaConformingStructuredContent(result, updatePrivateActorVersion.outputSchema!);
    });

    it('retains the source revision precondition and writes nothing on conflict', async () => {
        const api = privateApi();
        const result = await api.call(updatePrivateActorVersion, {
            actor: ACTOR_ID,
            expectedRevision: 'stale-revision',
            operations: [{ type: 'write', path: 'src/new.js', content: 'x' }],
        });
        expectSoftFailInvalidInput(result);
        expect(api.sourceUpdate).not.toHaveBeenCalled();
    });

    it('rechecks privacy immediately before a source write and reports a definite refusal', async () => {
        const api = privateApi();
        api.actorGet
            .mockResolvedValueOnce(actorDocument())
            .mockResolvedValueOnce(actorDocument())
            .mockResolvedValue(actorDocument({ isPublic: true }));
        const result = await api.call(updatePrivateActorVersion, {
            actor: ACTOR_ID,
            operations: [{ type: 'write', path: 'src/new.js', content: 'x' }],
        });
        expectSoftFailInvalidInput(result);
        expect(result.content?.map(textOf).join('')).not.toContain('may still have saved');
        expect(api.sourceUpdate).not.toHaveBeenCalled();
    });

    it('creates a files-only version without copying environment variables or starting a build', async () => {
        const api = privateApi();
        const result = await api.call(createPrivateActorVersion, {
            actor: ACTOR_ID,
            versionNumber: '0.2',
            files: [FILE],
        });
        expect(api.versionCreate).toHaveBeenCalledWith({
            versionNumber: '0.2',
            sourceType: ActorSourceType.SourceFiles,
            sourceFiles: [{ name: FILE.path, content: FILE.content, format: 'TEXT' }],
        });
        expect(api.buildStart).not.toHaveBeenCalled();
        expectSchemaConformingStructuredContent(result, createPrivateActorVersion.outputSchema!);
    });

    it('does not write if cancellation arrives during the last authorization read', async () => {
        const api = privateApi();
        const controller = new AbortController();
        api.actorGet
            .mockResolvedValueOnce(actorDocument())
            .mockResolvedValueOnce(actorDocument())
            .mockImplementationOnce(async () => {
                controller.abort();
                return actorDocument();
            });
        await api.call(
            updatePrivateActorVersion,
            {
                actor: ACTOR_ID,
                operations: [{ type: 'write', path: 'src/new.js', content: 'x' }],
            },
            { signal: controller.signal },
        );
        expect(api.sourceUpdate).not.toHaveBeenCalled();
    });
});

describe('private build access', () => {
    it('builds only the selected private version with bounded waiting', async () => {
        const api = privateApi();
        const result = await api.call(buildPrivateActor, { actor: ACTOR_ID, versionNumber: '0.1', waitSecs: 0 });
        expect(api.buildStart).toHaveBeenCalledWith('0.1', { useCache: true });
        expectSchemaConformingStructuredContent(result, buildPrivateActor.outputSchema!);
    });

    it('gets a build only after checking its Actor ownership', async () => {
        const api = privateApi();
        const result = await api.call(getPrivateActorBuild, { buildId: BUILD_ID, waitSecs: 0 });
        expect(api.actor).toHaveBeenCalledWith(ACTOR_ID);
        expectSchemaConformingStructuredContent(result, getPrivateActorBuild.outputSchema!);
    });

    it('lists builds only for the required Actor', async () => {
        const api = privateApi();
        const result = await api.call(getPrivateActorBuildList, { actorId: ACTOR_ID });
        expect(api.buildList).toHaveBeenCalledWith({ offset: 0, limit: 10, desc: true });
        expectSchemaConformingStructuredContent(result, getPrivateActorBuildList.outputSchema!);
    });

    it('refuses cross-Actor results from the build list', async () => {
        const api = privateApi();
        api.buildList.mockResolvedValue({
            total: 1,
            count: 1,
            offset: 0,
            limit: 10,
            desc: true,
            items: [buildDocument({ actId: 'another-actor' })],
        });
        expectSoftFailInvalidInput(await api.call(getPrivateActorBuildList, { actorId: ACTOR_ID }));
    });

    it('refuses a public Actor build before fetching its log', async () => {
        const api = privateApi();
        api.actorGet.mockResolvedValue(actorDocument({ isPublic: true }));
        expectSoftFailInvalidInput(await api.call(getPrivateActorBuildLog, { buildId: BUILD_ID }));
        expect(api.logGet).not.toHaveBeenCalled();
    });

    it('bounds even a single long build log line', async () => {
        const api = privateApi();
        api.logGet.mockResolvedValue('x'.repeat(300 * 1024));
        const result = await api.call(getPrivateActorBuildLog, { buildId: BUILD_ID, lines: 50 });
        expect(Buffer.byteLength((result.structuredContent as { log: string }).log)).toBeLessThanOrEqual(256 * 1024);
        expectSchemaConformingStructuredContent(result, getPrivateActorBuildLog.outputSchema!);
    });
});

describe('running an exact private build', () => {
    const runArgs = { actor: ACTOR_ID, buildId: BUILD_ID, input: { startUrls: ['https://example.com'] }, waitSecs: 0 };

    it.each([{ actId: 'another-actor' }, { status: 'FAILED' }, { buildNumber: 'latest' }] satisfies Partial<Build>[])(
        'rejects an unsuitable build %j before starting',
        async (overrides) => {
            const api = privateApi();
            api.buildGet.mockResolvedValue(buildDocument(overrides));
            expectSoftFailInvalidInput(await api.call(runOwnedActor, runArgs));
            expect(api.runStart).not.toHaveBeenCalled();
        },
    );

    it('starts the exact build with forced limited permissions and server resource defaults', async () => {
        const api = privateApi();
        const result = await api.call(runOwnedActor, runArgs);
        expect(api.runStart).toHaveBeenCalledWith(runArgs.input, {
            build: '0.1.12',
            forcePermissionLevel: 'LIMITED_PERMISSIONS',
            timeout: PRIVATE_ACTOR_RUN_LIMITS.timeoutSecs.default,
            memory: PRIVATE_ACTOR_RUN_LIMITS.memoryMbytes.default,
            maxTotalChargeUsd: PRIVATE_ACTOR_RUN_LIMITS.maxTotalChargeUsd.default,
            restartOnError: false,
        });
        expectSchemaConformingStructuredContent(result, runOwnedActor.outputSchema!);
        expect((result.structuredContent as { nextStep: string }).nextStep).not.toContain(HELPER_TOOLS.ACTOR_RUNS_GET);
    });

    it('rechecks privacy immediately before starting the run', async () => {
        const api = privateApi();
        api.actorGet
            .mockResolvedValueOnce(actorDocument())
            .mockResolvedValueOnce(actorDocument())
            .mockResolvedValue(actorDocument({ isPublic: true }));
        expectSoftFailInvalidInput(await api.call(runOwnedActor, runArgs));
        expect(api.runStart).not.toHaveBeenCalled();
    });

    it('aborts a returned run that used a different build', async () => {
        const api = privateApi();
        api.runStart.mockResolvedValue(runDocument({ buildId: 'different-build' }));
        expectSoftFailInvalidInput(await api.call(runOwnedActor, runArgs));
        expect(api.runAbort).toHaveBeenCalledWith({ gracefully: false });
        expect(api.runGet).not.toHaveBeenCalled();
    });

    it('waits for the requested bounded period and returns the run response schema', async () => {
        const api = privateApi();
        const result = await api.call(runOwnedActor, { ...runArgs, waitSecs: 1 });
        expect(api.runWait).toHaveBeenCalledWith({ waitSecs: 1 });
        expectSchemaConformingStructuredContent(result, runOwnedActor.outputSchema!);
    });

    it('does not start an already cancelled request', async () => {
        const api = privateApi();
        await api.call(runOwnedActor, runArgs, { signal: AbortSignal.abort() });
        expect(api.runStart).not.toHaveBeenCalled();
        expect(api.userGet).not.toHaveBeenCalled();
    });

    it('aborts the run if cancellation arrives while the platform starts it', async () => {
        const api = privateApi();
        const controller = new AbortController();
        api.runStart.mockImplementation(async () => {
            controller.abort();
            return runDocument();
        });
        await api.call(runOwnedActor, runArgs, { signal: controller.signal });
        expect(api.runAbort).toHaveBeenCalledWith({ gracefully: false });
        expect(api.runGet).not.toHaveBeenCalled();
    });
});
