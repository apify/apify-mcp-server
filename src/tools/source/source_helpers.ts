import { posix } from 'node:path';

import type { Actor, ActorVersion, ActorVersionSourceFile, Build } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { APIFY_ERROR_TYPE_TOO_FEW_VERSIONS, APIFY_ERROR_TYPE_VERSION_ALREADY_EXISTS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { ConsoleLinkContext, InternalToolArgs } from '../../types.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { logHttpError } from '../../utils/logging.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { ABORT } from '../actors/actor_run_response.js';
import {
    buildNextStepForBuild,
    listVersionNumbers,
    respondWithBuild,
    startBuild,
    toBuildResult,
} from '../builds/build_helpers.js';
import { hasBinaryExtension } from './source_files.js';

/** The input shape of one file sent whole. */
export const sourceFileArgs = z.object({
    path: z.string().min(1).describe('Path relative to the Actor root, for example src/main.js.'),
    content: z.string().describe('The whole file content: text as is, or base64 when encoding is base64.'),
    encoding: z
        .enum(['utf8', 'base64'])
        .optional()
        .describe(
            'utf8 for text, base64 for binary files. Defaults to base64 for binary extensions such as .png and to utf8 otherwise.',
        ),
});

/**
 * The Actor by its ID or full name, `username/name` or `username~name` (apify-client turns username/name into the
 * API's username~name); throws `UserInputError` when there is none.
 */
export async function fetchActor(
    client: ApifyClient,
    actorSelector: string,
): Promise<{ actor: Actor; fullName: string }> {
    const actor = await client.actor(actorSelector).get();
    // Extra path segments, such as username/name/runs/last, reach a sub-resource that is not an Actor.
    if (!actor || typeof actor.name !== 'string' || typeof actor.username !== 'string') {
        throw new UserInputError(
            `Actor '${actorSelector}' not found. Give its ID or its full name, username/name; a name without the username is not enough.`,
        );
    }
    return { actor, fullName: `${actor.username}/${actor.name}` };
}

/** The requested version, or the only one when none is requested; throws `UserInputError` otherwise. */
export function resolveVersion(
    actor: Pick<Actor, 'versions'>,
    requestedVersionNumber: string | undefined,
    actorSelector: string,
): ActorVersion & { versionNumber: string } {
    const versionNumbers = listVersionNumbers(actor);
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
    const versionNumber = requestedVersionNumber ?? versionNumbers[0];
    const version = actor.versions.find((candidate) => candidate.versionNumber === versionNumber);
    if (!version) {
        throw new UserInputError(
            `Actor '${actorSelector}' has no version ${versionNumber}; available versions: ${versionNumbers.join(', ')}.`,
        );
    }
    return { ...version, versionNumber };
}

/**
 * The URL without what can grant access to it: the query string, the password, and, for http and https, the user. An
 * SSH user such as `git@` is not a secret and stays. A URL the parser cannot read, such as
 * `git@github.com:user/repo.git`, loses only its query string.
 */
function formatUrlWithoutSecrets(url: string): string {
    if (URL.canParse(url)) {
        const parsed = new URL(url);
        parsed.search = '';
        parsed.password = '';
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            parsed.username = '';
        }
        return parsed.href;
    }
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) return url;
    const hashIndex = url.indexOf('#', queryIndex);
    return url.slice(0, queryIndex) + (hashIndex === -1 ? '' : url.slice(hashIndex));
}

/**
 * Why a version not stored as files is refused, and what to use instead. A version keeps the URL fields of a source
 * type it used before, so only the URL of its current type is named.
 */
function formatSourceTypeRefusal(version: ActorVersion, versionLabel: string): string {
    if (version.sourceType === ActorSourceType.GitRepo) {
        const url = version.gitRepoUrl ? ` ${formatUrlWithoutSecrets(version.gitRepoUrl)}` : '';
        return `${versionLabel} has its files in the Git repository${url}, not stored on Apify, so this tool cannot work on them; use the repository.`;
    }
    if (version.sourceType === ActorSourceType.GitHubGist) {
        const url = version.gitHubGistUrl ? ` ${formatUrlWithoutSecrets(version.gitHubGistUrl)}` : '';
        return `${versionLabel} has its files in the GitHub gist${url}, not stored on Apify, so this tool cannot work on them; use the gist.`;
    }
    // TODO(#1452): Read and write zip-stored (TARBALL) versions with adm-zip 0.6.1 or later, within the download and
    // unpacking limits the issue lists.
    if (version.sourceType === ActorSourceType.Tarball) {
        return `${versionLabel} is stored as a zip archive (apify push does this for sources over 3 MiB), and this tool cannot work on zip-stored versions yet.`;
    }
    // The API's legacy SOURCE_CODE type and any type added later are not in apify-client's enum.
    const { sourceType }: { sourceType: string } = version;
    return `${versionLabel} has source type ${sourceType}, which this tool cannot work on; only versions stored as files are supported.`;
}

