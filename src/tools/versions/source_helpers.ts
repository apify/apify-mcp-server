import { posix } from 'node:path';

import type { Actor, ActorVersion, ActorVersionSourceFile, Build } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { UserInputError } from '../../errors.js';
import { REDACTED } from '../../resources/api_resources.js';
import type { ConsoleLinkContext, InternalToolArgs } from '../../types.js';
import { getResourceByIdOrName } from '../../utils/apify_resource_id.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { logHttpError } from '../../utils/logging.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { isRecord } from '../api/apify_api_spec.js';
import { buildNextStepForBuild, listVersionNumbers, respondWithBuild, toBuildResult } from '../builds/build_helpers.js';
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

/** `keys` of `record` that are set: a string, number, or boolean as is, any other value as `REDACTED`. */
function pickLoggedValues(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(
        keys.flatMap((key) => {
            const value = record[key];
            if (value === undefined) return [];
            return [[key, ['string', 'number', 'boolean'].includes(typeof value) ? value : REDACTED]];
        }),
    );
}

/** `keys` of `record` that are set, each as `REDACTED`. */
function maskLoggedValues(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, REDACTED]));
}

/** The logged copy of an entry's edits, each with its oldText and newText as `REDACTED`. */
function redactEdits(edits: unknown): unknown {
    if (!Array.isArray(edits)) return REDACTED;
    return edits.map((textEdit) =>
        isRecord(textEdit) ? maskLoggedValues(textEdit, ['oldText', 'newText']) : REDACTED,
    );
}

/**
 * The logged copy of a source tool's arguments (`redactArgs`), built as an allowlist: `keys`, and each entry of the
 * list under `listKey` with its `entryKeys`, and with its content and its edits' oldText and newText as `REDACTED`.
 * File content can hold secrets, such as an API key written into the code.
 */
export function redactSourceToolArgs(
    args: Record<string, unknown>,
    fields: { keys: readonly string[]; listKey: string; entryKeys: readonly string[] },
): Record<string, unknown> {
    const { keys, listKey, entryKeys } = fields;
    const redactEntry = (entry: unknown) => {
        if (!isRecord(entry)) return REDACTED;
        const { edits } = entry;
        return {
            ...pickLoggedValues(entry, entryKeys),
            ...maskLoggedValues(entry, ['content']),
            ...(edits !== undefined && { edits: redactEdits(edits) }),
        };
    };
    const list = args[listKey];
    return {
        ...pickLoggedValues(args, keys),
        ...(list !== undefined && { [listKey]: Array.isArray(list) ? list.map(redactEntry) : REDACTED }),
    };
}

/**
 * The Actor by its ID, its name (resolved against the token's own Actors), or its full name, `username/name` or
 * `username~name` (apify-client turns username/name into the API's username~name); throws `UserInputError` when there
 * is none.
 */
export async function fetchActor(
    client: ApifyClient,
    actorSelector: string,
): Promise<{ actor: Actor; fullName: string }> {
    const actor = await getResourceByIdOrName(actorSelector, async (safeId) => client.actor(safeId).get());
    // Extra path segments, such as username/name/runs/last, reach a sub-resource that is not an Actor.
    if (!actor || typeof actor.name !== 'string' || typeof actor.username !== 'string') {
        throw new UserInputError(
            `Actor '${actorSelector}' not found. The actor argument takes an ID, a name (resolved against your own Actors), or a full name as username/name.`,
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
    // AJV turns a null versionNumber into an empty string, which no version has, so it counts as not given.
    const requested = requestedVersionNumber || undefined;
    if (requested === undefined && versionNumbers.length !== 1) {
        // The source type and build tag tell the caller which version holds the code it is after.
        const versions = actor.versions
            .filter((version) => version.versionNumber !== undefined)
            .map(({ versionNumber, sourceType, buildTag }) => {
                const tag = buildTag ? `, build tag ${buildTag}` : '';
                return `${versionNumber} (${sourceType}${tag})`;
            });
        throw new UserInputError(`Specify versionNumber; this Actor has versions: ${versions.join(', ')}.`);
    }
    const versionNumber = requested ?? versionNumbers[0];
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
            `${label} has content that is not valid base64; encoding base64 takes binary content as base64, and text takes encoding utf8.`,
        );
    }
    if (format === 'TEXT' && !content.isWellFormed()) {
        throw new UserInputError(`${label} has text with a lone UTF-16 surrogate, which UTF-8 cannot store.`);
    }
}

