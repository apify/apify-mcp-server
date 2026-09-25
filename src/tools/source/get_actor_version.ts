import type { Actor, ActorVersion, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
import { listVersionNumbers } from '../builds/build_helpers.js';
import { catchNotFound } from '../storage/storage_helpers.js';
import { getActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { readSourceArchive } from './source_archive.js';
import type { SourceFile } from './source_files.js';
import {
    buildArchiveSourceFile,
    buildFilesRevision,
    buildInlineSourceFile,
    buildUrlRevision,
    compareSourcePaths,
} from './source_files.js';

const INLINE_LIMIT_KIB = MAX_INLINE_BYTES / 1024;

const BYTES_PER_MIB = 1024 * 1024;

const MAX_REQUESTED_PATHS = 100;

/**
 * A zip over this size is refused before it is downloaded: reading it holds the whole archive in memory, while the
 * response carries at most `MAX_INLINE_BYTES` of its content.
 */
const MAX_SOURCE_ARCHIVE_BYTES = 50 * BYTES_PER_MIB;

/** The path of the record URL `apify push` points a zip-stored version at. */
const SOURCE_RECORD_PATH_REGEX = /^\/v2\/key-value-stores\/([^/]+)\/records\/([^/]+)$/;

const getActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to read: its ID, or its full name as username/name or username~name. A name without the username is not enough.',
        ),
    // Format is not enforced by a regex: the lookup against the Actor's versions rejects anything that is not an
    // existing version with a soft fail.
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version to read in MAJOR.MINOR form, for example 0.1. Defaults to the only version when the Actor has exactly one.',
        ),
    paths: z
        .array(z.string().min(1))
        .max(MAX_REQUESTED_PATHS)
        .optional()
        .describe(
            `Files to return, relative to the Actor root, for example src/main.js; they fill the ${INLINE_LIMIT_KIB} KiB limit in this order. Omit to get every text file when they all fit; pass [] for the listing only.`,
        ),
    pathPrefix: z
        .string()
        .min(1)
        .optional()
        .describe('List and return only the files whose path starts with this, for example src/.'),
    startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to return, counting from 1. Only with exactly one path in paths.'),
    lineCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            `Number of lines to return from startLine; defaults to as many as fit in ${INLINE_LIMIT_KIB} KiB. Only with exactly one path in paths.`,
        ),
});

type GetActorVersionArgs = z.infer<typeof getActorVersionArgs>;

type VersionTarget = { actorId: string; fullName: string; versionNumber: string };

type ReturnedContent = {
    path: string;
    content: string;
    encoding: 'utf8' | 'base64';
    startLine?: number;
    endLine?: number;
    totalLines?: number;
};

type ContentSelection = {
    contents: ReturnedContent[];
    omittedPaths: string[];
    notFoundPaths: string[];
    /** The text files' total size, set when `paths` was omitted and they did not all fit. */
    textBytesOverLimit?: number;
    /** Base64 files left out because `paths` was omitted; they are returned only when named. */
    unnamedBinaryCount: number;
};

type SourceRecordRef = { storeId: string; key: string };

/** The requested version when the Actor has it, else the only version; throws `UserInputError` otherwise. */
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
        // The source type and build tag tell the caller which version holds the code it is after.
        const versions = actor.versions
            .filter((version) => version.versionNumber !== undefined)
            .map(({ versionNumber, sourceType, buildTag }) => {
                const tag = buildTag ? `, build tag ${buildTag}` : '';
                return `${versionNumber} (${sourceType}${tag})`;
            });
        throw new UserInputError(`Specify versionNumber; this Actor has versions: ${versions.join(', ')}.`);
    }
    return requestedVersionNumber ?? versionNumbers[0];
}

/**
 * The store and key when `tarballUrl` is a key-value store record of the API this client talks to; undefined for any
 * other URL, which this tool never fetches. The query string (a store signature) is ignored: the token reads the record.
 */
function parseSourceRecordUrl(tarballUrl: string, apiBaseUrl: string): SourceRecordRef | undefined {
    if (!URL.canParse(tarballUrl)) return undefined;
    const url = new URL(tarballUrl);
    const match = SOURCE_RECORD_PATH_REGEX.exec(url.pathname);
    if (url.host !== new URL(apiBaseUrl).host || !match) return undefined;
    try {
        return { storeId: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) };
    } catch {
        return undefined;
    }
}