/**
 * The version's stored entries, folders included. Throws `UserInputError` for a version not stored as files and for
 * one whose source the API hides.
 */
export function extractSourceFiles(version: ActorVersion, versionLabel: string): ActorVersionSourceFile[] {
    if (version.sourceType !== ActorSourceType.SourceFiles) {
        throw new UserInputError(formatSourceTypeRefusal(version, versionLabel));
    }
    // The API returns only the number, type, and build tag of a version whose source it hides from this account.
    if (!version.sourceFiles) {
        throw new UserInputError(
            `${versionLabel} came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.`,
        );
    }
    return version.sourceFiles;
}

/**
 * The entry to store for a file sent whole: TEXT for utf8, BASE64 for base64, where no encoding means base64 for a
 * binary extension, the rule get-actor-version reads by. The path is normalized the way get-actor-version lists it.
 */
export function buildSourceFileEntry({
    path,
    content,
    encoding,
}: z.infer<typeof sourceFileArgs>): ActorVersionSourceFile {
    const isBase64 = (encoding ?? (hasBinaryExtension(path) ? 'base64' : 'utf8')) === 'base64';
    return { name: posix.normalize(path), format: isBase64 ? 'BASE64' : 'TEXT', content };
}

/**
 * Base64 that decodes to its bytes without loss: Node and the build worker skip characters they cannot decode and stop
 * at padding, so text sent as base64 would be stored as other bytes. Line breaks, missing padding, and the URL-safe
 * alphabet decode without loss.
 */
function isBase64(content: string): boolean {
    const compact = content.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(compact, 'base64').toString('base64').replace(/=+$/, '') === compact.replace(/=+$/, '');
}

/**
 * Throws `UserInputError` for content the stored file would not hold as sent: base64 that does not decode without
 * loss, and text with a lone UTF-16 surrogate, which UTF-8 stores as U+FFFD.
 */
export function validateFileContent({ format, content }: ActorVersionSourceFile, label: string): void {
    if (format === 'BASE64' && !isBase64(content)) {
        throw new UserInputError(
            `${label} has content that is not valid base64; send binary content as base64, or text with encoding utf8.`,
        );
    }
    if (format === 'TEXT' && !content.isWellFormed()) {
        throw new UserInputError(`${label} has text with a lone UTF-16 surrogate, which UTF-8 cannot store.`);
    }
}

/**
 * Throws `UserInputError` for a normalized path no file can be written at. The build worker refuses a version with a
 * path outside the Actor root, so every build of it would fail; `.` and a path ending in a slash name a folder.
 */
export function validateFilePath(path: string, label: string): void {
    if (path.startsWith('/') || path === '..' || path.startsWith('../')) {
        throw new UserInputError(
            `${label} has a path outside the Actor root; give one relative to it, such as src/main.js.`,
        );
    }
    if (path === '.' || path.endsWith('/')) {
        throw new UserInputError(`${label} has a path that names a folder, not a file.`);
    }
}

/**
 * Throws `UserInputError` when a new file at `path` collides with another file or folder, since one path cannot be
 * both: a file at a folder of `path`, or a file or folder at or under `path`. The build worker fails to write such a
 * file. A file at `path` itself is for the caller to check.
 */
export function validateNewFilePath(
    path: string,
    takenPaths: { filePaths: Iterable<string>; folderPaths: Iterable<string> },
    label: string,
): void {
    const collision =
        [...takenPaths.filePaths].find(
            (filePath) => path.startsWith(`${filePath}/`) || filePath.startsWith(`${path}/`),
        ) ?? [...takenPaths.folderPaths].find((folderPath) => folderPath === path || folderPath.startsWith(`${path}/`));
    if (collision === undefined) return;
    throw new UserInputError(`${label} collides with ${collision}; one path cannot be both a file and a folder.`);
}

