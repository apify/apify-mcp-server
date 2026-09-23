import type { Actor, ActorVersion, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import type { UnzipFileFilter, Unzipped } from 'fflate';
import { unzipSync } from 'fflate';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { listVersionNumbers } from '../builds/build_helpers.js';
import { catchNotFound } from '../storage/storage_helpers.js';
import { pullActorToolOutputSchema } from '../structured_output_schemas.js';
import { hasBinaryExtension } from './source_files.js';

const INLINE_LIMIT_KIB = MAX_INLINE_BYTES / 1024;

const BYTES_PER_MIB = 1024 * 1024;

/**
 * A zip over this size is refused before it is downloaded: reading it holds the whole archive in memory, while the
 * response carries at most `MAX_INLINE_BYTES` of its content.
 */
const MAX_SOURCE_ARCHIVE_BYTES = 50 * BYTES_PER_MIB;

/** The path of the record URL `apify push` and push-actor point a zip-stored version at. */
const SOURCE_RECORD_PATH_REGEX = /^\/v2\/key-value-stores\/([^/]+)\/records\/([^/]+)$/;

// `ignoreBOM` keeps a byte order mark in the text, so a pulled file pushed back is byte-identical.
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const pullActorArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or username/name'),
    // Format is not enforced by a regex, the same as build-actor: the lookup against the Actor's versions
    // rejects anything that is not an existing version with a soft fail.
    versionNumber: z
        .string()
        .optional()
        .describe('Version to read in MAJOR.MINOR form; defaults to the only version when the Actor has exactly one'),
    paths: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
            'File paths relative to the Actor root, for example src/main.js; only these files are returned. Omit to return all files up to the size limit',
        ),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Read the source files of an Actor version: each file's path, content and encoding (utf8 for text, base64 for binary files), the equivalent of the Apify CLI's apify pull.${
        hasTool(HELPER_TOOLS.ACTOR_PUSH)
            ? ` The files come in the shape ${HELPER_TOOLS.ACTOR_PUSH} takes, so they can be edited and pushed back with it.`
            : ''
    }
Returns the Actor ID and name, the version, its sourceType, the files, the files left out by the size limit (omittedFiles, with their sizes), the requested paths the version has no file at (notFoundPaths), and a summary with one next step.
A version whose files are stored on Apify, inline (SOURCE_FILES) or as a zip in a key-value store record of this Apify API (TARBALL), returns them. A version built from a Git repository (GIT_REPO), a GitHub gist (GITHUB_GIST) or a zip at another URL returns only that URL, to clone or download in your own environment; this tool fetches nothing from outside Apify.
The files returned total at most ${INLINE_LIMIT_KIB} KiB of content; pass paths to read only the named files, for example the ones listed in omittedFiles. Omit versionNumber to read the only version; an Actor with several versions needs it.

USAGE:
- Use to read the code of an Actor that is not in the conversation or on disk, for example one created in Apify Console or pushed from another machine, before changing it.