/** Rounded up, so a size just over a limit never prints as the limit itself. */
function formatMib(bytes: number): string {
    return (Math.ceil((bytes / BYTES_PER_MIB) * 10) / 10).toFixed(1);
}

function formatKib(bytes: number): string {
    return (Math.ceil((bytes / 1024) * 10) / 10).toFixed(1);
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
    const tooLargeText = (sizeBytes: number) =>
        `The version's zip is ${formatMib(sizeBytes)} MiB, over the ${MAX_SOURCE_ARCHIVE_BYTES / BYTES_PER_MIB} MiB ` +
        'this tool reads; read it with the Apify CLI (apify pull) instead.';
    if (item.size > MAX_SOURCE_ARCHIVE_BYTES) throw new UserInputError(tooLargeText(item.size));
    const record = await store.getRecord(key, { buffer: true });
    if (!record) throw new UserInputError(missingText);
    // The record may have been replaced after the listing.
    if (record.value.length > MAX_SOURCE_ARCHIVE_BYTES) throw new UserInputError(tooLargeText(record.value.length));
    return record.value;
}

/** Console keeps an empty folder as a `{ name, folder: true }` entry with no content; apify-client's type leaves it out. */
function isFolderEntry(file: ActorVersionSourceFile): boolean {
    return (file as { folder?: boolean }).folder === true;
}

/** One file per path, sorted by path, so the manifest reads the same however the version stores its files. */
function sortSourceFiles(files: Iterable<SourceFile>): SourceFile[] {
    const filesByPath = new Map<string, SourceFile>();
    for (const file of files) filesByPath.set(file.path, file);
    return [...filesByPath.values()].sort((a, b) => compareSourcePaths(a.path, b.path));
}

function toReturnedContent(file: SourceFile): ReturnedContent {
    return { path: file.path, content: file.readContent(), encoding: file.format === 'BASE64' ? 'base64' : 'utf8' };
}

/** Lines with their line endings kept, so joined back they give the exact text. */
function splitLines(text: string): string[] {
    if (text === '') return [];
    return text.split(/(?<=\n)/);
}

/**
 * The lines from `startLine`, up to `lineCount` of them and as many as fit in `MAX_INLINE_BYTES`. Throws
 * `UserInputError` when `startLine` is past the end, and when that line alone does not fit.
 */
function readLineRange(file: SourceFile, startLine: number, lineCount: number | undefined): ReturnedContent {
    const lines = splitLines(file.readContent());
    const totalLines = lines.length;
    if (startLine > totalLines) {
        throw new UserInputError(`${file.path} has ${totalLines} lines, so startLine ${startLine} is past its end.`);
    }
    const lastWantedIndex = Math.min(totalLines, lineCount === undefined ? totalLines : startLine - 1 + lineCount);
    const selectedLines: string[] = [];
    let totalBytes = 0;
    for (let index = startLine - 1; index < lastWantedIndex; index++) {
        const lineBytes = Buffer.byteLength(lines[index], 'utf8');
        if (totalBytes + lineBytes > MAX_INLINE_BYTES) break;
        selectedLines.push(lines[index]);
        totalBytes += lineBytes;
    }
    if (selectedLines.length === 0) {
        throw new UserInputError(
            `Line ${startLine} of ${file.path} alone is over ${INLINE_LIMIT_KIB} KiB, so this tool cannot return it.`,
        );
    }
    return {
        path: file.path,
        content: selectedLines.join(''),
        encoding: 'utf8',
        startLine,
        endLine: startLine + selectedLines.length - 1,
        totalLines,
    };
}

function buildEmptySelection(): ContentSelection {
    return { contents: [], omittedPaths: [], notFoundPaths: [], unnamedBinaryCount: 0 };
}