/**
 * Throws `UserInputError` for a path with a control character, U+0000 to U+001F or U+007F, or with a lone UTF-16
 * surrogate. The build writes the files to disk, where a file name cannot hold NUL, and UTF-8 stores a lone surrogate
 * as U+FFFD.
 */
export function validatePathCharacters(path: string, label: string): void {
    if (!path.isWellFormed()) {
        throw new UserInputError(`${label} has a lone UTF-16 surrogate in its path, which UTF-8 cannot store.`);
    }
    const character = [...path].find((char) => char <= '\u001f' || char === '\u007f');
    if (character === undefined) return;
    const codePoint = `U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    throw new UserInputError(
        `${label} has the control character ${codePoint} in its path; a path cannot hold characters U+0000 to U+001F or U+007F.`,
    );
}

/**
 * Throws `UserInputError` for a normalized path no file can be written at. The build worker refuses a version with a
 * path outside the Actor root, so every build of it would fail; `.` and a path ending in a slash name a folder. A
 * backslash is refused too: the build takes it as part of the file name, so src\main.js would land in the Actor root.
 */
export function validateFilePath(path: string, label: string): void {
    if (path.includes('\\')) {
        throw new UserInputError(`${label} has a backslash in its path; paths use / as the separator.`);
    }
    if (path.startsWith('/') || path === '..' || path.startsWith('../')) {
        throw new UserInputError(
            `${label} has a path outside the Actor root; paths are relative to it, such as src/main.js.`,
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

/** The build worker skips a file whose content is empty, so the caller hears of such files. */
export function buildEmptyFilesWarnings(paths: readonly string[]): { warnings?: string[] } {
    if (paths.length === 0) return {};
    const warning = `These files are empty, and the build skips empty files, so they will not exist in the build: ${paths.join(', ')}.`;
    return { warnings: [warning] };
}

/**
 * The response to a committed write. With autoBuild, a build of the version starts first, with no tag so the version's
 * buildTag applies, and is not waited for. The write stands either way, so a failed start goes to `buildError` rather
 * than being thrown: a caller told the call failed would retry writes that were saved. A cancel that arrives before
 * the start gets the cancelled-call response and starts no build.
 */
export async function respondAfterWrite(params: {
    toolArgs: Pick<InternalToolArgs, 'apifyClient' | 'apifyToken' | 'loadedToolNames' | 'signal'>;
    autoBuild: boolean;
    target: { actorId: string; versionNumber: string };
    structuredContent: Record<string, unknown>;
    summary: string;
}): Promise<ToolResponse> {
    const { toolArgs, autoBuild, target, structuredContent, summary } = params;
    const { apifyClient: client, apifyToken, loadedToolNames, signal } = toolArgs;
    if (!autoBuild) {
        return respondWithBuild({
            structuredContent,
            summary,
            nextStep: 'No build was started; runs use these files only after the version is built.',
        });
    }
    let linkContext: ConsoleLinkContext | undefined;
    let build: Build;
    try {
        // Resolved before the start, so a failed lookup leaves no build behind.
        linkContext = await getConsoleLinkContext(apifyToken, client);
        // Per the MCP spec a cancelled request gets no response; the write stands.
        if (signal?.aborted) return respondAborted();
        // Started without the request's signal: a committed write never aborts the build it started.
        build = await client.actor(target.actorId).build(target.versionNumber, { useCache: true });
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
            nextStep: 'The build could not be started; runs use these files only after the version is built.',
        });
    }
    return respondWithBuild({
        structuredContent: { ...structuredContent, build: toBuildResult(build, linkContext) },
        summary,
        nextStep: buildNextStepForBuild(build, { loadedToolNames }),
    });
}

/** A `UserInputError` as a soft failure; anything else is rethrown for the tool-call engine to report. */
export function respondToSourceToolError(error: unknown): ToolResponse {
    if (error instanceof UserInputError) return respondUserError(error.message);
    throw error;
}