USAGE EXAMPLES:
- user_input: Show me the source code of my-scraper
- user_input: Fix the bug in src/main.js of john/my-scraper`;
}

/** The shape push-actor takes a file in. */
type PulledFile = { path: string; content: string; encoding: 'utf8' | 'base64' };

type OmittedFile = { path: string; sizeBytes: number };

/**
 * A file before the size cap. `contentBytes` is what its content takes in the response (base64 text for a binary
 * file); `file` is undefined for a zip entry that was not decompressed.
 */
type FileCandidate = OmittedFile & { contentBytes: number; file: PulledFile | undefined };

type PulledFiles = {
    files: PulledFile[];
    omittedFiles: OmittedFile[];
    /** Omitted files whose content alone is over the cap, so no call of this tool can return them. */
    tooLargePaths: string[];
    notFoundPaths: string[];
    /** Files in the version, requested or not. */
    totalFiles: number;
};

type PullTarget = { actorId: string; actorName: string; versionNumber: string };

/** The requested version when the Actor has it, else the only version; throws `UserInputError` otherwise, with build-actor's wording. */
function resolveVersionNumber(
    actor: Pick<Actor, 'versions'>,
    requestedVersionNumber: string | undefined,
    actorSelector: string,
): string {
    const versionNumbers = listVersionNumbers(actor);
    if (versionNumbers.length === 0) throw new UserInputError(`Actor '${actorSelector}' has no versions.`);
    if (requestedVersionNumber !== undefined && !versionNumbers.includes(requestedVersionNumber)) {
        throw new UserInputError(
            `Actor '${actorSelector}' has no version ${requestedVersionNumber}; available versions: ${versionNumbers.join(', ')}.`,
        );
    }
    if (requestedVersionNumber === undefined && versionNumbers.length !== 1) {
        throw new UserInputError(`Specify versionNumber; this Actor has versions: ${versionNumbers.join(', ')}.`);
    }
    return requestedVersionNumber ?? versionNumbers[0];
}

/**
 * Takes the files in order while their content fits in `MAX_INLINE_BYTES`; a file that does not fit is listed with
 * its size, and the files after it still get their turn.
 */
function applyInlineCap(
    candidates: readonly FileCandidate[],
): Pick<PulledFiles, 'files' | 'omittedFiles' | 'tooLargePaths'> {
    const files: PulledFile[] = [];
    const omittedFiles: OmittedFile[] = [];
    let totalBytes = 0;
    for (const { path, sizeBytes, contentBytes, file } of candidates) {
        if (file && totalBytes + contentBytes <= MAX_INLINE_BYTES) {
            files.push(file);
            totalBytes += contentBytes;
            continue;
        }
        omittedFiles.push({ path, sizeBytes });
    }
    const tooLargePaths = candidates
        .filter((candidate) => candidate.contentBytes > MAX_INLINE_BYTES)
        .map((candidate) => candidate.path);
    return { files, omittedFiles, tooLargePaths };
}

function listNotFoundPaths(
    requestedPaths: ReadonlySet<string> | undefined,
    existingPaths: readonly string[],
): string[] {
    if (!requestedPaths) return [];
    const existing = new Set(existingPaths);
    return [...requestedPaths].filter((path) => !existing.has(path));
}

/** Console keeps an empty folder as a `{ name, folder: true }` entry with no content; apify-client's type leaves it out. */
function isFolderEntry(file: ActorVersionSourceFile): boolean {
    return (file as { folder?: boolean }).folder === true;
}

function pullSourceFiles(
    sourceFiles: readonly ActorVersionSourceFile[],
    requestedPaths: ReadonlySet<string> | undefined,
): PulledFiles {
    const allFiles = sourceFiles.filter((file) => !isFolderEntry(file));
    const candidates = allFiles
        .filter((file) => !requestedPaths || requestedPaths.has(file.name))
        .map(({ name, format, content }): FileCandidate => {
            const encoding = format === 'BASE64' ? 'base64' : 'utf8';
            return {
                path: name,
                sizeBytes: Buffer.byteLength(content, encoding),
                contentBytes: Buffer.byteLength(content, 'utf8'),
                file: { path: name, content, encoding },
            };
        });
    return {
        ...applyInlineCap(candidates),
        notFoundPaths: listNotFoundPaths(
            requestedPaths,
            allFiles.map((file) => file.name),
        ),
        totalFiles: allFiles.length,
    };
}

type SourceRecordRef = { storeId: string; key: string };

/**
 * The store and key when `tarballUrl` is a key-value store record of the API this client talks to; undefined for any
 * other URL, which this tool never fetches. The query string (a store signature) is ignored: the token reads the record.
 */
function parseSourceRecordUrl(tarballUrl: string, apiBaseUrl: string): SourceRecordRef | undefined {
    if (!URL.canParse(tarballUrl)) return undefined;
    const url = new URL(tarballUrl);
    const match = SOURCE_RECORD_PATH_REGEX.exec(url.pathname);
    if (url.host !== new URL(apiBaseUrl).host || !match) return undefined;
    return { storeId: match[1], key: match[2] };
}

/** Rounded up, so a size just over a limit never prints as the limit itself. */
function formatMib(bytes: number): string {
    return (Math.ceil((bytes / BYTES_PER_MIB) * 10) / 10).toFixed(1);
}

/**
 * Downloads the zip record. Its size comes from the key listing first, so an oversized zip is refused before any of
 * it is downloaded; throws `UserInputError` for a missing record and for an oversized one.
 */
async function fetchSourceArchive(client: ApifyClient, { storeId, key }: SourceRecordRef): Promise<Uint8Array> {
    const store = client.keyValueStore(storeId);
    const missingText = `The version points at record ${key} in key-value store ${storeId}, which does not exist.`;
    const keys = await catchNotFound(store.listKeys({ prefix: key }));
    const item = keys?.items.find((entry) => entry.key === key);
    if (!item) throw new UserInputError(missingText);
    if (item.size > MAX_SOURCE_ARCHIVE_BYTES) {
        throw new UserInputError(
            `The version's zip is ${formatMib(item.size)} MiB, over the ${MAX_SOURCE_ARCHIVE_BYTES / BYTES_PER_MIB} MiB this tool reads; pull it with the Apify CLI (apify pull) instead.`,
        );
    }
    const record = await store.getRecord(key, { buffer: true });
    if (!record) throw new UserInputError(missingText);
    return record.value;
}

