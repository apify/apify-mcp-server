import { createHash } from 'node:crypto';

import type { ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType } from 'apify-client';
import { expect } from 'vitest';

import type { ApifyClient } from '@apify/actors-mcp-server/internals.js';

import { validateStructuredOutputForTool, withClient } from '../helpers.js';
import type { Case, SuiteClient } from '../types.js';

/**
 * create-actor, create-actor-version, update-actor-version, and delete-actor-version against the live API. Each case
 * reads what the platform stored with the raw client, so it checks the stored source, not only what the tool reported.
 *
 * Names are `test-source-<random>-<purpose>`, never `eval-`, so the eval harness's `eval-*` sweep on the same account
 * never deletes an Actor mid-case. No case sets autoBuild, since builds cost time and money. Every case deletes its
 * Actor by name in `finally`, so an Actor a failed call left behind goes too; apify-client swallows the 404 when there
 * is none.
 *
 * Tool names are hardcoded, not read from `HELPER_TOOLS`, so a rename fails these tests (CONTRIBUTING.md).
 */

/** A 1x1 PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Bytes that are not UTF-8, so the tools return them as base64 whatever the path. */
const NON_UTF8_BYTES = Buffer.from([0x00, 0xff, 0x80, 0x0a]);

/** Well-formed as a hash or a revision, and matching none in these cases. */
const WRONG_HASH = '0000000000000000';

type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };

type FileListingInfo = { path: string; sizeBytes: number; hash: string };

type GetActorVersionResult = {
    actorId: string;
    fullName: string;
    versionNumber: string;
    revision: string;
    files: FileListingInfo[];
    contents: { path: string; content: string; encoding: string }[];
};

type CreateActorResult = Omit<GetActorVersionResult, 'contents'>;

type UpdateActorVersionResult = {
    revision: string;
    changed: boolean;
    changes: { path: string; action: string; hash?: string }[];
};

/** A stored entry: a file, or a `{ name, folder: true }` folder that Console keeps, which apify-client's type leaves out. */
type StoredSourceFile = ActorVersionSourceFile & { folder?: boolean };

/** A version as the API returns it to the owner, with every field it has. */
type StoredVersionInfo = Record<string, unknown> & { versionNumber: string; sourceFiles?: StoredSourceFile[] };

type StoredActorInfo = {
    id: string;
    username: string;
    name: string;
    title?: string;
    description?: string;
    isPublic: boolean;
    modifiedAt: Date;
    versions: StoredVersionInfo[];
};

/** Unique per call: three transport dimensions register each case, and CI runs PRs concurrently in one account. */
function buildUniqueActorName(purpose: string): string {
    return `test-source-${Math.random().toString(36).slice(2, 8)}-${purpose}`;
}

/**
 * The `username~name` selector of the Actor this account gets under `name`, resolved before the Actor exists, so the
 * cleanup works even when the call that creates the Actor fails after the platform stored it.
 */
async function fetchOwnActorSelector(api: ApifyClient, name: string): Promise<string> {
    const { username } = await api.user().get();
    return `${username}~${name}`;
}