/** Every text file, or none when they do not all fit: a partial set would let one large file crowd out the rest. */
function selectAllTextContents(view: readonly SourceFile[]): ContentSelection {
    const textFiles = view.filter((file) => file.format === 'TEXT');
    const textBytes = textFiles.reduce((total, file) => total + file.contentBytes, 0);
    const unnamedBinaryCount = view.length - textFiles.length;
    if (textBytes > MAX_INLINE_BYTES) {
        return { ...buildEmptySelection(), textBytesOverLimit: textBytes, unnamedBinaryCount };
    }
    return { ...buildEmptySelection(), contents: textFiles.map(toReturnedContent), unnamedBinaryCount };
}

/**
 * The named files in order while they fit; a file that does not fit goes to `omittedPaths` and the files after it
 * still get their turn. A single text file over the limit returns its first lines instead of nothing.
 */
function selectRequestedContents(view: readonly SourceFile[], paths: readonly string[]): ContentSelection {
    const filesByPath = new Map(view.map((file) => [file.path, file]));
    const requestedPaths = [...new Set(paths)];
    const onlyFile = requestedPaths.length === 1 ? filesByPath.get(requestedPaths[0]) : undefined;
    if (onlyFile?.format === 'TEXT' && onlyFile.contentBytes > MAX_INLINE_BYTES) {
        return { ...buildEmptySelection(), contents: [readLineRange(onlyFile, 1, undefined)] };
    }
    const selection = buildEmptySelection();
    let remainingBytes = MAX_INLINE_BYTES;
    for (const path of requestedPaths) {
        const file = filesByPath.get(path);
        if (!file) {
            selection.notFoundPaths.push(path);
            continue;
        }
        if (file.contentBytes > remainingBytes) {
            selection.omittedPaths.push(path);
            continue;
        }
        selection.contents.push(toReturnedContent(file));
        remainingBytes -= file.contentBytes;
    }
    return selection;
}

function selectContents(view: readonly SourceFile[], args: GetActorVersionArgs): ContentSelection {
    const { paths, startLine, lineCount } = args;
    if (paths === undefined) return selectAllTextContents(view);
    if (startLine === undefined && lineCount === undefined) return selectRequestedContents(view, paths);
    // The call checks that a line range comes with exactly one path.
    const file = view.find((candidate) => candidate.path === paths[0]);
    if (!file) return { ...buildEmptySelection(), notFoundPaths: [paths[0]] };
    if (file.format === 'BASE64') {
        throw new UserInputError(
            `${file.path} is stored as base64, and startLine and lineCount work only on text files.`,
        );
    }
    return { ...buildEmptySelection(), contents: [readLineRange(file, startLine ?? 1, lineCount)] };
}