/** Base64 text takes 4 characters per 3 bytes, the last group padded. */
function getBase64Length(byteLength: number): number {
    return Math.ceil(byteLength / 3) * 4;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
    try {
        return UTF8_DECODER.decode(bytes);
    } catch {
        // The decoder is fatal: bytes that are not UTF-8 throw instead of turning into replacement characters.
        return undefined;
    }
}

/** Text when the extension is not a binary one and the bytes are valid UTF-8; base64 otherwise, so no byte is lost. */
function toPulledFile(path: string, bytes: Uint8Array): PulledFile {
    const text = hasBinaryExtension(path) ? undefined : decodeUtf8(bytes);
    if (text !== undefined) return { path, content: text, encoding: 'utf8' };
    return { path, content: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
}

function unzipSourceArchive(zip: Uint8Array, filter: UnzipFileFilter): Unzipped {
    try {
        return unzipSync(zip, { filter });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new UserInputError(`The version's zip could not be read: ${reason}.`);
    }
}

/**
 * Lists every file entry of the zip but decompresses only the requested ones that fit in what the entries before them
 * left of the cap, so memory goes to the files returned only. The fit is judged on the size a file takes in the
 * response, base64 for a binary extension. A file that turns out not to be UTF-8 grows to base64 once read, and
 * `applyInlineCap` then leaves it out if it no longer fits. The budget it held is not handed back: a later file the
 * filter skipped stays in omittedFiles, to be read with paths, rather than the zip being decompressed a second time.
 */
function pullArchiveFiles(zip: Uint8Array, requestedPaths: ReadonlySet<string> | undefined): PulledFiles {
    const allPaths: string[] = [];
    const entries: Omit<FileCandidate, 'file'>[] = [];
    let remainingBytes = MAX_INLINE_BYTES;
    const contents = unzipSourceArchive(zip, ({ name, originalSize }) => {
        if (name.endsWith('/')) return false;
        allPaths.push(name);
        if (requestedPaths && !requestedPaths.has(name)) return false;
        const contentBytes = hasBinaryExtension(name) ? getBase64Length(originalSize) : originalSize;
        entries.push({ path: name, sizeBytes: originalSize, contentBytes });
        if (contentBytes > remainingBytes) return false;
        remainingBytes -= contentBytes;
        return true;
    });
    const candidates = entries.map((entry): FileCandidate => {
        const bytes: Uint8Array | undefined = contents[entry.path];
        if (!bytes) return { ...entry, file: undefined };
        const file = toPulledFile(entry.path, bytes);
        return { ...entry, contentBytes: Buffer.byteLength(file.content, 'utf8'), file };
    });
    return {
        ...applyInlineCap(candidates),
        notFoundPaths: listNotFoundPaths(requestedPaths, allPaths),
        totalFiles: allPaths.length,
    };
}

function formatFileCount(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function formatOmittedNote({ omittedFiles, tooLargePaths }: PulledFiles): string {
    if (omittedFiles.length === 0) return '';
    // `tooLargePaths` are all omitted; when they are the only ones, another call with paths cannot return anything.
    const retryHint =
        omittedFiles.length > tooLargePaths.length ? '; call this tool again with their paths to read them' : '';
    const note = ` Left out to keep the response within ${INLINE_LIMIT_KIB} KiB: ${formatFileCount(omittedFiles.length)}, listed in omittedFiles${retryHint}.`;
    if (tooLargePaths.length === 0) return note;
    return `${note} Too large for this tool even on their own: ${tooLargePaths.join(', ')}; read those with the Apify CLI (apify pull).`;
}

function formatNotFoundNote(notFoundPaths: readonly string[]): string {
    return notFoundPaths.length > 0 ? ` The version has no file at: ${notFoundPaths.join(', ')}.` : '';
}

/** push-actor merges only into a version that stores its files inline; a zip-stored one is replaced as a whole. */
function buildPushBackStep(sourceType: ActorSourceType, loadedToolNames: readonly string[]): string {
    const hasPushTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_PUSH);
    if (sourceType === ActorSourceType.SourceFiles) {
        return hasPushTool
            ? `Edit the files and push them back with ${HELPER_TOOLS.ACTOR_PUSH}; mode merge sends only the edited files.`
            : 'Edit the files and push them back to this version.';
    }
    return hasPushTool
        ? `Edit the files and push them back with ${HELPER_TOOLS.ACTOR_PUSH} and mode replace, sending all files; a version stored as a zip cannot be merged into.`
        : 'Edit the files and push all of them back to this version; a version stored as a zip is replaced as a whole.';
}

function respondWithSummary(
    structuredContent: Record<string, unknown>,
    summary: string,
    nextStep: string,
): ToolResponse {
    return respondOk([JSON.stringify(structuredContent), `${summary}\n${nextStep}`], { structuredContent });
}

function respondWithFiles(params: {
    target: PullTarget;
    sourceType: ActorSourceType;
    pulled: PulledFiles;
    loadedToolNames: readonly string[];
}): ToolResponse {
    const { target, sourceType, pulled, loadedToolNames } = params;
    const structuredContent = {
        ...target,
        sourceType,
        files: pulled.files,
        ...(pulled.omittedFiles.length > 0 && { omittedFiles: pulled.omittedFiles }),
        ...(pulled.notFoundPaths.length > 0 && { notFoundPaths: pulled.notFoundPaths }),
    };
    const summary = `Pulled ${pulled.files.length} of ${formatFileCount(pulled.totalFiles)} of ${target.actorName} version ${target.versionNumber}.${formatOmittedNote(pulled)}${formatNotFoundNote(pulled.notFoundPaths)}`;
    return respondWithSummary(structuredContent, summary, buildPushBackStep(sourceType, loadedToolNames));
}

/**
 * Said up front because the switch is silent: push-actor with mode replace turns a version built from elsewhere into
 * one built from files hosted on Apify.
 */
function formatDetachWarning(sourceName: string, loadedToolNames: readonly string[]): string {
    const push = loadedToolNames.includes(HELPER_TOOLS.ACTOR_PUSH)
        ? `Pushing files with ${HELPER_TOOLS.ACTOR_PUSH} and mode replace`
        : 'Pushing files to this version';
    return `${push} would switch the version to files hosted on Apify, and it would stop building from ${sourceName}.`;
}

/** The API returns only the number, type and build tag of a version whose source it hides from this account. */
function buildHiddenSourceText({ actorName, versionNumber }: PullTarget): string {
    return `Version ${versionNumber} of ${actorName} came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.`;
}

type PullVersionParams = {
    client: ApifyClient;
    target: PullTarget;
    version: ActorVersion;
    requestedPaths: ReadonlySet<string> | undefined;
    loadedToolNames: readonly string[];
};

/** Throws `UserInputError` for a hidden source and for a zip that is missing, oversized or unreadable. */
async function pullVersion(params: PullVersionParams): Promise<ToolResponse> {
    const { client, target, version, requestedPaths, loadedToolNames } = params;
    const { actorName, versionNumber } = target;
    const { sourceType } = version;
    if (version.sourceType === ActorSourceType.SourceFiles) {
        if (!version.sourceFiles) throw new UserInputError(buildHiddenSourceText(target));
        const pulled = pullSourceFiles(version.sourceFiles, requestedPaths);
        return respondWithFiles({ target, sourceType, pulled, loadedToolNames });
    }
    if (version.sourceType === ActorSourceType.Tarball) {
        const { tarballUrl } = version;
        if (!tarballUrl) throw new UserInputError(buildHiddenSourceText(target));
        const recordRef = parseSourceRecordUrl(tarballUrl, client.baseUrl);
        if (!recordRef) {
            return respondWithSummary(
                { ...target, sourceType, tarballUrl },
                `Version ${versionNumber} of ${actorName} builds from the zip at ${tarballUrl}, which this tool does not download.`,
                `Download and unzip it in your sandbox. ${formatDetachWarning('this zip', loadedToolNames)}`,
            );
        }
        const pulled = pullArchiveFiles(await fetchSourceArchive(client, recordRef), requestedPaths);
        return respondWithFiles({ target, sourceType, pulled, loadedToolNames });
    }
    if (version.sourceType === ActorSourceType.GitRepo) {
        const { gitRepoUrl } = version;
        if (!gitRepoUrl) throw new UserInputError(buildHiddenSourceText(target));
        return respondWithSummary(
            { ...target, sourceType, gitRepoUrl },
            `Version ${versionNumber} of ${actorName} builds from the Git repository ${gitRepoUrl}, so no files are returned; a #branch:subdirectory suffix names the branch and the directory in it.`,
            `Clone the repository in your sandbox and commit there. ${formatDetachWarning('the repository', loadedToolNames)}`,
        );
    }
    const { gitHubGistUrl } = version;
    if (!gitHubGistUrl) throw new UserInputError(buildHiddenSourceText(target));
    return respondWithSummary(
        { ...target, sourceType, gitHubGistUrl },
        `Version ${versionNumber} of ${actorName} builds from the GitHub gist ${gitHubGistUrl}, so no files are returned.`,
        `Clone the gist in your sandbox and commit there. ${formatDetachWarning('the gist', loadedToolNames)}`,
    );
}

/**
 * https://docs.apify.com/api/v2/act-get
 *  /v2/acts/{actorId}
 * https://docs.apify.com/api/v2/act-version-get
 *  /v2/acts/{actorId}/versions/{versionNumber}
 * https://docs.apify.com/api/v2/key-value-store-keys-get
 *  /v2/key-value-stores/{storeId}/keys
 * https://docs.apify.com/api/v2/key-value-store-record-get
 *  /v2/key-value-stores/{storeId}/records/{recordKey}
 *
 * The counterpart of push-actor: returns a version's files in the shape push-actor takes, so pull, edit, push is a
 * round trip. A zip is read only from a key-value store record of this API, never from an arbitrary URL, and a Git
 * repository or gist is reported, not cloned. Resolves apify/apify-mcp-server#1427.
 */
export const pullActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_PULL,
    title: 'Pull Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(pullActorArgs) as ToolInputSchema,
    outputSchema: pullActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(pullActorArgs)),
    annotations: {
        title: 'Pull Actor',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, loadedToolNames } = toolArgs;
        const parsed = pullActorArgs.parse(args);
        try {
            const actor = await client.actor(parsed.actor).get();
            if (!actor) return respondUserError(`Actor '${parsed.actor}' not found.`);
            const versionNumber = resolveVersionNumber(actor, parsed.versionNumber, parsed.actor);
            const version = await client.actor(actor.id).version(versionNumber).get();
            if (!version) return respondUserError(`Actor '${parsed.actor}' has no version ${versionNumber}.`);
            return await pullVersion({
                client,
                target: { actorId: actor.id, actorName: `${actor.username}/${actor.name}`, versionNumber },
                version,
                requestedPaths: parsed.paths ? new Set(parsed.paths) : undefined,
                loadedToolNames,
            });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            // A token scoped away from the Actor or its source store.
            if (error instanceof ApifyApiError && error.statusCode === 403) {
                return respondUserError(error.message, { category: FAILURE_CATEGORY.AUTH, httpStatus: 403 });
            }
            throw error;
        }
    },
} as const);
