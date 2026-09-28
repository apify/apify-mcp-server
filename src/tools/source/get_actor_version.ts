import type { Actor, ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
import { listVersionNumbers } from '../builds/build_helpers.js';
import { getActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import type { SourceFile } from './source_files.js';
import { buildFilesManifest, buildFilesRevision, buildUrlRevision, formatKib } from './source_files.js';

const INLINE_LIMIT_KIB = MAX_INLINE_BYTES / 1024;

const MAX_REQUESTED_PATHS = 100;

/** The path of the record URL `apify push` points a zip-stored version at. */
const SOURCE_RECORD_PATH_REGEX = /^\/v2\/key-value-stores\/[^/]+\/records\/[^/]+$/;

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

/** A line over `MAX_INLINE_BYTES` on its own, the first line of a range that returned nothing. */
type LongLineInfo = { path: string; line: number; totalLines: number };

type ContentSelection = {
    contents: ReturnedContent[];
    omittedFiles: SourceFile[];
    notFoundPaths: string[];
    /** The text files' total size, set when `paths` was omitted and they did not all fit. */
    textBytesOverLimit?: number;
    /** Base64 files left out because `paths` was omitted; they are returned only when named. */
    unnamedBinaryFiles: SourceFile[];
    longLine?: LongLineInfo;
};

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
 * Whether `tarballUrl` is a key-value store record of the API this client talks to, where `apify push` stores a zip;
 * any other URL is an outside zip, which this tool never fetches.
 */
function isSourceRecordUrl(tarballUrl: string, apiBaseUrl: string): boolean {
    if (!URL.canParse(tarballUrl)) return false;
    const url = new URL(tarballUrl);
    return url.host === new URL(apiBaseUrl).host && SOURCE_RECORD_PATH_REGEX.test(url.pathname);
}

function toReturnedContent(file: SourceFile): ReturnedContent {
    return { path: file.path, content: file.readContent(), encoding: file.encoding };
}

/** Lines with their line endings kept, so joined back they give the exact text. */
function splitLines(text: string): string[] {
    if (text === '') return [];
    return text.split(/(?<=\n)/);
}

function buildEmptySelection(): ContentSelection {
    return { contents: [], omittedFiles: [], notFoundPaths: [], unnamedBinaryFiles: [] };
}

/**
 * The lines from `startLine`, up to `lineCount` of them and as many as fit in `MAX_INLINE_BYTES`. When not even the
 * first line fits, it is over the limit on its own: the file goes to `omittedFiles` and the line is reported, so the
 * caller learns which startLine skips it. Throws `UserInputError` when `startLine` is past the end.
 */
function selectLineRange(file: SourceFile, startLine: number, lineCount: number | undefined): ContentSelection {
    const lines = splitLines(file.readContent());
    const totalLines = lines.length;
    if (startLine > totalLines) {
        throw new UserInputError(`${file.path} has ${totalLines} lines, so startLine ${startLine} is past its end.`);
    }
    const lastWantedIndex = Math.min(totalLines, lineCount === undefined ? totalLines : startLine - 1 + lineCount);
    const selectedLines: string[] = [];
    let totalBytes = 0;
    for (let index = startLine - 1; index < lastWantedIndex; index++) {
        totalBytes += Buffer.byteLength(lines[index], 'utf8');
        if (totalBytes > MAX_INLINE_BYTES) break;
        selectedLines.push(lines[index]);
    }
    if (selectedLines.length === 0) {
        const longLine = { path: file.path, line: startLine, totalLines };
        return { ...buildEmptySelection(), omittedFiles: [file], longLine };
    }
    const content: ReturnedContent = {
        path: file.path,
        content: selectedLines.join(''),
        encoding: 'utf8',
        startLine,
        endLine: startLine + selectedLines.length - 1,
        totalLines,
    };
    return { ...buildEmptySelection(), contents: [content] };
}

/** Every text file, or none when they do not all fit: a partial set would let one large file crowd out the rest. */
function selectAllTextContents(view: readonly SourceFile[]): ContentSelection {
    const textFiles = view.filter((file) => file.encoding === 'utf8');
    const textBytes = textFiles.reduce((total, file) => total + file.contentBytes, 0);
    const unnamedBinaryFiles = view.filter((file) => file.encoding === 'base64');
    if (textBytes > MAX_INLINE_BYTES) {
        return { ...buildEmptySelection(), textBytesOverLimit: textBytes, unnamedBinaryFiles };
    }
    return { ...buildEmptySelection(), contents: textFiles.map(toReturnedContent), unnamedBinaryFiles };
}

/**
 * The named files in order while they fit; a file that does not fit goes to `omittedFiles` and the files after it
 * still get their turn. A single text file over the limit returns its first lines instead of nothing.
 */
function selectRequestedContents(view: readonly SourceFile[], paths: readonly string[]): ContentSelection {
    const filesByPath = new Map(view.map((file) => [file.path, file]));
    const requestedPaths = [...new Set(paths)];
    const onlyFile = requestedPaths.length === 1 ? filesByPath.get(requestedPaths[0]) : undefined;
    if (onlyFile?.encoding === 'utf8' && onlyFile.contentBytes > MAX_INLINE_BYTES) {
        return selectLineRange(onlyFile, 1, undefined);
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
            selection.omittedFiles.push(file);
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
    if (file.encoding === 'base64') {
        throw new UserInputError(
            `${file.path} is returned as base64, and startLine and lineCount work only on text files.`,
        );
    }
    return selectLineRange(file, startLine ?? 1, lineCount);
}

function formatFileCount(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** The text summary of what was returned; the lists it names are also in the structured content. */
function buildSummary(headline: string, selection: ContentSelection, args: GetActorVersionArgs): string {
    const { contents, omittedFiles, notFoundPaths, textBytesOverLimit, unnamedBinaryFiles, longLine } = selection;
    const notes = [headline];
    const [first] = contents;
    if (first?.endLine !== undefined && first.totalLines !== undefined) {
        const continueNote = first.endLine < first.totalLines ? ` Continue with startLine ${first.endLine + 1}.` : '';
        notes.push(
            `Returned lines ${first.startLine}-${first.endLine} of ${first.totalLines} of ${first.path}.${continueNote}`,
        );
    } else if (contents.length > 0) {
        const bytes = contents.reduce((total, { content }) => total + Buffer.byteLength(content, 'utf8'), 0);
        notes.push(`Returned the content of ${formatFileCount(contents.length)} (${formatKib(bytes)} KiB).`);
    } else if (textBytesOverLimit !== undefined) {
        notes.push(
            `Returned the listing only: the text files total ${formatKib(textBytesOverLimit)} KiB, over the ` +
                `${INLINE_LIMIT_KIB} KiB limit. Pass paths or pathPrefix to read some of them.`,
        );
    } else {
        notes.push('Returned the listing only.');
    }
    if (longLine) {
        const skipNote = longLine.line < longLine.totalLines ? ` Pass startLine ${longLine.line + 1} to skip it.` : '';
        notes.push(
            `Line ${longLine.line} of ${longLine.path} is over ${INLINE_LIMIT_KIB} KiB on its own, so it cannot be returned.${skipNote}`,
        );
    }
    const tooLargeBinary = [...omittedFiles, ...unnamedBinaryFiles].filter(
        (file) => file.encoding === 'base64' && file.contentBytes > MAX_INLINE_BYTES,
    );
    const nameableBinaryCount = unnamedBinaryFiles.filter((file) => !tooLargeBinary.includes(file)).length;
    // The long line note already covers the file a line range left out.
    const leftOut = omittedFiles.filter((file) => file.path !== longLine?.path && !tooLargeBinary.includes(file));
    if (nameableBinaryCount > 0) {
        notes.push(
            `Base64 files are returned only when named in paths: ${formatFileCount(nameableBinaryCount)} left out.`,
        );
    }
    if (leftOut.length > 0) {
        notes.push(
            `Left out to stay within ${INLINE_LIMIT_KIB} KiB: ${leftOut.map(({ path }) => path).join(', ')}; request ` +
                'them in another call, and a text file over the limit on its own to read it in line ranges.',
        );
    }
    if (tooLargeBinary.length > 0) {
        notes.push(
            `Over ${INLINE_LIMIT_KIB} KiB as base64, so they cannot be returned: ${tooLargeBinary.map(({ path }) => path).join(', ')}.`,
        );
    }
    if (notFoundPaths.length > 0) {
        const underPrefix = args.pathPrefix === undefined ? '' : ` under ${args.pathPrefix}`;
        notes.push(`No file${underPrefix} at: ${notFoundPaths.join(', ')}.`);
    }
    return notes.join(' ');
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

/**
 * The URL without what can grant access to it, so that never goes out or into the revision: the query string (for
 * example a store signature) and, for http and https, the user and password. An SSH user such as `git@` is not a
 * secret and stays. A URL the parser cannot read, such as `git@github.com:user/repo.git`, loses only its query string.
 */
function formatUrlWithoutSecrets(url: string): string {
    if (URL.canParse(url)) {
        const parsed = new URL(url);
        parsed.search = '';
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            parsed.username = '';
            parsed.password = '';
        }
        return parsed.href;
    }
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
    apiBaseUrl: string;
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

function respondWithFiles(params: ReadVersionParams & { files: SourceFile[] }): ToolResponse {
    const { target, version, args, files } = params;
    const revision = buildFilesRevision(files);
    const { pathPrefix } = args;
    const view = pathPrefix === undefined ? files : files.filter((file) => file.path.startsWith(pathPrefix));
    const selection = selectContents(view, args);
    const structuredContent = {
        ...buildVersionFields({ target, version }),
        revision,
        files: view.map(({ path, sizeBytes, hash, format }) => ({ path, sizeBytes, hash, format })),
        contents: selection.contents,
        ...(selection.omittedFiles.length > 0 && { omittedPaths: selection.omittedFiles.map(({ path }) => path) }),
        ...(selection.notFoundPaths.length > 0 && { notFoundPaths: selection.notFoundPaths }),
        envVars: formatEnvVars(version),
    };
    const fileCount =
        pathPrefix === undefined
            ? formatFileCount(files.length)
            : `${view.length} of ${formatFileCount(files.length)} under ${pathPrefix}`;
    const headline = `Read version ${target.versionNumber} of ${target.fullName}, stored inline (SOURCE_FILES): ${fileCount}, revision ${revision}.`;
    return respondWithSummary(structuredContent, buildSummary(headline, selection, args));
}

/** A version whose source is only a URL: no files, and a revision over the URL. */
function respondWithUrl(
    params: Pick<ReadVersionParams, 'target' | 'version'> & {
        url: string;
        urlFields: Record<string, string>;
        sourceText: string;
        fetchNote: string;
    },
): ToolResponse {
    const { target, version, url, urlFields, sourceText, fetchNote } = params;
    const revision = buildUrlRevision(version.sourceType, url);
    const structuredContent = {
        ...buildVersionFields({ target, version }),
        revision,
        files: [],
        contents: [],
        envVars: formatEnvVars(version),
        ...urlFields,
    };
    const summary = `Version ${target.versionNumber} of ${target.fullName} builds from ${sourceText}, revision ${revision}. ${fetchNote}`;
    return respondWithSummary(structuredContent, summary);
}

const NOT_ON_APIFY_NOTE =
    'Its source is not stored on Apify, and nothing outside the Apify API is fetched, so no files are returned.';

/** Throws `UserInputError` for a hidden or unsupported source and for a version stored as a zip. */
function readVersion(params: ReadVersionParams): ToolResponse {
    const { apiBaseUrl, target, version } = params;
    // The API's legacy SOURCE_CODE type and any type added later are not in apify-client's enum.
    const { sourceType }: { sourceType: string } = version;
    if (version.sourceType === ActorSourceType.SourceFiles) {
        if (!version.sourceFiles) throw new UserInputError(buildHiddenSourceText(target));
        return respondWithFiles({ ...params, files: buildFilesManifest(version.sourceFiles) });
    }
    if (version.sourceType === ActorSourceType.Tarball) {
        if (!version.tarballUrl) throw new UserInputError(buildHiddenSourceText(target));
        if (isSourceRecordUrl(version.tarballUrl, apiBaseUrl)) {
            // TODO: Read versions stored as a zip. The plan is yauzl to read the zip (yazl to build zips in tests),
            // with our own caps on the zip size, the entry count, and the inflated size, refusing symbolic links and
            // encrypted entries, and with name rules: no absolute path, no '..' segment, no NUL, no name over 255
            // characters, and no path twice. The Apify API has no way to read single files of an Actor's source, so
            // returning even one file will download and unpack the whole zip; read only the files asked for once it can.
            throw new UserInputError(
                `Version ${target.versionNumber} of ${target.fullName} is stored as a zip (TARBALL), and versions ` +
                    'stored as a zip cannot be read with this tool yet. Open the version in Apify Console to see its source.',
            );
        }
        const tarballUrl = formatUrlWithoutSecrets(version.tarballUrl);
        return respondWithUrl({
            target,
            version,
            url: tarballUrl,
            urlFields: { tarballUrl },
            sourceText: `the zip at ${tarballUrl}`,
            fetchNote: 'This tool does not download zips, so no files are returned.',
        });
    }
    if (version.sourceType === ActorSourceType.GitRepo) {
        if (!version.gitRepoUrl) throw new UserInputError(buildHiddenSourceText(target));
        const gitRepoUrl = formatUrlWithoutSecrets(version.gitRepoUrl);
        const git = parseGitRepoUrl(gitRepoUrl);
        const branch = git.branch === undefined ? '' : `, branch ${git.branch}`;
        const directory = git.directory === undefined ? '' : `, directory ${git.directory}`;
        return respondWithUrl({
            target,
            version,
            url: gitRepoUrl,
            urlFields: { gitRepoUrl, ...git },
            sourceText: `the Git repository ${git.repository}${branch}${directory}`,
            fetchNote: NOT_ON_APIFY_NOTE,
        });
    }
    if (version.sourceType === ActorSourceType.GitHubGist) {
        if (!version.gitHubGistUrl) throw new UserInputError(buildHiddenSourceText(target));
        const gitHubGistUrl = formatUrlWithoutSecrets(version.gitHubGistUrl);
        return respondWithUrl({
            target,
            version,
            url: gitHubGistUrl,
            urlFields: { gitHubGistUrl },
            sourceText: `the GitHub gist ${gitHubGistUrl}`,
            fetchNote: NOT_ON_APIFY_NOTE,
        });
    }
    throw new UserInputError(
        `Version ${target.versionNumber} of ${target.fullName} has source type ${sourceType}, which this tool does not support. Open the version in Apify Console to see its source.`,
    );
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/actor-version-get
 *  /v2/actors/{actorId}/versions/{versionNumber}
 *
 * The hashes and the revision do not depend on the stored format, so a caller can compare them across reads. A
 * version stored as a zip is refused for now, a zip at an outside URL is reported, not fetched, and a Git repository
 * or gist is reported, not cloned.
 */
export const getActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_GET,
    title: 'Get Actor version',
    description: dedent`
        Read an Actor version's source: its metadata, a revision, a listing of its files with sizes and hashes, and the content of the files you ask for.
        Read-only. Works on any Actor your token can read, but the API hides the source of most Actors you cannot modify, and the call then fails with a message saying so. Content is raw, with no line numbers: text as utf8, binary files as base64. One call returns at most ${INLINE_LIMIT_KIB} KiB of content.
        - Without paths: the listing, plus every text file if all of them together fit in ${INLINE_LIMIT_KIB} KiB; otherwise the listing only.
        - paths: [] returns the listing only, the cheap way to get the revision and the hashes.
        - With paths: those files, in that order, within the limit; the rest are named in omittedPaths or notFoundPaths. Base64 files are returned only when named.
        - For a large text file, pass its path alone with startLine and lineCount. A text file over the limit requested alone returns the lines that fit, with endLine and totalLines, to continue from.
        - hash is the first 16 hex characters of the SHA-256 of the file's bytes, the same as sha256sum <file> | cut -c1-16 (shasum -a 256 on macOS). revision identifies the whole file set and changes when any file changes.
        A version built from a Git repository, a GitHub gist, or a zip at an outside URL returns only that URL: nothing outside the Apify API is fetched. A version stored as a zip on Apify cannot be read yet. Environment variables come back as names and isSecret only, never their values.
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
            // TODO: The version GET returns every stored file even when one is asked for: the Apify API has no way to
            // read or change single files of an Actor's source. Use such an API once it exists.
            const version = await client.actor(actor.id).version(versionNumber).get();
            if (!version) return respondUserError(`Actor '${parsed.actor}' has no version ${versionNumber}.`);
            return readVersion({
                apiBaseUrl: client.baseUrl,
                target: { actorId: actor.id, fullName, versionNumber },
                version,
                args: parsed,
            });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            // For example a token scoped away from the Actor; respondServerError records a
            // 401 or 403 as AUTH and any other 4xx as INVALID_INPUT.
            if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                return respondServerError(error.message, { error });
            }
            throw error;
        }
    },
} as const);