function formatFileCount(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function formatContentNote(selection: ContentSelection, args: GetActorVersionArgs): string {
    const [first] = selection.contents;
    if (first?.startLine !== undefined && first.endLine !== undefined && first.totalLines !== undefined) {
        const wholeFileNote =
            args.startLine === undefined && args.lineCount === undefined
                ? ` The whole file is over the ${INLINE_LIMIT_KIB} KiB limit.`
                : '';
        const continueNote = first.endLine < first.totalLines ? ` Continue with startLine ${first.endLine + 1}.` : '';
        return ` Returned lines ${first.startLine}-${first.endLine} of ${first.totalLines} of ${first.path}.${wholeFileNote}${continueNote}`;
    }
    if (selection.contents.length > 0) {
        const bytes = selection.contents.reduce((total, { content }) => total + Buffer.byteLength(content, 'utf8'), 0);
        return ` Returned the content of ${formatFileCount(selection.contents.length)} (${formatKib(bytes)} KiB).`;
    }
    if (selection.textBytesOverLimit !== undefined) {
        return (
            ` Returned the listing only: the text files total ${formatKib(selection.textBytesOverLimit)} KiB, over ` +
            `the ${INLINE_LIMIT_KIB} KiB limit. Pass paths or pathPrefix to read some of them.`
        );
    }
    return ' Returned the listing only.';
}

function formatOmittedNote(selection: ContentSelection, view: readonly SourceFile[]): string {
    if (selection.omittedPaths.length === 0) return '';
    const filesByPath = new Map(view.map((file) => [file.path, file]));
    const tooLarge = selection.omittedPaths.filter(
        (path) => (filesByPath.get(path)?.contentBytes ?? 0) > MAX_INLINE_BYTES,
    );
    const fitAlone = selection.omittedPaths.filter((path) => !tooLarge.includes(path));
    const tooLargeText = tooLarge.filter((path) => filesByPath.get(path)?.format === 'TEXT');
    const tooLargeBinary = tooLarge.filter((path) => filesByPath.get(path)?.format === 'BASE64');
    const notes = [
        fitAlone.length > 0 &&
            ` Left out to stay within ${INLINE_LIMIT_KIB} KiB: ${fitAlone.join(', ')}; request them in another call.`,
        tooLargeText.length > 0 &&
            ` Over ${INLINE_LIMIT_KIB} KiB on their own: ${tooLargeText.join(', ')}; request one alone to read it in line ranges.`,
        tooLargeBinary.length > 0 &&
            ` Over ${INLINE_LIMIT_KIB} KiB as base64, so they cannot be returned: ${tooLargeBinary.join(', ')}.`,
    ];
    return notes.filter(Boolean).join('');
}

function formatSelectionSummary(params: {
    headline: string;
    selection: ContentSelection;
    view: readonly SourceFile[];
    args: GetActorVersionArgs;
}): string {
    const { headline, selection, view, args } = params;
    const { unnamedBinaryCount, notFoundPaths } = selection;
    const binaryNote =
        unnamedBinaryCount > 0
            ? unnamedBinaryCount === 1
                ? ' 1 base64 file is in the listing only; name it in paths to read it.'
                : ` ${unnamedBinaryCount} base64 files are in the listing only; name them in paths to read them.`
            : '';
    const underPrefix = args.pathPrefix === undefined ? '' : ` under ${args.pathPrefix}`;
    const notFoundNote = notFoundPaths.length > 0 ? ` No file${underPrefix} at: ${notFoundPaths.join(', ')}.` : '';
    return `${headline}${formatContentNote(selection, args)}${binaryNote}${formatOmittedNote(selection, view)}${notFoundNote}`;
}

function formatEnvVars(version: ActorVersion): { name: string; isSecret: boolean }[] {
    // Values never go out: non-secret ones would come back in plain text, and secrets as their hash.
    return (version.envVars ?? []).flatMap(({ name, isSecret }) =>
        name === undefined ? [] : [{ name, isSecret: isSecret === true }],
    );
}

/** `repo#branch:directory`, the form the platform takes a Git source in; the branch and directory are optional. */
function parseGitRepoUrl(gitRepoUrl: string): { repository: string; branch?: string; directory?: string } {
    const hashIndex = gitRepoUrl.indexOf('#');
    if (hashIndex === -1) return { repository: gitRepoUrl };
    const fragment = gitRepoUrl.slice(hashIndex + 1);
    const colonIndex = fragment.indexOf(':');
    const branch = colonIndex === -1 ? fragment : fragment.slice(0, colonIndex);
    const directory = colonIndex === -1 ? '' : fragment.slice(colonIndex + 1);
    return {
        repository: gitRepoUrl.slice(0, hashIndex),
        ...(branch !== '' && { branch }),
        ...(directory !== '' && { directory }),
    };
}

/** The query string of a zip URL can hold a signature that grants access to it, so it never goes out. */
function stripQueryString(url: string): string {
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) return url;
    const hashIndex = url.indexOf('#', queryIndex);
    return url.slice(0, queryIndex) + (hashIndex === -1 ? '' : url.slice(hashIndex));
}

/** The API returns only the number, type, and build tag of a version whose source it hides from this account. */
function buildHiddenSourceText({ fullName, versionNumber }: VersionTarget): string {
    return `Version ${versionNumber} of ${fullName} came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.`;
}

function respondWithSummary(structuredContent: Record<string, unknown>, summary: string): ToolResponse {
    return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
}

type ReadVersionParams = {
    client: ApifyClient;
    target: VersionTarget;
    version: ActorVersion;
    args: GetActorVersionArgs;
};

function buildVersionFields({ target, version }: Pick<ReadVersionParams, 'target' | 'version'>) {
    return {
        ...target,
        sourceType: version.sourceType as string,
        ...(version.buildTag ? { buildTag: version.buildTag } : {}),
    };
}