/**
 * The entries to send, one per file; throws `UserInputError` for a path no file can be written at, for content the
 * stored file would not hold as sent, and for a path given twice, which leaves the version with two entries where the
 * build uses the last.
 */
export function buildSourceFileEntries(files: readonly z.infer<typeof sourceFileArgs>[]): ActorVersionSourceFile[] {
    const entries: ActorVersionSourceFile[] = [];
    for (const [index, file] of files.entries()) {
        const entry = buildSourceFileEntry(file);
        const label = `files[${index}] (${file.path})`;
        validateFilePath(entry.name, label);
        validateFileContent(entry, label);
        if (entries.some(({ name }) => name === entry.name)) {
            throw new UserInputError(`${label} repeats the path ${entry.name}; send each file once.`);
        }
        validateNewFilePath(entry.name, { filePaths: entries.map(({ name }) => name), folderPaths: [] }, label);
        entries.push(entry);
    }
    return entries;
}

/** The build worker skips a file whose content is empty, so the caller hears of such files. */
export function buildEmptyFilesWarnings(paths: readonly string[]): { warnings?: string[] } {
    if (paths.length === 0) return {};
    const warning = `These files are empty, and the build skips empty files, so they will not exist in the build: ${paths.join(', ')}.`;
    return { warnings: [warning] };
}

/**
 * The response to a committed write. With autoBuild, a build of the version starts first, with no tag so the version's
 * buildTag applies, and is not waited for. The write stands either way, so a failed start goes to `buildError` rather
 * than being thrown: a caller told the call failed would retry writes that were saved.
 */
export async function respondAfterWrite(params: {
    toolArgs: Pick<InternalToolArgs, 'apifyClient' | 'apifyToken' | 'loadedToolNames'>;
    autoBuild: boolean;
    target: { actorId: string; versionNumber: string };
    structuredContent: Record<string, unknown>;
    summary: string;
}): Promise<ToolResponse> {
    const { toolArgs, autoBuild, target, structuredContent, summary } = params;
    const { apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
    if (!autoBuild) {
        return respondWithBuild({
            structuredContent,
            summary,
            nextStep: 'Runs use these files once the version is built.',
        });
    }
    let linkContext: ConsoleLinkContext | undefined;
    let build: Build | typeof ABORT;
    try {
        // Resolved before the start, so a failed lookup leaves no build behind.
        linkContext = await getConsoleLinkContext(apifyToken, client);
        // No signal is passed: a committed write never aborts the build it started.
        build = await startBuild(client, target.actorId, target.versionNumber, { useCache: true, waitSecs: 0 });
    } catch (error) {
        // The API's refusal is the caller's to read; anything else, such as a network failure, is logged too.
        if (!(error instanceof ApifyApiError))
            logHttpError(error, 'Failed to start a build after a source write', target);
        return respondWithBuild({
            structuredContent: {
                ...structuredContent,
                buildError: error instanceof Error ? error.message : String(error),
            },
            summary,
            nextStep: 'The build could not be started; start it again to run these files.',
        });
    }
    // startBuild returns ABORT only for a passed signal; the check narrows the type.
    if (build === ABORT) return respondAborted();
    return respondWithBuild({
        structuredContent: { ...structuredContent, build: toBuildResult(build, linkContext) },
        summary,
        nextStep: buildNextStepForBuild(build, { loadedToolNames }),
    });
}

/**
 * A `UserInputError`, or the platform's refusal of a taken version number or of deleting the last version, as a soft
 * failure with the platform's own message; anything else is rethrown for the tool-call engine to report. The engine
 * would add a token-access hint to these two 403s, which contradicts their reason.
 */
export function respondToSourceToolError(error: unknown): ToolResponse {
    if (error instanceof UserInputError) return respondUserError(error.message);
    if (
        error instanceof ApifyApiError &&
        (error.type === APIFY_ERROR_TYPE_TOO_FEW_VERSIONS || error.type === APIFY_ERROR_TYPE_VERSION_ALREADY_EXISTS)
    ) {
        return respondUserError(`${error.message} (API error type: ${error.type})`, { httpStatus: error.statusCode });
    }
    throw error;
}
