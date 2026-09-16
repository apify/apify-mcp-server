import { ACTOR_NAME, MAX_MULTIFILE_BYTES, USERNAME } from '@apify/consts';
import type {
    Actor,
    ActorClient,
    ActorCollectionCreateOptions,
    ActorVersion,
    ActorVersionClient,
    ActorVersionSourceFile,
    ActorVersionSourceFiles,
    ActorVersionTarball,
    Build,
} from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
import { ABORT, WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';
import { pushActorToolOutputSchema } from '../structured_output_schemas.js';
import { buildNextStepForBuild, listVersionNumbers, startBuild, toBuildResult } from './build_helpers.js';
import { buildSourceZip, formatSourceRecordKey, formatSourceStoreName, uploadSourceArchive } from './source_archive.js';
import {
    ACTOR_CONFIG_PATH,
    getSourceFilesSizeBytes,
    hasActorConfig,
    mergeSourceFiles,
    type SourceFileInput,
    toSourceFiles,
    validateSourceFiles,
} from './source_files.js';

/** `apify push` defaults to this tag too, because the platform complains when an Actor has no `latest` build. */
const DEFAULT_BUILD_TAG = 'latest';

/** The platform's inline source-files cutoff; above it the files go as a zip, the same switch `apify push` makes. */
const MULTIFILE_SOURCE_MAX_MIB = MAX_MULTIFILE_BYTES / (1024 * 1024);

/** `apify push` starts a new Actor at this version. */
const DEFAULT_VERSION_NUMBER = '0.0';

const pushActorArgs = z.object({
    actorName: z
        .string()
        .min(1)
        .describe(
            'Actor name in your account: bare (my-scraper) or with your username as john/my-scraper or john~my-scraper (the API form); created if it does not exist. The returned actorId is the Actor ID the build and run tools take',
        ),
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version to push the files to, in MAJOR.MINOR form. Defaults to the only version of an existing Actor, or to 0.0 for a new Actor; a version that does not exist yet is created',
        ),
    buildTag: z.string().min(1).optional().describe('Build tag for this version, for example latest'),
    files: z
        .array(
            z.object({
                path: z
                    .string()
                    .min(1)
                    .describe('Path relative to the Actor root, for example .actor/actor.json or src/main.js'),
                content: z.string().describe('File content, as text or as base64 when encoding is base64'),
                // `.optional()` instead of `.default('utf8')`: `fixZodSchemaRequired` only fixes top-level
                // fields, so a nested default would stay in the item's `required` list and AJV would
                // reject files that omit it.
                encoding: z.enum(['utf8', 'base64']).optional().describe('Use base64 for binary files; defaults to utf8'),
            }),
        )
        .min(1)
        .describe('Files to upload'),
    mode: z
        .enum(['merge', 'replace'])
        .default('merge')
        .describe('merge keeps existing files not listed here; replace makes the version contain exactly these files'),
    build: z.boolean().default(true).describe('Start a build of the version after pushing the files'),
    waitSecs: z
        .number()
        .int()
        .min(0)
        .max(WAIT_SECS_MAX)
        .default(WAIT_SECS_MAX)
        .describe('How long to wait for the build to finish before returning its current status'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const actorIdTakers = [HELPER_TOOLS.ACTOR_BUILD, HELPER_TOOLS.ACTOR_CALL].filter(hasTool);
    return `Push files to an Actor in your account and, by default, build the pushed version.
Creates the Actor when it does not exist and creates or updates the version otherwise: the equivalent of the Apify CLI's apify push.
Returns the Actor ID and name, the version, its build tag, the number of files now in the version, how it stores them (sourceType SOURCE_FILES inline or TARBALL as a zip), the build when one was started, and a summary with one next step.${
        actorIdTakers.length > 0 ? ` Pass the returned actorId as actor to ${actorIdTakers.join(' and ')}.` : ''
    }
Files are text (utf8) or base64 for binaries; paths are relative to the Actor root and the version must end up containing ${ACTOR_CONFIG_PATH}.
Files up to ${MULTIFILE_SOURCE_MAX_MIB} MiB in total are stored as editable source files. A larger set is zipped into a key-value store the version points to, as apify push does; later pushes to that version must send all files with mode replace.
Omit versionNumber to push to the only version of an existing Actor; an Actor with several versions needs it, and a version that does not exist yet is created.
mode merge (default) keeps files already in the version that are not listed; mode replace makes the version contain exactly the listed files.${
        hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
            ? ` If the build is still running when the wait ends, check it with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
            : ''
    }${
        hasTool(HELPER_TOOLS.ACTOR_BUILD)
            ? ` Set build to false to push without building and build later with ${HELPER_TOOLS.ACTOR_BUILD}.`
            : ''
    }

USAGE:
- Use to deploy a new Actor from source files written in the conversation or read from disk.
- Use to change one or more files of an existing Actor version and rebuild it.

USAGE EXAMPLES:
- user_input: Deploy this code as an Actor called my-scraper
- user_input: Update src/main.js in my-scraper and rebuild it`;
}

type PushMode = 'merge' | 'replace';

type PushActorFilesParams = {
    client: ApifyClient;
    actorNameParts: ActorNameParts;
    versionNumber: string | undefined;
    buildTag: string | undefined;
    mode: PushMode;
    sourceFiles: ActorVersionSourceFile[];
};

type PushActorFilesResult = {
    actorId: string;
    /** Full name in the `username/name` form, whichever separator the caller used. */
    actorName: string;
    versionNumber: string;
    /** The Actor was created; false when only the version was created or updated. */
    created: boolean;
    versionCreated: boolean;
    buildTag: string;
    /** Files now in the version: the pushed files plus, in merge mode, the kept ones. */
    filesPushed: number;
    /** SOURCE_FILES when the version holds the files inline, TARBALL when it points at their zip. */
    sourceType: VersionSource['sourceType'];
};

/** What a version write produced; `pushActorFiles` adds the Actor identity around it. */
type VersionWriteOutcome = Pick<PushActorFilesResult, 'versionCreated' | 'buildTag' | 'filesPushed' | 'sourceType'>;

const ACTOR_CONFIG_MISSING_TEXT = `The files must include ${ACTOR_CONFIG_PATH}; the platform needs it to build the Actor.`;

type ActorNameParts = { ownerPrefix: string | undefined; bareName: string };

/** The `username/name` form the API and the responses use. */
function formatActorFullName(username: string, bareName: string): string {
    return `${username}/${bareName}`;
}

/**
 * Splits `username/name` or `username~name` (the separator the Apify API uses) into its parts; a bare
 * name has no `ownerPrefix`.
 */
function parseActorName(actorName: string): ActorNameParts {
    const separatorIndex = actorName.search(/[/~]/);
    if (separatorIndex === -1) return { ownerPrefix: undefined, bareName: actorName };
    return { ownerPrefix: actorName.slice(0, separatorIndex), bareName: actorName.slice(separatorIndex + 1) };
}

const ACTOR_NAME_RULE_TEXT = `Actor name must be ${ACTOR_NAME.MIN_LENGTH} to ${ACTOR_NAME.MAX_LENGTH} characters: letters, digits and dashes, not starting or ending with a dash.`;

const USERNAME_PREFIX_RULE_TEXT = `Username prefix must be ${USERNAME.MIN_LENGTH} to ${USERNAME.MAX_LENGTH} letters, digits, dots, underscores or dashes.`;

/**
 * The name split into its parts, checked with the platform's own rules (`@apify/consts`, the ones the
 * API applies) so a bad name is rejected before any API call; throws `UserInputError` for the first problem.
 */
function resolveActorNameInput(actorName: string): ActorNameParts {
    const parts = parseActorName(actorName);
    const { ownerPrefix, bareName } = parts;
    const isBareNameValid =
        bareName.length >= ACTOR_NAME.MIN_LENGTH &&
        bareName.length <= ACTOR_NAME.MAX_LENGTH &&
        ACTOR_NAME.REGEX.test(bareName);
    if (!isBareNameValid) throw new UserInputError(ACTOR_NAME_RULE_TEXT);
    if (ownerPrefix !== undefined && !USERNAME.REGEX.test(ownerPrefix)) {
        throw new UserInputError(USERNAME_PREFIX_RULE_TEXT);
    }
    return parts;
}

// The platform stores versions as MAJOR.MINOR integers (see VERSION_INT_MAJOR_BASE and VERSION_INT_MINOR_BASE in @apify/consts); no shared regex exists there.
const VERSION_NUMBER_REGEX = /^\d+\.\d+$/;

/** Throws `UserInputError` unless the version number is omitted or in MAJOR.MINOR form; runs before any API call. */
function validateVersionNumber(versionNumber: string | undefined): void {
    if (versionNumber !== undefined && !VERSION_NUMBER_REGEX.test(versionNumber)) {
        throw new UserInputError('Version number must be MAJOR.MINOR, for example 0.1');
    }
}

function formatVersionList(versionNumbers: readonly string[]): string {
    if (versionNumbers.length === 0) return 'this Actor has no versions';
    return `this Actor has versions: ${versionNumbers.join(', ')}`;
}

/**
 * The files in the API shape; throws `UserInputError` for the first problem with them: a bad path, a
 * duplicate, or invalid base64. Mode-independent; whether the version ends up with `.actor/actor.json`
 * is checked by the push step that knows the version.
 */
function resolveSourceFiles(files: readonly SourceFileInput[]): ActorVersionSourceFile[] {
    validateSourceFiles(files);
    return toSourceFiles(files);
}

type VersionSource =
    | Pick<ActorVersionSourceFiles, 'sourceType' | 'sourceFiles'>
    | Pick<ActorVersionTarball, 'sourceType' | 'tarballUrl'>;

/** The platform accepts a set of exactly the limit inline, so only a larger one goes as a zip. */
function isOverInlineSourceLimit(files: readonly ActorVersionSourceFile[]): boolean {
    return getSourceFilesSizeBytes(files) > MAX_MULTIFILE_BYTES;
}

type ResolveVersionSourceParams = {
    client: ApifyClient;
    actorId: string;
    versionNumber: string;
    files: ActorVersionSourceFile[];
};

/**
 * What the version will point at: the files themselves up to the inline limit, otherwise the URL of
 * their zip uploaded to the Actor's source store, the same switch `apify push` makes.
 */
async function resolveVersionSource(params: ResolveVersionSourceParams): Promise<VersionSource> {
    const { client, actorId, versionNumber, files } = params;
    if (!isOverInlineSourceLimit(files)) return { sourceType: ActorSourceType.SourceFiles, sourceFiles: files };
    const tarballUrl = await uploadSourceArchive(client, { actorId, versionNumber, zip: buildSourceZip(files) });
    return { sourceType: ActorSourceType.Tarball, tarballUrl };
}

type TargetActor = {
    actorClient: ActorClient;
    /** The account the Actor lives in, in the platform's spelling. */
    username: string;
    bareName: string;
    /** Undefined when the Actor does not exist yet. */
    actor: Actor | undefined;
};

/** Looks up the caller's username and the Actor; a `username/` or `username~` prefix must name the caller's own account. */
async function resolveTargetActor(client: ApifyClient, { ownerPrefix, bareName }: ActorNameParts): Promise<TargetActor> {
    const { username } = await client.user('me').get();
    if (ownerPrefix !== undefined && ownerPrefix.toLowerCase() !== username.toLowerCase()) {
        throw new UserInputError(
            `This tool pushes only to your own account (${username}); '${ownerPrefix}' names another account.`,
        );
    }
    const actorClient = client.actor(formatActorFullName(username, bareName));
    return { actorClient, username, bareName, actor: await actorClient.get() };
}

type CreateActorParams = {
    client: ApifyClient;
    bareName: string;
    versionNumber: string;
    buildTag: string | undefined;
    sourceFiles: ActorVersionSourceFile[];
};

/**
 * The Actor exists, but the zip upload or the switch to it failed after the create call. Reported with
 * the Actor ID, the same way `BuildStartError` reports a completed push, so the agent pushes again
 * instead of retrying the create.
 */
class ActorCreatedError extends Error {
    override readonly name = 'ActorCreatedError';

    constructor(
        readonly actorId: string,
        versionNumber: string,
        cause: unknown,
    ) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        // API messages rarely end with a period; give the reason its own sentence so the retry hint does not run into it.
        super(
            `The Actor was created (ID ${actorId}), but storing its files failed: ${reason.replace(/\.?$/, '.')} Push again to fill version ${versionNumber}.`,
            { cause },
        );
    }
}

/**
 * The Actor does not exist yet: the pushed files are its whole first version, so they must carry the
 * config. A set over the inline limit is stored under the Actor's ID, so the Actor is created first
 * with an empty version, the placeholder `apify push` creates too, and the version is then switched to
 * the uploaded zip. If that upload fails the empty version stays; pushing again fills it.
 */
async function createActorWithVersion(params: CreateActorParams): Promise<VersionWriteOutcome & { actorId: string }> {
    const { client, bareName, versionNumber, sourceFiles } = params;
    if (!hasActorConfig(sourceFiles)) throw new UserInputError(ACTOR_CONFIG_MISSING_TEXT);
    const buildTag = params.buildTag ?? DEFAULT_BUILD_TAG;
    const isInline = !isOverInlineSourceLimit(sourceFiles);
    const created = await client.actors().create({
        name: bareName,
        versions: [
            {
                versionNumber,
                buildTag,
                sourceType: ActorSourceType.SourceFiles,
                sourceFiles: isInline ? sourceFiles : [],
            },
        ],
    } satisfies ActorCollectionCreateOptions);
    const outcome = { actorId: created.id, versionCreated: true, buildTag, filesPushed: sourceFiles.length };
    if (isInline) return { ...outcome, sourceType: ActorSourceType.SourceFiles };
    try {
        const zip = buildSourceZip(sourceFiles);
        const tarballUrl = await uploadSourceArchive(client, { actorId: created.id, versionNumber, zip });
        await client
            .actor(created.id)
            .version(versionNumber)
            .update({ sourceType: ActorSourceType.Tarball, tarballUrl, buildTag } satisfies ActorVersionTarball);
        return { ...outcome, sourceType: ActorSourceType.Tarball };
    } catch (error) {
        throw new ActorCreatedError(created.id, versionNumber, error);
    }
}

/** The requested version, or the only version of the Actor, or the default for an Actor with no versions. */
function resolveVersionNumber(
    actor: Pick<Actor, 'versions'>,
    requestedVersionNumber: string | undefined,
): string {
    const versionNumbers = listVersionNumbers(actor);
    if (requestedVersionNumber === undefined && versionNumbers.length > 1) {
        throw new UserInputError(`Specify versionNumber; ${formatVersionList(versionNumbers)}.`);
    }
    return requestedVersionNumber ?? versionNumbers[0] ?? DEFAULT_VERSION_NUMBER;
}

type CreateVersionParams = {
    client: ApifyClient;
    actorClient: ActorClient;
    actor: Pick<Actor, 'id' | 'versions'>;
    versionNumber: string;
    buildTag: string | undefined;
    sourceFiles: ActorVersionSourceFile[];
};

/**
 * With no existing version there is nothing to merge into, so the pushed files alone must carry the
 * config, in either mode. The version list tells the caller a new version is about to be created, in
 * case that was not intended.
 */
async function createVersion(params: CreateVersionParams): Promise<VersionWriteOutcome> {
    const { client, actorClient, actor, versionNumber, buildTag, sourceFiles } = params;
    if (!hasActorConfig(sourceFiles)) {
        throw new UserInputError(
            `Version ${versionNumber} does not exist and would be created (${formatVersionList(listVersionNumbers(actor))}). ${ACTOR_CONFIG_MISSING_TEXT}`,
        );
    }
    const source = await resolveVersionSource({ client, actorId: actor.id, versionNumber, files: sourceFiles });
    await actorClient.versions().create({ versionNumber, buildTag: buildTag ?? DEFAULT_BUILD_TAG, ...source });
    return {
        versionCreated: true,
        buildTag: buildTag ?? DEFAULT_BUILD_TAG,
        filesPushed: sourceFiles.length,
        sourceType: source.sourceType,
    };
}

type UpdateVersionParams = {
    client: ApifyClient;
    versionClient: ActorVersionClient;
    actorId: string;
    existing: ActorVersion;
    versionNumber: string;
    mode: PushMode;
    buildTag: string | undefined;
    sourceFiles: ActorVersionSourceFile[];
};

/**
 * The files the version will hold. Replace: the pushed files are the whole version, so they must carry
 * the config. Merge: existing files not listed are kept, so the merged set is what must carry it, and
 * only a version that already uses source files has files to merge into.
 */
function resolveVersionFiles(
    params: Pick<UpdateVersionParams, 'existing' | 'versionNumber' | 'mode' | 'sourceFiles'>,
): ActorVersionSourceFile[] {
    const { existing, versionNumber, mode, sourceFiles } = params;
    if (mode === 'replace') {
        if (!hasActorConfig(sourceFiles)) throw new UserInputError(ACTOR_CONFIG_MISSING_TEXT);
        return sourceFiles;
    }
    if (existing.sourceType !== ActorSourceType.SourceFiles) {
        throw new UserInputError(
            `Version ${versionNumber} uses source type ${existing.sourceType}, which mode 'merge' cannot add to; use mode 'replace' and send all files.`,
        );
    }
    const files = mergeSourceFiles(existing.sourceFiles, sourceFiles);
    if (!hasActorConfig(files)) throw new UserInputError(ACTOR_CONFIG_MISSING_TEXT);
    return files;
}

/**
 * A version switched to a zip keeps its old `sourceFiles` array on the platform, which builds from
 * `sourceType` alone; `apify push` leaves it the same way, so nothing is cleared here.
 */
async function updateVersion(params: UpdateVersionParams): Promise<VersionWriteOutcome> {
    const { client, versionClient, actorId, existing, versionNumber, buildTag } = params;
    const files = resolveVersionFiles(params);
    const source = await resolveVersionSource({ client, actorId, versionNumber, files });
    await versionClient.update({ ...source, ...(buildTag !== undefined && { buildTag }) });
    return {
        versionCreated: false,
        buildTag: buildTag ?? existing.buildTag ?? DEFAULT_BUILD_TAG,
        filesPushed: files.length,
        sourceType: source.sourceType,
    };
}

/**
 * Creates the Actor with the files, or creates or updates the version of an existing Actor. Each write
 * step checks that the version ends up containing `.actor/actor.json` before it writes, so a rejected
 * push has made no write. Throws `UserInputError` for problems the user must fix and `ActorCreatedError`
 * when a new Actor's zip could not be stored after the create call; `envVars` is never
 * sent so the version keeps its own.
 */
async function pushActorFiles(params: PushActorFilesParams): Promise<PushActorFilesResult> {
    const { client, buildTag, mode, sourceFiles } = params;
    const { actorClient, username, bareName, actor } = await resolveTargetActor(client, params.actorNameParts);
    const actorName = formatActorFullName(username, bareName);
    if (!actor) {
        const versionNumber = params.versionNumber ?? DEFAULT_VERSION_NUMBER;
        const { actorId, ...outcome } = await createActorWithVersion({ client, bareName, versionNumber, buildTag, sourceFiles });
        return { actorId, actorName, versionNumber, created: true, ...outcome };
    }
    const versionNumber = resolveVersionNumber(actor, params.versionNumber);
    const versionClient = actorClient.version(versionNumber);
    const existing = await versionClient.get();
    const outcome = existing
        ? await updateVersion({ client, versionClient, actorId: actor.id, existing, versionNumber, mode, buildTag, sourceFiles })
        : await createVersion({ client, actorClient, actor, versionNumber, buildTag, sourceFiles });
    return { actorId: actor.id, actorName, versionNumber, created: false, ...outcome };
}

/**
 * The push is a completed write, so whatever stops the build request (an API rejection, a network
 * failure) is reported together with the push result instead of as a tool error that would hide it.
 */
class BuildStartError extends Error {
    override readonly name = 'BuildStartError';

    constructor(
        readonly pushed: PushActorFilesResult,
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
}

/** Starts a build of the pushed version and waits for it; throws `BuildStartError` when the build request fails. */
async function startPushedBuild(params: {
    client: ApifyClient;
    pushed: PushActorFilesResult;
    waitSecs: number;
    signal: AbortSignal;
}): Promise<Build | typeof ABORT> {
    const { client, pushed, waitSecs, signal } = params;
    try {
        // No tag is passed: the version's buildTag applies, the same as `apify push`.
        return await startBuild(client, pushed.actorId, pushed.versionNumber, { useCache: true, waitSecs, signal });
    } catch (error) {
        throw new BuildStartError(pushed, error);
    }
}

function formatOutcome({ created, versionCreated, versionNumber }: PushActorFilesResult): string {
    if (created) return 'created the Actor';
    if (versionCreated) return `created version ${versionNumber}`;
    return 'updated the version';
}

function formatFileCount(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** A zip-stored version shows no files in Console and has nothing merge mode can add to. */
function formatArchiveNote({ actorId, versionNumber }: Pick<PushActorFilesResult, 'actorId' | 'versionNumber'>): string {
    return `The files total more than ${MULTIFILE_SOURCE_MAX_MIB} MiB, so they are stored as a zip in key-value store ${formatSourceStoreName(actorId)} (record ${formatSourceRecordKey(versionNumber)}) that the version points to; later pushes to this version must send all files with mode replace.`;
}

function buildNextStep(build: Build | undefined, loadedToolNames: readonly string[]): string {
    if (build) return buildNextStepForBuild(build, { loadedToolNames });
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Trigger a build with ${HELPER_TOOLS.ACTOR_BUILD} to make this version runnable.`
        : 'Build this version to make it runnable.';
}

/** The push succeeded but the build request failed; the caller must know the write happened. */
function formatBuildStartFailure(errMessage: string, loadedToolNames: readonly string[]): string {
    const retry = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Retry the build with ${HELPER_TOOLS.ACTOR_BUILD}.`
        : 'Retry building this version to make it runnable.';
    // API messages rarely end with a period; give the message its own sentence so the retry hint does not run into it.
    return `The files were pushed, but the build could not be started: ${errMessage.replace(/\.?$/, '.')} ${retry}`;
}

type PushResponseParams = {
    pushed: PushActorFilesResult;
    /** Files sent in this call; `pushed.filesPushed` is what the version holds now. */
    filesSent: number;
    /** The started build; undefined when build was false or the build request failed. */
    build: Build | undefined;
    /** The API message when the push succeeded but the build request failed. */
    buildStartErrMessage: string | undefined;
    loadedToolNames: readonly string[];
    apifyToken: string;
    client: ApifyClient;
};

/** The push result as structuredContent and JSON text, a summary with one next step, and the build's Console link for Console UI token sessions. */
async function buildPushResponse(params: PushResponseParams): Promise<ToolResponse> {
    const { pushed, filesSent, build, buildStartErrMessage, loadedToolNames, apifyToken, client } = params;
    const linkContext = build ? await getConsoleLinkContext(apifyToken, client) : undefined;
    const structuredContent = {
        actorId: pushed.actorId,
        actorName: pushed.actorName,
        created: pushed.created,
        versionNumber: pushed.versionNumber,
        buildTag: pushed.buildTag,
        filesPushed: pushed.filesPushed,
        sourceType: pushed.sourceType,
        ...(build !== undefined && { build: toBuildResult(build, linkContext) }),
    };
    const archiveNote = pushed.sourceType === ActorSourceType.Tarball ? ` ${formatArchiveNote(pushed)}` : '';
    const summary = `Pushed ${formatFileCount(filesSent)} to ${pushed.actorName} version ${pushed.versionNumber} (${formatOutcome(pushed)}); the version now has ${formatFileCount(pushed.filesPushed)}.${archiveNote}`;
    const nextStep =
        buildStartErrMessage === undefined
            ? buildNextStep(build, loadedToolNames)
            : formatBuildStartFailure(buildStartErrMessage, loadedToolNames);
    const consoleLinkText = apifyConsoleLinkText(structuredContent.build?.apifyConsoleUrl);
    return respondOk(
        [JSON.stringify(structuredContent), `${summary}\n${nextStep}`, ...(consoleLinkText ? [consoleLinkText] : [])],
        { structuredContent },
    );
}

/**
 * https://docs.apify.com/api/v2/actors-post
 *  /v2/actors
 * https://docs.apify.com/api/v2/actor-version-put
 *  /v2/actors/{actorId}/versions/{versionNumber}
 * https://docs.apify.com/api/v2/actor-versions-post
 *  /v2/actors/{actorId}/versions
 * https://docs.apify.com/api/v2/key-value-store-record-put
 *  /v2/key-value-stores/{storeId}/records/{recordKey}
 *
 * Uses the same JSON `sourceType: SOURCE_FILES` + `sourceFiles` contract as `apify push`
 * (actors().create, version().update, versions().create), which is the contract the API
 * reference documents for creating and updating a version. apify/apify-core#29044 reports a
 * tarball upload route; no such route exists in the API reference and none is used here.
 * Files over the inline limit go the other way `apify push` goes: zipped into the Actor's source
 * key-value store, with the version set to `sourceType: TARBALL` and the record URL.
 * Resolves apify/apify-mcp-server#1217.
 *
 * Steps throw `UserInputError` when the call is rejected, `ActorCreatedError` when a new Actor's zip could
 * not be stored after the create call, and `BuildStartError` when the push succeeded but the build did not
 * start; `call()` maps all three to responses.
 */
export const pushActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_PUSH,
    title: 'Push Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `mode`, `build` and `waitSecs` from `required` because they have defaults.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(pushActorArgs)) as ToolInputSchema,
    outputSchema: pushActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(pushActorArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Push Actor',
        readOnlyHint: false,
        // mode replace overwrites the version's files.
        destructiveHint: true,
        // The default path starts a new build on every call, the same as build-actor.
        idempotentHint: false,
        openWorldHint: true,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames, signal } = toolArgs;
        const parsed = pushActorArgs.parse(args);
        // `toSourceFiles` maps the input files one to one, so this is also the number of files sent.
        const responseContext = { filesSent: parsed.files.length, loadedToolNames, apifyToken, client };
        try {
            const actorNameParts = resolveActorNameInput(parsed.actorName);
            validateVersionNumber(parsed.versionNumber);
            const sourceFiles = resolveSourceFiles(parsed.files);
            const pushed = await pushActorFiles({
                client,
                actorNameParts,
                versionNumber: parsed.versionNumber,
                buildTag: parsed.buildTag,
                mode: parsed.mode,
                sourceFiles,
            });

            let build: Build | undefined;
            if (parsed.build) {
                const started = await startPushedBuild({ client, pushed, waitSecs: parsed.waitSecs, signal });
                // The push is already done, the same as get-actor-build aborting mid-wait. Per MCP spec a
                // cancelled request gets no response, so the push result is not reported.
                if (started === ABORT) return respondAborted();
                build = started;
            }
            return await buildPushResponse({ pushed, build, buildStartErrMessage: undefined, ...responseContext });
        } catch (error) {
            // Checked first: a 403 on the build request is an ApifyApiError too, but the push has already been written.
            if (error instanceof BuildStartError) {
                return await buildPushResponse({
                    pushed: error.pushed,
                    build: undefined,
                    buildStartErrMessage: error.message,
                    ...responseContext,
                });
            }
            // The Actor write happened; the status and category come from the real cause, a 403 included.
            if (error instanceof ActorCreatedError) {
                return respondServerError(error.message, { error: error.cause, actorId: error.actorId });
            }
            if (error instanceof UserInputError) return respondUserError(error.message);
            // Covers the reads too: a scoped token can be denied the user, Actor or version lookup as well as the write.
            if (error instanceof ApifyApiError && error.statusCode === 403) {
                return respondUserError(
                    'The token is not allowed to read or modify Actors in this account, or the key-value store a zipped push goes to; scoped tokens cannot include Actor write access. Use a token with full access.',
                    { category: FAILURE_CATEGORY.AUTH, httpStatus: 403 },
                );
            }
            throw error;
        }
    },
} as const);