function respondWithFiles(params: ReadVersionParams & { files: SourceFile[]; storageLabel: string }): ToolResponse {
    const { target, version, args, storageLabel } = params;
    const files = sortSourceFiles(params.files);
    const revision = buildFilesRevision(files);
    const { pathPrefix } = args;
    const view = pathPrefix === undefined ? files : files.filter((file) => file.path.startsWith(pathPrefix));
    const selection = selectContents(view, args);
    const structuredContent = {
        ...buildVersionFields({ target, version }),
        revision,
        files: view.map(({ path, sizeBytes, hash, format }) => ({ path, sizeBytes, hash, format })),
        contents: selection.contents,
        ...(selection.omittedPaths.length > 0 && { omittedPaths: selection.omittedPaths }),
        ...(selection.notFoundPaths.length > 0 && { notFoundPaths: selection.notFoundPaths }),
        envVars: formatEnvVars(version),
    };
    const fileCount =
        pathPrefix === undefined
            ? formatFileCount(files.length)
            : `${view.length} of ${formatFileCount(files.length)} under ${pathPrefix}`;
    const headline = `Read version ${target.versionNumber} of ${target.fullName}, ${storageLabel}: ${fileCount}, revision ${revision}.`;
    return respondWithSummary(structuredContent, formatSelectionSummary({ headline, selection, view, args }));
}

/** A version whose source is only a URL: no files, and a revision over the URL. */
function respondWithUrl(
    params: Pick<ReadVersionParams, 'target' | 'version'> & {
        url: string;
        urlFields: Record<string, string>;
        sourceText: string;
    },
): ToolResponse {
    const { target, version, url, urlFields, sourceText } = params;
    const revision = buildUrlRevision(version.sourceType, url);
    const structuredContent = {
        ...buildVersionFields({ target, version }),
        revision,
        files: [],
        contents: [],
        envVars: formatEnvVars(version),
        ...urlFields,
    };
    const summary = `Version ${target.versionNumber} of ${target.fullName} builds from ${sourceText}, revision ${revision}. Its source is not stored on Apify, and nothing outside the Apify API is fetched, so no files are returned.`;
    return respondWithSummary(structuredContent, summary);
}