/** The hash the source tools list: the first 16 hex characters of the SHA-256 of the bytes. */
function getFileHash(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** The listing entry get-actor-version gives a file with these bytes; a string counts as its UTF-8 bytes. */
function buildFileListing(path: string, data: Buffer | string): FileListingInfo {
    const bytes = Buffer.from(data);
    return { path, sizeBytes: bytes.length, hash: getFileHash(bytes) };
}

async function callTool(client: SuiteClient, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

/**
 * Fails the case on a tool error, checks the result against the tool's output schema and against its JSON text, which
 * a client that reads only the text gets, and returns the structured content.
 */
function expectToolSuccess<T>(result: ToolCallResult, toolName: string): T {
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    validateStructuredOutputForTool(result, toolName, 'default');
    expect(JSON.parse(result.content?.[0]?.text ?? 'null')).toEqual(result.structuredContent);
    return result.structuredContent as T;
}

/** The one text of a failed call, which carries no structured content. */
function expectToolFailure(result: ToolCallResult): string {
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    return result.content?.[0]?.text ?? '';
}

async function fetchStoredActor(api: ApifyClient, actorSelector: string): Promise<StoredActorInfo> {
    const actor = await api.actor(actorSelector).get();
    expect(actor, `Actor ${actorSelector}`).toBeDefined();
    return actor as unknown as StoredActorInfo;
}

/** What a call that writes nothing leaves as it was: the versions, and modifiedAt, which every version write sets. */
function extractWrittenState({ modifiedAt, versions }: StoredActorInfo) {
    return { modifiedAt, versions };
}

/** The stored version with this number; fails the case when there is none. */
function findStoredVersion(actor: StoredActorInfo, versionNumber: string): StoredVersionInfo {
    const version = actor.versions.find((candidate) => candidate.versionNumber === versionNumber);
    expect(version, `version ${versionNumber}`).toBeDefined();
    return version as StoredVersionInfo;
}

/** The stored entries sorted by name; the order the platform keeps them in is not part of the contract. */
function extractSortedSourceFiles(version: StoredVersionInfo): StoredSourceFile[] {
    return [...(version.sourceFiles ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function fetchBuildCount(api: ApifyClient, actorId: string): Promise<number> {
    const { total } = await api.actor(actorId).builds().list();
    return total;
}

export const sourceCases: Case[] = [
    {
        name: 'create-actor creates a private Actor whose stored files get-actor-version reads back with the same hashes and revision',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('create');
            const selector = await fetchOwnActorSelector(api, name);
            // No name, which the platform adds, so the stored file differs from the one sent.
            const actorJson = '{\n    "actorSpecification": 1,\n    "version": "0.0"\n}\n';
            const mainJs = 'import { greet } from "./lib/greet.js";\n\nconsole.log(greet("Grüße 🌍"));\n';
            const greetJs = 'export const greet = (who) => "Hello, " + who;\n';
            try {
                const createResult = await callTool(client, 'create-actor', {
                    name,
                    title: 'Source tools test',
                    description: 'Created by an integration test of create-actor.',
                    files: [
                        { path: '.actor/actor.json', content: actorJson },
                        { path: 'src/main.js', content: mainJs },
                        { path: 'src/lib/greet.js', content: greetJs },
                        // Binary by its extension, so base64 without an encoding.
                        { path: 'assets/logo.png', content: PNG_BASE64 },
                        { path: 'assets/raw-bytes', content: NON_UTF8_BYTES.toString('base64'), encoding: 'base64' },
                    ],
                });
                const created = expectToolSuccess<CreateActorResult>(createResult, 'create-actor');
                const stored = await fetchStoredActor(api, selector);
                const fullName = `${stored.username}/${name}`;

                expect(stored).toMatchObject({
                    id: created.actorId,
                    name,
                    title: 'Source tools test',
                    description: 'Created by an integration test of create-actor.',
                    isPublic: false,
                });
                expect(stored.versions).toHaveLength(1);
                expect(stored.versions[0]).toMatchObject({
                    versionNumber: '0.0',
                    buildTag: 'latest',
                    sourceType: 'SOURCE_FILES',
                    envVars: [],
                });

                const storedFiles = extractSortedSourceFiles(stored.versions[0]);
                const storedActorJson = storedFiles[0].content;
                expect(JSON.parse(storedActorJson)).toEqual({ actorSpecification: 1, version: '0.0', name });
                expect(storedFiles).toEqual([
                    { name: '.actor/actor.json', format: 'TEXT', content: storedActorJson },
                    { name: 'assets/logo.png', format: 'BASE64', content: PNG_BASE64 },
                    { name: 'assets/raw-bytes', format: 'BASE64', content: NON_UTF8_BYTES.toString('base64') },
                    { name: 'src/lib/greet.js', format: 'TEXT', content: greetJs },
                    { name: 'src/main.js', format: 'TEXT', content: mainJs },
                ]);

                // The listing has the stored bytes of actor.json, not the bytes sent.
                const expectedFiles = [
                    buildFileListing('.actor/actor.json', storedActorJson),
                    buildFileListing('assets/logo.png', Buffer.from(PNG_BASE64, 'base64')),
                    buildFileListing('assets/raw-bytes', NON_UTF8_BYTES),
                    buildFileListing('src/lib/greet.js', greetJs),
                    buildFileListing('src/main.js', mainJs),
                ];
                expect(expectedFiles[0].hash).not.toBe(getFileHash(actorJson));
                expect(created).toEqual({
                    actorId: stored.id,
                    fullName,
                    versionNumber: '0.0',
                    revision: expect.stringMatching(/^[0-9a-f]{16}$/),
                    files: expectedFiles,
                });
                expect(createResult.content?.[1]?.text).toBe(
                    `Created the private Actor ${fullName}.\nBuild the version before running it.`,
                );

                const read = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', {
                        actor: created.actorId,
                        paths: expectedFiles.map(({ path }) => path),
                    }),
                    'get-actor-version',
                );

                expect(read).toEqual({
                    actorId: created.actorId,
                    fullName,
                    versionNumber: '0.0',
                    revision: created.revision,
                    files: created.files,
                    contents: [
                        { path: '.actor/actor.json', content: storedActorJson, encoding: 'utf8' },
                        { path: 'assets/logo.png', content: PNG_BASE64, encoding: 'base64' },
                        { path: 'assets/raw-bytes', content: NON_UTF8_BYTES.toString('base64'), encoding: 'base64' },
                        { path: 'src/lib/greet.js', content: greetJs, encoding: 'utf8' },
                        { path: 'src/main.js', content: mainJs, encoding: 'utf8' },
                    ],
                });
                // autoBuild defaults to false.
                expect(await fetchBuildCount(api, created.actorId)).toBe(0);
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: 'update-actor-version creates, replaces, edits, and deletes files in one call and leaves the other files, env vars, and build tag as they were',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('update');
            const selector = await fetchOwnActorSelector(api, name);
            const readme = '# Source tools test\n';
            const utilJs = 'export const double = (value) => value * 2;\n';
            const mainTs = 'export const greeting = "one";\n';
            const oldJs = 'export const removed = true;\n';
            const zJs = 'z();\n';
            const newJs = 'export const added = true;\n';
            const newReadme = '# Source tools test\n\nReplaced by update-actor-version.\n';
            const editedMainTs = 'export const greeting = "two";\n';
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            buildTag: 'beta',
                            sourceType: ActorSourceType.SourceFiles,
                            envVars: [
                                { name: 'MODE', value: 'test' },
                                { name: 'SECRET_MODE', value: 'hidden', isSecret: true },
                            ],
                            sourceFiles: [
                                { name: 'README.md', format: 'TEXT', content: readme },
                                { name: 'assets/logo.png', format: 'BASE64', content: PNG_BASE64 },
                                { name: 'src/lib/util.js', format: 'TEXT', content: utilJs },
                                // UTF-8 text stored as BASE64, as `apify push` stores a .ts file.
                                {
                                    name: 'src/main.ts',
                                    format: 'BASE64',
                                    content: Buffer.from(mainTs).toString('base64'),
                                },
                                { name: 'src/old.js', format: 'TEXT', content: oldJs },
                                // No format, which the build worker reads as TEXT, and no content, which it reads as
                                // empty; the casts drop what apify-client's type requires.
                                { name: 'src/z.js', content: zJs } as ActorVersionSourceFile,
                                { name: 'src/blank.js', format: 'TEXT' } as ActorVersionSourceFile,
                                // An empty folder as Console keeps it; the cast adds what apify-client's type leaves out.
                                { name: 'storage', folder: true } as unknown as ActorVersionSourceFile,
                            ],
                        },
                    ],
                });
                const fullName = `${seeded.username}/${name}`;
                // The selector with a slash, which apify-client turns into the API's tilde.
                const actorArg = selector.replace('~', '/');

                const before = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', { actor: actorArg, paths: ['src/main.ts'] }),
                    'get-actor-version',
                );
                expect(before.files).toEqual([
                    buildFileListing('README.md', readme),
                    buildFileListing('assets/logo.png', Buffer.from(PNG_BASE64, 'base64')),
                    buildFileListing('src/blank.js', ''),
                    buildFileListing('src/lib/util.js', utilJs),
                    buildFileListing('src/main.ts', mainTs),
                    buildFileListing('src/old.js', oldJs),
                    buildFileListing('src/z.js', zJs),
                ]);
                expect(before.contents).toEqual([{ path: 'src/main.ts', content: mainTs, encoding: 'utf8' }]);
                const storedBefore = await fetchStoredActor(api, seeded.id);
                expect(storedBefore.versions[0].envVars).toEqual([
                    expect.objectContaining({ name: 'MODE', value: 'test' }),
                    expect.objectContaining({ name: 'SECRET_MODE', isSecret: true }),
                ]);

                const hashesBefore = new Map(before.files.map(({ path, hash }) => [path, hash]));
                const updateArgs = {
                    actor: actorArg,
                    expectedRevision: before.revision,
                    operations: [
                        { type: 'write', path: 'src/new.js', content: newJs },
                        {
                            type: 'write',
                            path: 'README.md',
                            content: newReadme,
                            expectedHash: hashesBefore.get('README.md'),
                        },
                        { type: 'edit', path: 'src/main.ts', edits: [{ oldText: '"one"', newText: '"two"' }] },
                        { type: 'delete', path: 'src/old.js', expectedHash: hashesBefore.get('src/old.js') },
                    ],
                };
                const updateResult = await callTool(client, 'update-actor-version', updateArgs);
                const updated = expectToolSuccess<UpdateActorVersionResult>(updateResult, 'update-actor-version');
                const after = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', {
                        actor: actorArg,
                        paths: ['src/main.ts', 'src/new.js'],
                    }),
                    'get-actor-version',
                );

                // The revision update-actor-version reported is the one the next read gets.
                expect(updated).toEqual({
                    revision: after.revision,
                    changed: true,
                    changes: [
                        { path: 'README.md', action: 'updated', hash: getFileHash(newReadme) },
                        { path: 'src/main.ts', action: 'updated', hash: getFileHash(editedMainTs) },
                        { path: 'src/new.js', action: 'created', hash: getFileHash(newJs) },
                        { path: 'src/old.js', action: 'deleted' },
                    ],
                });
                expect(updated.revision).not.toBe(before.revision);
                expect(updateResult.content?.[1]?.text).toBe(
                    `Updated version 0.0 of ${fullName}.\nBuild the version before running it.`,
                );
                expect(after.files).toEqual([
                    buildFileListing('README.md', newReadme),
                    buildFileListing('assets/logo.png', Buffer.from(PNG_BASE64, 'base64')),
                    buildFileListing('src/blank.js', ''),
                    buildFileListing('src/lib/util.js', utilJs),
                    buildFileListing('src/main.ts', editedMainTs),
                    buildFileListing('src/new.js', newJs),
                    buildFileListing('src/z.js', zJs),
                ]);
                expect(after.contents).toEqual([
                    { path: 'src/main.ts', content: editedMainTs, encoding: 'utf8' },
                    { path: 'src/new.js', content: newJs, encoding: 'utf8' },
                ]);

                // Untouched entries, the folder and the ones without format or content included, are stored as they
                // were; the edited file stays BASE64.
                const storedAfter = await fetchStoredActor(api, seeded.id);
                const entriesBefore = new Map(
                    extractSortedSourceFiles(storedBefore.versions[0]).map((entry) => [entry.name, entry]),
                );
                expect(entriesBefore.get('storage')).toMatchObject({ name: 'storage', folder: true });
                expect(entriesBefore.get('src/z.js')).toEqual({ name: 'src/z.js', content: zJs });
                expect(entriesBefore.get('src/blank.js')).toEqual({ name: 'src/blank.js', format: 'TEXT' });
                expect(extractSortedSourceFiles(storedAfter.versions[0])).toEqual([
                    expect.objectContaining({ name: 'README.md', format: 'TEXT', content: newReadme }),
                    entriesBefore.get('assets/logo.png'),
                    entriesBefore.get('src/blank.js'),
                    entriesBefore.get('src/lib/util.js'),
                    expect.objectContaining({
                        name: 'src/main.ts',
                        format: 'BASE64',
                        content: Buffer.from(editedMainTs).toString('base64'),
                    }),
                    expect.objectContaining({ name: 'src/new.js', format: 'TEXT', content: newJs }),
                    entriesBefore.get('src/z.js'),
                    entriesBefore.get('storage'),
                ]);
                // Every other field of the version, env vars and build tag included, is unchanged.
                expect({ ...storedAfter.versions[0], sourceFiles: undefined }).toEqual({
                    ...storedBefore.versions[0],
                    sourceFiles: undefined,
                });
                expect(storedAfter.versions[0].buildTag).toBe('beta');

                // A retry of the same call fails on expectedRevision instead of applying the operations twice.
                const retryText = expectToolFailure(await callTool(client, 'update-actor-version', updateArgs));
                expect(retryText).toBe(
                    'Nothing was written: expectedRevision failed with REVISION_MISMATCH. ' +
                        `The version's revision is ${updated.revision}, not ${before.revision}.`,
                );
                expect(extractWrittenState(await fetchStoredActor(api, seeded.id))).toEqual(
                    extractWrittenState(storedAfter),
                );
                expect(await fetchBuildCount(api, seeded.id)).toBe(0);
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: 'update-actor-version fails a write, an edit, or a revision that does not match with its reason code and writes nothing',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('conflicts');
            const selector = await fetchOwnActorSelector(api, name);
            const mainJs = 'console.log("one");\n';
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            sourceType: ActorSourceType.SourceFiles,
                            sourceFiles: [
                                { name: 'README.md', format: 'TEXT', content: '# Conflicts\n' },
                                { name: 'src/main.js', format: 'TEXT', content: mainJs },
                            ],
                        },
                    ],
                });
                const listing = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', { actor: seeded.id }),
                    'get-actor-version',
                );
                const mainHash = getFileHash(mainJs);
                expect(listing.files.find(({ path }) => path === 'src/main.js')?.hash).toBe(mainHash);
                const storedBefore = extractWrittenState(await fetchStoredActor(api, seeded.id));
                // Each failing operation follows a write that succeeds alone, which must not be saved either.
                const addFile = { type: 'write', path: 'src/added.js', content: 'export {};\n' };
                const conflicts = [
                    {
                        operations: [addFile, { type: 'write', path: 'src/main.js', content: 'console.log("x");\n' }],
                        text:
                            'Nothing was written: operations[1] (write src/main.js) failed with FILE_EXISTS. ' +
                            `src/main.js exists with hash ${mainHash}; pass that as expectedHash to replace it.`,
                    },
                    {
                        operations: [
                            addFile,
                            {
                                type: 'write',
                                path: 'src/main.js',
                                content: 'console.log("x");\n',
                                expectedHash: WRONG_HASH,
                            },
                        ],
                        text:
                            'Nothing was written: operations[1] (write src/main.js) failed with HASH_MISMATCH. ' +
                            `src/main.js has hash ${mainHash}, not ${WRONG_HASH}.`,
                    },
                    {
                        // The second edit runs on the text the first left, which no longer has "one".
                        operations: [
                            addFile,
                            {
                                type: 'edit',
                                path: 'src/main.js',
                                edits: [
                                    { oldText: '"one"', newText: '"two"' },
                                    { oldText: '"one"', newText: '"three"' },
                                ],
                            },
                        ],
                        text:
                            'Nothing was written: operations[1] (edit src/main.js) failed with NO_MATCH. ' +
                            'oldText of edits[1] is not in the file.',
                    },
                    {
                        expectedRevision: WRONG_HASH,
                        operations: [addFile],
                        text:
                            'Nothing was written: expectedRevision failed with REVISION_MISMATCH. ' +
                            `The version's revision is ${listing.revision}, not ${WRONG_HASH}.`,
                    },
                ];

                for (const { text, ...args } of conflicts) {
                    const result = await callTool(client, 'update-actor-version', { actor: seeded.id, ...args });

                    expect(expectToolFailure(result)).toBe(text);
                    expect(extractWrittenState(await fetchStoredActor(api, seeded.id))).toEqual(storedBefore);
                }
                const reread = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', { actor: seeded.id }),
                    'get-actor-version',
                );
                expect(reread.revision).toBe(listing.revision);
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: 'update-actor-version and a copy in create-actor-version refuse a version stored in a Git repository, name the repository without its credentials, and change nothing',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('git');
            const selector = await fetchOwnActorSelector(api, name);
            // A placeholder user and password, which the API returns to the owner and the refusal must not repeat.
            const gitRepoUrl = 'https://ci:not-a-secret@github.com/apify/actor-templates.git#master';
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [{ versionNumber: '0.0', sourceType: ActorSourceType.GitRepo, gitRepoUrl }],
                });
                const storedBefore = await fetchStoredActor(api, seeded.id);
                expect(storedBefore.versions).toEqual([
                    expect.objectContaining({ versionNumber: '0.0', sourceType: 'GIT_REPO', gitRepoUrl }),
                ]);
                const refusal =
                    `Version 0.0 of ${seeded.username}/${name} has its files in the Git repository ` +
                    'https://github.com/apify/actor-templates.git#master, not stored on Apify, so this tool cannot ' +
                    'work on them; use the repository.';

                const updateResult = await callTool(client, 'update-actor-version', {
                    actor: seeded.id,
                    operations: [{ type: 'write', path: 'src/main.js', content: 'console.log("one");\n' }],
                });
                const readResult = await callTool(client, 'get-actor-version', { actor: seeded.id });
                const copyResult = await callTool(client, 'create-actor-version', {
                    actor: seeded.id,
                    versionNumber: '0.1',
                    copyFromVersion: '0.0',
                });

                expect(expectToolFailure(updateResult)).toBe(refusal);
                expect(expectToolFailure(readResult)).toBe(refusal);
                expect(expectToolFailure(copyResult)).toBe(refusal);
                expect(extractWrittenState(await fetchStoredActor(api, seeded.id))).toEqual(
                    extractWrittenState(storedBefore),
                );
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: 'create-actor returns the platform error for a name the account already uses and creates nothing',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('taken');
            const selector = await fetchOwnActorSelector(api, name);
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            sourceType: ActorSourceType.SourceFiles,
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("first");\n' }],
                        },
                    ],
                });
                const storedBefore = extractWrittenState(await fetchStoredActor(api, seeded.id));

                const result = await callTool(client, 'create-actor', {
                    name,
                    files: [{ path: 'src/main.js', content: 'console.log("second");\n' }],
                });

                // The sentence is the platform's, so only the name, the API error type, and the tool's frame are
                // exact. In apify-core it reads `Some other Actor already has this name ("<name>").`, with status 409.
                expect(expectToolFailure(result)).toMatch(
                    new RegExp(
                        `^Error calling tool "create-actor": .*"${name}".* \\(API error type: actor-name-not-unique\\)\\. ` +
                            'Verify the tool name and input parameters\\.$',
                    ),
                );
                // The name still leads to the first Actor, stored as it was.
                const storedAfter = await fetchStoredActor(api, selector);
                expect(storedAfter.id).toBe(seeded.id);
                expect(extractWrittenState(storedAfter)).toEqual(storedBefore);
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: 'create-actor-version adds a version from files that get-actor-version reads back with the same hashes and revision, with no build tag, and leaves the other version as it was',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('add');
            const selector = await fetchOwnActorSelector(api, name);
            // No name: unlike the Actor create, the version POST stores actor.json as sent, so the hashes the tool
            // computes from the files it sent are the stored ones.
            const actorJson = '{\n    "actorSpecification": 1,\n    "version": "0.1"\n}\n';
            const mainJs = 'console.log("Grüße 🌍");\n';
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            buildTag: 'latest',
                            sourceType: ActorSourceType.SourceFiles,
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("0.0");\n' }],
                        },
                    ],
                });
                const fullName = `${seeded.username}/${name}`;
                const storedBefore = await fetchStoredActor(api, seeded.id);

                const createResult = await callTool(client, 'create-actor-version', {
                    actor: selector,
                    versionNumber: '0.1',
                    files: [
                        { path: '.actor/actor.json', content: actorJson },
                        { path: 'src/main.js', content: mainJs },
                        // Binary by its extension, so base64 without an encoding.
                        { path: 'assets/logo.png', content: PNG_BASE64 },
                        { path: 'assets/raw-bytes', content: NON_UTF8_BYTES.toString('base64'), encoding: 'base64' },
                    ],
                });
                const created = expectToolSuccess<CreateActorResult>(createResult, 'create-actor-version');
                expect(created).toEqual({
                    actorId: seeded.id,
                    fullName,
                    versionNumber: '0.1',
                    revision: expect.stringMatching(/^[0-9a-f]{16}$/),
                    files: [
                        buildFileListing('.actor/actor.json', actorJson),
                        buildFileListing('assets/logo.png', Buffer.from(PNG_BASE64, 'base64')),
                        buildFileListing('assets/raw-bytes', NON_UTF8_BYTES),
                        buildFileListing('src/main.js', mainJs),
                    ],
                });
                expect(createResult.content?.[1]?.text).toBe(
                    `Created version 0.1 of ${fullName}.\nBuild the version before running it.`,
                );

                const read = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', { actor: selector, versionNumber: '0.1' }),
                    'get-actor-version',
                );
                expect(read).toEqual({ ...created, contents: [] });

                const stored = await fetchStoredActor(api, seeded.id);
                const added = findStoredVersion(stored, '0.1');
                expect(stored.versions).toHaveLength(2);
                expect(findStoredVersion(stored, '0.0')).toEqual(findStoredVersion(storedBefore, '0.0'));
                expect(findStoredVersion(stored, '0.0').buildTag).toBe('latest');
                expect(added.buildTag).toBeUndefined();
                expect(extractSortedSourceFiles(added)).toEqual([
                    { name: '.actor/actor.json', format: 'TEXT', content: actorJson },
                    { name: 'assets/logo.png', format: 'BASE64', content: PNG_BASE64 },
                    { name: 'assets/raw-bytes', format: 'BASE64', content: NON_UTF8_BYTES.toString('base64') },
                    { name: 'src/main.js', format: 'TEXT', content: mainJs },
                ]);
                // autoBuild defaults to false.
                expect(await fetchBuildCount(api, seeded.id)).toBe(0);
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: "create-actor-version copies a version's stored entries, non-secret env vars, and applyEnvVarsToBuild, never its build tag, names the secret env vars it left out, and returns the platform error for a version number the Actor already has",
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('copy');
            const selector = await fetchOwnActorSelector(api, name);
            const mainJs = 'console.log("copy");\n';
            const zJs = 'z();\n';
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            buildTag: 'latest',
                            applyEnvVarsToBuild: true,
                            sourceType: ActorSourceType.SourceFiles,
                            envVars: [
                                { name: 'MODE', value: 'test' },
                                { name: 'SECRET_MODE', value: 'hidden', isSecret: true },
                            ],
                            sourceFiles: [
                                { name: 'src/main.js', format: 'TEXT', content: mainJs },
                                { name: 'assets/logo.png', format: 'BASE64', content: PNG_BASE64 },
                                {
                                    name: 'assets/raw-bytes',
                                    format: 'BASE64',
                                    content: NON_UTF8_BYTES.toString('base64'),
                                },
                                // Entries with no format, with no content, and an empty folder, as the update case
                                // seeds them; a copy sends them back as the Actor GET returns them.
                                { name: 'src/z.js', content: zJs } as ActorVersionSourceFile,
                                { name: 'src/blank.js', format: 'TEXT' } as ActorVersionSourceFile,
                                { name: 'storage', folder: true } as unknown as ActorVersionSourceFile,
                            ],
                        },
                    ],
                });
                const storedBefore = await fetchStoredActor(api, seeded.id);
                const copyArgs = { actor: selector, versionNumber: '0.1', copyFromVersion: '0.0' };

                const createResult = await callTool(client, 'create-actor-version', copyArgs);
                const created = expectToolSuccess<CreateActorResult & { warnings?: string[] }>(
                    createResult,
                    'create-actor-version',
                );
                const stored = await fetchStoredActor(api, seeded.id);
                const original = findStoredVersion(stored, '0.0');
                const copy = findStoredVersion(stored, '0.1');

                expect(stored.versions).toHaveLength(2);
                expect(original).toEqual(findStoredVersion(storedBefore, '0.0'));
                // Every entry, the folder and the ones without format or content included, is stored as it was read.
                expect(extractSortedSourceFiles(copy)).toEqual(extractSortedSourceFiles(original));
                expect(copy.envVars).toEqual([expect.objectContaining({ name: 'MODE', value: 'test' })]);
                expect(copy.applyEnvVarsToBuild).toBe(true);
                expect(copy.buildTag).toBeUndefined();

                const read = expectToolSuccess<GetActorVersionResult>(
                    await callTool(client, 'get-actor-version', { actor: selector, versionNumber: '0.1' }),
                    'get-actor-version',
                );
                expect(read.files).toEqual([
                    buildFileListing('assets/logo.png', Buffer.from(PNG_BASE64, 'base64')),
                    buildFileListing('assets/raw-bytes', NON_UTF8_BYTES),
                    buildFileListing('src/blank.js', ''),
                    buildFileListing('src/main.js', mainJs),
                    buildFileListing('src/z.js', zJs),
                ]);
                expect(created).toEqual({
                    actorId: seeded.id,
                    fullName: `${seeded.username}/${name}`,
                    versionNumber: '0.1',
                    revision: read.revision,
                    files: read.files,
                    warnings: [
                        'These files are empty, and the build skips empty files, so they will not exist in the build: src/blank.js.',
                        'These secret environment variables were not copied, so set them on version 0.1 in Apify Console before building or running it: SECRET_MODE.',
                    ],
                });
                // The warning names the secret, never its value.
                expect(JSON.stringify(createResult)).not.toContain('hidden');
                expect(await fetchBuildCount(api, seeded.id)).toBe(0);

                // The sentence is the platform's, so only the API error type is exact, and no hint follows it.
                // In apify-core it reads `Version with this number already exists`, with status 403.
                const retryText = expectToolFailure(await callTool(client, 'create-actor-version', copyArgs));
                expect(retryText).toMatch(/^.+ \(API error type: version-already-exists\)$/);
                expect(extractWrittenState(await fetchStoredActor(api, seeded.id))).toEqual(
                    extractWrittenState(stored),
                );
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
    {
        name: 'delete-actor-version deletes one version, refuses one the Actor does not have, and returns the platform refusal for the last one',
        isDeploymentTest: false,
        run: withClient({ tools: ['source'] }, async (client, ctx) => {
            const api = ctx.createApifyClient();
            const name = buildUniqueActorName('delete');
            const selector = await fetchOwnActorSelector(api, name);
            try {
                const seeded = await api.actors().create({
                    name,
                    versions: [
                        {
                            versionNumber: '0.0',
                            buildTag: 'latest',
                            sourceType: ActorSourceType.SourceFiles,
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("0.0");\n' }],
                        },
                        {
                            versionNumber: '0.1',
                            sourceType: ActorSourceType.SourceFiles,
                            sourceFiles: [{ name: 'src/main.js', format: 'TEXT', content: 'console.log("0.1");\n' }],
                        },
                    ],
                });
                const storedBefore = await fetchStoredActor(api, seeded.id);
                expect(storedBefore.versions).toHaveLength(2);

                const deleteResult = await callTool(client, 'delete-actor-version', {
                    actor: selector,
                    versionNumber: '0.1',
                });
                const deleted = expectToolSuccess(deleteResult, 'delete-actor-version');
                expect(deleted).toEqual({
                    actorId: seeded.id,
                    fullName: `${seeded.username}/${name}`,
                    versionNumber: '0.1',
                    deleted: true,
                });
                // Version 0.1 has no build tag, so no next step about one follows.
                expect(deleteResult.content?.[1]?.text).toBe(`Deleted version 0.1 of ${seeded.username}/${name}.`);
                const storedAfter = await fetchStoredActor(api, seeded.id);
                expect(storedAfter.versions).toEqual([findStoredVersion(storedBefore, '0.0')]);

                // apify-client reports a DELETE of a missing version as done, so the tool refuses it from its read.
                const missingText = expectToolFailure(
                    await callTool(client, 'delete-actor-version', { actor: selector, versionNumber: '0.1' }),
                );
                expect(missingText).toBe(`Actor '${selector}' has no version 0.1; available versions: 0.0.`);
                expect(extractWrittenState(await fetchStoredActor(api, seeded.id))).toEqual(
                    extractWrittenState(storedAfter),
                );

                // The sentence is the platform's, so only the API error type is exact, and no hint follows it.
                // In apify-core it reads `The Actor must have at least 1 versions`, with status 403.
                const lastText = expectToolFailure(
                    await callTool(client, 'delete-actor-version', { actor: selector, versionNumber: '0.0' }),
                );
                expect(lastText).toMatch(/^.+ \(API error type: too-few-versions\)$/);
                expect(extractWrittenState(await fetchStoredActor(api, seeded.id))).toEqual(
                    extractWrittenState(storedAfter),
                );
            } finally {
                await api.actor(selector).delete();
            }
        }),
    },
];