/** Throws `UserInputError` for a hidden or unsupported source and for a zip that is missing, oversized or refused. */
async function readVersion(params: ReadVersionParams): Promise<ToolResponse> {
    const { client, target, version } = params;
    // The API's legacy SOURCE_CODE type and any type added later are not in apify-client's enum.
    const { sourceType }: { sourceType: string } = version;
    if (version.sourceType === ActorSourceType.SourceFiles) {
        if (!version.sourceFiles) throw new UserInputError(buildHiddenSourceText(target));
        const files = version.sourceFiles.filter((file) => !isFolderEntry(file)).map(buildInlineSourceFile);
        return respondWithFiles({ ...params, files, storageLabel: 'stored inline (SOURCE_FILES)' });
    }
    if (version.sourceType === ActorSourceType.Tarball) {
        if (!version.tarballUrl) throw new UserInputError(buildHiddenSourceText(target));
        const recordRef = parseSourceRecordUrl(version.tarballUrl, client.baseUrl);
        if (!recordRef) {
            const tarballUrl = stripQueryString(version.tarballUrl);
            return respondWithUrl({
                target,
                version,
                url: tarballUrl,
                urlFields: { tarballUrl },
                sourceText: `the zip at ${tarballUrl}, which is not a key-value store record of this Apify API`,
            });
        }
        const archive = readSourceArchive(await fetchSourceArchive(client, recordRef));
        const files = [...archive].map(([path, bytes]) => buildArchiveSourceFile(path, bytes));
        const storageLabel = `stored as a zip in key-value store ${recordRef.storeId} (TARBALL)`;
        return respondWithFiles({ ...params, files, storageLabel });
    }
    if (version.sourceType === ActorSourceType.GitRepo) {
        if (!version.gitRepoUrl) throw new UserInputError(buildHiddenSourceText(target));
        const { gitRepoUrl } = version;
        const git = parseGitRepoUrl(gitRepoUrl);
        const branch = git.branch === undefined ? '' : `, branch ${git.branch}`;
        const directory = git.directory === undefined ? '' : `, directory ${git.directory}`;
        return respondWithUrl({
            target,
            version,
            url: gitRepoUrl,
            urlFields: { gitRepoUrl, ...git },
            sourceText: `the Git repository ${git.repository}${branch}${directory}`,
        });
    }
    if (version.sourceType === ActorSourceType.GitHubGist) {
        if (!version.gitHubGistUrl) throw new UserInputError(buildHiddenSourceText(target));
        const { gitHubGistUrl } = version;
        return respondWithUrl({
            target,
            version,
            url: gitHubGistUrl,
            urlFields: { gitHubGistUrl },
            sourceText: `the GitHub gist ${gitHubGistUrl}`,
        });
    }
    throw new UserInputError(
        `Version ${target.versionNumber} of ${target.fullName} has source type ${sourceType}, which this tool does not support. Open the version in Apify Console to see its source.`,
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
 * The output is the same for a version stored inline and one stored as a zip, and the hashes and the revision do not
 * depend on the storage, so a caller can compare them across reads. A zip is read only from a key-value store record
 * of this API, never from an arbitrary URL, and a Git repository or gist is reported, not cloned.
 */
export const getActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_GET,
    title: 'Get Actor version',
    description: dedent`
        Read an Actor version's source: its metadata, a revision, a listing of its files with sizes and hashes, and the content of the files you ask for.
        Read-only. Works on any Actor your token can read. Content is raw, with no line numbers: text as utf8, binary files as base64. One call returns at most ${INLINE_LIMIT_KIB} KiB of content.
        - Without paths: the listing, plus every text file if all of them together fit in ${INLINE_LIMIT_KIB} KiB; otherwise the listing only.
        - paths: [] returns the listing only, the cheap way to get the revision and the hashes.
        - With paths: those files, in that order, within the limit; the rest are named in omittedPaths or notFoundPaths. Base64 files are returned only when named.
        - For a large text file, pass its path alone with startLine and lineCount. A text file over the limit requested alone returns the lines that fit, with endLine and totalLines, to continue from.
        - hash is the first 16 hex characters of the SHA-256 of the file's bytes, the same as sha256sum <file> | cut -c1-16. revision identifies the whole file set and changes when any file changes.
        A version built from a Git repository, a GitHub gist, or a zip at an outside URL returns only that URL: nothing outside the Apify API is fetched. Environment variables come back as names and isSecret only, never their values.
        Omit versionNumber to read the only version; an Actor with several versions needs it.

        USAGE:
        - Use to read an Actor's code before changing it, or to check which files changed since an earlier read.

        USAGE EXAMPLES:
        - user_input: Show me the source code of john/my-scraper
        - user_input: What does src/main.js of my Actor E2jjCZBezvAZnX8Rb do?`,
    inputSchema: z.toJSONSchema(getActorVersionArgs) as ToolInputSchema,
    outputSchema: getActorVersionToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorVersionArgs)),
    annotations: {
        title: 'Get Actor version',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getActorVersionArgs.parse(args);
        if ((parsed.startLine !== undefined || parsed.lineCount !== undefined) && parsed.paths?.length !== 1) {
            return respondUserError('startLine and lineCount need exactly one path in paths.');
        }
        try {
            // apify-client turns username/name into the API's username~name.
            const actor = await client.actor(parsed.actor).get();
            // Extra path segments, such as username/name/runs/last, reach a sub-resource that is not an Actor.
            if (!actor || typeof actor.name !== 'string' || typeof actor.username !== 'string') {
                return respondUserError(
                    `Actor '${parsed.actor}' not found. Give its ID or its full name, username/name; ` +
                        'a name without the username is not enough.',
                );
            }
            const fullName = `${actor.username}/${actor.name}`;
            const versionNumber = resolveVersionNumber(actor, parsed.versionNumber, parsed.actor);
            const version = await client.actor(actor.id).version(versionNumber).get();
            if (!version) return respondUserError(`Actor '${parsed.actor}' has no version ${versionNumber}.`);
            return await readVersion({
                client,
                target: { actorId: actor.id, fullName, versionNumber },
                version,
                args: parsed,
            });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            // For example a token scoped away from the Actor or its source store; respondServerError records a
            // 401 or 403 as AUTH and any other 4xx as INVALID_INPUT.
            if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                return respondServerError(error.message, { error });
            }
            throw error;
        }
    },
} as const);
