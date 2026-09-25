import type { Actor, ActorVersionSourceFile, Build } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondServerError, respondUserError } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { ABORT } from '../actors/actor_run_response.js';
import { listVersionNumbers, startBuild } from '../builds/build_helpers.js';
import { ABSOLUTE_NAME_REGEX } from './source_archive.js';
import type { SourceFile } from './source_files.js';
import {
    buildInlineSourceFile,
    BYTES_PER_MIB,
    compareSourcePaths,
    formatMib,
    hasBinaryExtension,
    MAX_SOURCE_PATH_LENGTH,
    parseSourcePath,
} from './source_files.js';

/**
 * The platform refuses a version whose inline files measure more than this (`MAX_MULTIFILE_BYTES` in `@apify/consts`);
 * exactly 3 MiB is accepted.
 */
export const MAX_INLINE_SOURCE_BYTES = 3 * BYTES_PER_MIB;

/** Content, oldText, and newText together per call, so one call stays well within the transports' body limits. */
export const MAX_CALL_CONTENT_BYTES = 2 * BYTES_PER_MIB;

/** Files one call sends: the files input of create-actor and create-actor-version, and update-actor-version's replaceFiles. */
export const MAX_WRITE_FILES = 500;

/** The build reads the Actor's configuration, such as its Dockerfile and input schema, from this file. */
export const ACTOR_CONFIG_PATH = '.actor/actor.json';

/** The platform's Actor name rules (`ACTOR_NAME` in `@apify/consts`), checked here to fail before any request. */
const ACTOR_NAME_MIN_LENGTH = 3;
const ACTOR_NAME_MAX_LENGTH = 63;
const ACTOR_NAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;

/** Groups of four base64 characters, the last one padded; no whitespace, no URL-safe alphabet. */
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The input shape of one file, shared by the files input of create-actor and create-actor-version and by
 * update-actor-version's replaceFiles.
 */
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

type SourceFileArgs = z.infer<typeof sourceFileArgs>;

/** Where the build looks for a Dockerfile when `.actor/actor.json` names none; it matches them regardless of case. */
const DOCKERFILE_PATHS = ['dockerfile', '.actor/dockerfile'];

/** A refusal about the caller's account or token, recorded as AUTH rather than as invalid input. */
export class AccountAuthError extends UserInputError {}

/** Throws `AccountAuthError` for a session without a token: the account cannot be checked, so no request is made. */
export function validateSessionToken(apifyToken: string | undefined, needsTokenText: string): void {
    if (!apifyToken) {
        throw new AccountAuthError(`${needsTokenText} needs an Apify API token, and this session has none.`);
    }
}

export type OwnActorInfo = { actor: Actor; fullName: string };

/**
 * The caller's own Actor, by ID or full name (`username/name` or `username~name`). The platform lets anyone with
 * write access change an Actor, and an Actor's old `username~name` still reaches it after a move to another account,
 * so the owner is checked against users/me. Throws `AccountAuthError` when the account cannot be confirmed and
 * `UserInputError` for a missing Actor or someone else's.
 */
export async function resolveOwnActor(params: {
    client: ApifyClient;
    apifyToken: string | undefined;
    actorSelector: string;
}): Promise<OwnActorInfo> {
    const { client, apifyToken, actorSelector } = params;
    validateSessionToken(apifyToken, "Changing an Actor's source");
    // apify-client turns username/name into the API's username~name.
    const actor = await client.actor(actorSelector).get();
    // Extra path segments, such as username/name/runs/last, reach a sub-resource that is not an Actor.
    if (!actor || typeof actor.name !== 'string' || typeof actor.username !== 'string') {
        throw new UserInputError(
            `Actor ${actorSelector} not found. Give its ID or its full name, username/name; ` +
                'a name without the username is not enough.',
        );
    }
    const fullName = `${actor.username}/${actor.name}`;
    const { userId } = await getUserInfoCached(apifyToken, client);
    // users/me gives no ID to a token with limited permissions or an Actor run's token, and none on a failed
    // request; the Actor is not someone else's then, but ownership cannot be confirmed.
    if (!userId) {
        throw new AccountAuthError(
            `Could not confirm which account this token belongs to, so ${fullName} was not changed. ` +
                'A token with limited permissions cannot read its account: use one without limits, or change the ' +
                'Actor in Apify Console.',
        );
    }
    if (actor.userId !== userId) {
        throw new UserInputError(`${fullName} is not in your account; this tool changes only your own Actors.`);
    }
    return { actor, fullName };
}

/** Throws `UserInputError` for a name the platform would refuse, or one that names an account. */
export function validateActorName(name: string): void {
    if (/[/~]/.test(name)) {
        throw new UserInputError(
            `Give the Actor name without a username, for example ${name.split(/[/~]/).pop() || 'my-actor'}; ` +
                'the Actor is created in your own account.',
        );
    }
    const isValid =
        name.length >= ACTOR_NAME_MIN_LENGTH && name.length <= ACTOR_NAME_MAX_LENGTH && ACTOR_NAME_REGEX.test(name);
    if (!isValid) {
        throw new UserInputError(
            `Actor name ${name} is not valid: it must be ${ACTOR_NAME_MIN_LENGTH} to ${ACTOR_NAME_MAX_LENGTH} ` +
                'characters of letters, digits, and dashes, not starting or ending with a dash.',
        );
    }
}

/** The requested version when the Actor has it, else the only version; throws `UserInputError` otherwise. */
export function resolveVersionNumber(
    actor: Pick<Actor, 'versions'>,
    requestedVersionNumber: string | undefined,
    actorSelector: string,
    /** Appended to the refusal of a version the Actor does not have, for example how to add it. */
    missingVersionHint = '',
): string {
    const versionNumbers = listVersionNumbers(actor);
    if (versionNumbers.length === 0) throw new UserInputError(`Actor '${actorSelector}' has no versions.`);
    if (requestedVersionNumber !== undefined && !versionNumbers.includes(requestedVersionNumber)) {
        throw new UserInputError(
            `Actor '${actorSelector}' has no version ${requestedVersionNumber}; available versions: ${versionNumbers.join(', ')}.${missingVersionHint}`,
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

/** Console keeps an empty folder as a `{ name, folder: true }` entry with no content; apify-client's type leaves it out. */
export function isFolderEntry(file: ActorVersionSourceFile): boolean {
    return (file as { folder?: boolean }).folder === true;
}

/**
 * The URL without what can grant access to it, so that never goes out or into the revision: the query string (for
 * example a store signature) and, for http and https, the user and password. An SSH user such as `git@` is not a
 * secret and stays. A URL the parser cannot read, such as `git@github.com:user/repo.git`, loses only its query string.
 */
export function formatUrlWithoutSecrets(url: string): string {
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

/** The source a version builds from a URL, for result text: the Git repository or the GitHub gist, and its URL. */
export function formatUrlSourceText(source: { sourceType: string; url: string }): string {
    return source.sourceType === ActorSourceType.GitHubGist
        ? `the GitHub gist ${source.url}`
        : `the Git repository ${source.url}`;
}

/** Whether the URL holds something `formatUrlWithoutSecrets` removes: a query string, or an http(s) user or password. */
export function hasUrlSecrets(url: string): boolean {
    if (!URL.canParse(url)) return url.includes('?');
    const parsed = new URL(url);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return parsed.search !== '' || (isHttp && (parsed.username !== '' || parsed.password !== ''));
}

/**
 * The path as the version stores it (`parseSourcePath`, so it matches get-actor-version's listing); throws
 * `UserInputError` for a path that could escape the Actor root or is not a file path. `label` names the input field.
 */
export function parseInputPath(path: string, label: string): string {
    if (path.includes('\0')) throw new UserInputError(`${label} contains a NUL character.`);
    if (ABSOLUTE_NAME_REGEX.test(path)) {
        throw new UserInputError(`${label} ${path} is absolute; give a path relative to the Actor root.`);
    }
    const parsed = parseSourcePath(path);
    if (parsed === '') throw new UserInputError(`${label} ${path} is not a file path.`);
    if (parsed.split('/').includes('..')) throw new UserInputError(`${label} ${path} has a '..' segment.`);
    return parsed;
}

/**
 * The stored entry for content sent by the caller: TEXT for utf8, BASE64 for base64. Without an encoding a binary
 * extension means base64, the same rule get-actor-version reads by. Throws `UserInputError` for content that is not
 * strict base64.
 */
export function buildSourceFileEntry(params: {
    path: string;
    content: string;
    encoding: 'utf8' | 'base64' | undefined;
    label: string;
}): ActorVersionSourceFile {
    const { path, content, label } = params;
    const encoding = params.encoding ?? (hasBinaryExtension(path) ? 'base64' : 'utf8');
    if (encoding === 'utf8') return { name: path, format: 'TEXT', content };
    if (!BASE64_REGEX.test(content)) {
        const defaultNote =
            params.encoding === undefined ? ` Files with the extension of ${path} default to base64.` : '';
        throw new UserInputError(
            `${label} ${path} has encoding base64, but its content is not valid base64 (no whitespace or line breaks).${defaultNote}`,
        );
    }
    return { name: path, format: 'BASE64', content };
}

/**
 * The entries to store for files sent by the caller, in the order sent. Throws `UserInputError` for a path that is not
 * valid, is over 255 characters, or is given twice. `field` names the input field in the messages.
 */
export function parseInputFileEntries(files: readonly SourceFileArgs[], field: string): ActorVersionSourceFile[] {
    const seenPaths = new Set<string>();
    return files.map((file, index) => {
        const label = `${field}[${index}]`;
        const path = parseInputPath(file.path, `${label} path`);
        if (path.length > MAX_SOURCE_PATH_LENGTH) {
            throw new UserInputError(`${label} path is over ${MAX_SOURCE_PATH_LENGTH} characters.`);
        }
        if (seenPaths.has(path)) throw new UserInputError(`${field} has ${path} more than once.`);
        seenPaths.add(path);
        return buildSourceFileEntry({
            path,
            content: file.content,
            encoding: file.encoding,
            label: `${label} content for`,
        });
    });
}

/**
 * The entries for a whole new file set sent as files, as `parseInputFileEntries` gives them; also throws
 * `UserInputError` when `.actor/actor.json` is missing.
 */
export function parseInputFiles(files: readonly SourceFileArgs[]): ActorVersionSourceFile[] {
    const entries = parseInputFileEntries(files, 'files');
    if (!entries.some(({ name }) => name === ACTOR_CONFIG_PATH)) {
        throw new UserInputError(
            `files must include ${ACTOR_CONFIG_PATH}: this tool requires it, since the build reads the Actor's ` +
                'configuration from it.',
        );
    }
    return entries;
}

/** " with update-actor-version" when the session has it, for text that says how to add files later. */
export function formatWithUpdateToolText(loadedToolNames: readonly string[]): string {
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_UPDATE)
        ? ` with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}`
        : '';
}

/**
 * Throws `UserInputError` when the files of a new Actor or version send more content than one call takes. Files
 * within this cap always fit the platform's 3 MiB measure, which counts at most 1.25 bytes per UTF-8 byte.
 */
export function validateNewFilesCallSize(
    files: readonly SourceFileArgs[],
    { subject, loadedToolNames }: { subject: 'Actor' | 'version'; loadedToolNames: readonly string[] },
): void {
    validateCallContentSize(
        files.map(({ content }) => content),
        {
            fieldsText: 'content',
            recoveryText:
                `Create the ${subject} with fewer files, then add the rest in later calls` +
                `${formatWithUpdateToolText(loadedToolNames)}.`,
        },
    );
}

/** The warnings for a file set the caller sent: no Dockerfile, and empty files the build skips. */
export function buildSentFilesWarnings(entries: readonly ActorVersionSourceFile[]): string[] {
    const emptyPaths = entries.filter(({ content }) => content === '').map(({ name }) => name);
    return [formatMissingDockerfileWarning(entries), formatEmptyFilesWarning(emptyPaths)].filter(
        (warning): warning is string => warning !== undefined,
    );
}

/** One file per path, the last stored entry winning as in get-actor-version, sorted by path; folder entries are left out. */
export function buildFilesManifest(entries: readonly ActorVersionSourceFile[]): SourceFile[] {
    const filesByPath = new Map<string, SourceFile>();
    for (const entry of entries) {
        if (isFolderEntry(entry)) continue;
        const file = buildInlineSourceFile(entry);
        filesByPath.set(file.path, file);
    }
    return [...filesByPath.values()].sort((a, b) => compareSourcePaths(a.path, b.path));
}

/** Whether `.actor/actor.json` names a Dockerfile; a file that is not valid JSON names none. */
function hasDockerfileField(entries: readonly ActorVersionSourceFile[]): boolean {
    const config = entries.find(({ name }) => name === ACTOR_CONFIG_PATH);
    if (!config) return false;
    try {
        const parsed = JSON.parse(buildInlineSourceFile(config).readContent()) as { dockerfile?: unknown };
        return typeof parsed?.dockerfile === 'string' && parsed.dockerfile !== '';
    } catch {
        return false;
    }
}

/** The warning for files sent without a Dockerfile, which the build then replaces with the platform's default one. */
function formatMissingDockerfileWarning(entries: readonly ActorVersionSourceFile[]): string | undefined {
    const paths = new Set(entries.map(({ name }) => name.toLowerCase()));
    if (DOCKERFILE_PATHS.some((path) => paths.has(path)) || hasDockerfileField(entries)) return undefined;
    return (
        `No Dockerfile found: there is no Dockerfile or .actor/Dockerfile, and ${ACTOR_CONFIG_PATH} names none, so ` +
        "the build uses the platform's default Node.js Dockerfile; an Actor in another language needs its own."
    );
}

/** The decoded bytes of a stored entry; a missing format or content reads as TEXT and empty, as the build worker reads it. */
export function getSourceFileEntryBytes(entry: ActorVersionSourceFile): Buffer {
    const { format, content = '' }: Partial<ActorVersionSourceFile> = entry;
    return format === 'BASE64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

/**
 * Ported from the platform's `stringByteLength` (apify-core packages/utils/src/conversion.ts): the utf8 length, except that a surrogate pair counts 5 bytes rather than 4 (each
 * half is counted as a 3-byte code unit, then the trail half gives one back). Base64 counts its encoded length.
 */
function getPlatformStringByteLength(text: string): number {
    let { length } = text;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code > 0x7f && code <= 0x7ff) length += 1;
        if (code > 0x7ff && code <= 0xffff) length += 2;
        if (code >= 0xdc00 && code <= 0xdfff) length -= 1;
    }
    return length;
}

/** The size the platform checks against `MAX_INLINE_SOURCE_BYTES`: contents as sent, names not counted. */
export function getInlineSourceBytes(entries: readonly ActorVersionSourceFile[]): number {
    return entries.reduce(
        (total, entry) => total + getPlatformStringByteLength((entry as Partial<ActorVersionSourceFile>).content ?? ''),
        0,
    );
}

/** Throws `UserInputError` when the files would not fit inline; zip storage is not written by these tools yet. */
export function validateInlineSourceSize(entries: readonly ActorVersionSourceFile[]): number {
    const sizeBytes = getInlineSourceBytes(entries);
    if (sizeBytes > MAX_INLINE_SOURCE_BYTES) {
        throw new UserInputError(
            `The files would measure ${formatMib(sizeBytes)} MiB as the platform counts them (base64 at its encoded ` +
                `length), over the ${MAX_INLINE_SOURCE_BYTES / BYTES_PER_MIB} MiB a version can store as files. ` +
                'Larger sources are stored as a zip, which this tool cannot write yet; push them with the Apify CLI ' +
                '(apify push).',
        );
    }
    return sizeBytes;
}

/**
 * Throws `UserInputError` when a call sends more text than `MAX_CALL_CONTENT_BYTES`. `fieldsText` names the fields
 * counted, and `recoveryText` says how to send the change instead, since that differs between the tools.
 */
export function validateCallContentSize(
    texts: readonly string[],
    { fieldsText, recoveryText }: { fieldsText: string; recoveryText: string },
): void {
    const totalBytes = texts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);
    if (totalBytes > MAX_CALL_CONTENT_BYTES) {
        throw new UserInputError(
            `This call sends ${formatMib(totalBytes)} MiB of ${fieldsText}, over the ` +
                `${MAX_CALL_CONTENT_BYTES / BYTES_PER_MIB} MiB one call takes. ${recoveryText}`,
        );
    }
}

/** Empty files the build worker never writes (it skips a file whose content is empty), so the caller hears of them. */
export function formatEmptyFilesWarning(paths: readonly string[]): string | undefined {
    if (paths.length === 0) return undefined;
    return `These files are empty, and the build skips empty files, so they will not exist in the build: ${paths.join(', ')}.`;
}

/** What a build start after a committed write gives: the build, or why it did not start. */
export type BuildAfterWriteResult = { build?: Build; buildErrMessage?: string };

/**
 * Starts a build of the version just written, with no tag so the version's buildTag applies, and returns right away.
 * The write is committed, so a failed start is returned for the response to report instead of thrown.
 */
export async function startBuildAfterWrite(
    client: ApifyClient,
    actorId: string,
    versionNumber: string,
): Promise<BuildAfterWriteResult> {
    try {
        // No signal is passed: a committed write never aborts the build it started.
        const build = await startBuild(client, actorId, versionNumber, { useCache: true, waitSecs: 0 });
        // startBuild returns ABORT only for a passed signal; the check narrows the type.
        return build === ABORT ? {} : { build };
    } catch (error) {
        return { buildErrMessage: error instanceof Error ? error.message : String(error) };
    }
}

/** The write happened but the build did not start; names build-actor only when the session has it. */
export function formatBuildStartFailure(
    writtenText: string,
    errMessage: string,
    loadedToolNames: readonly string[],
): string {
    const retry = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Start it again with ${HELPER_TOOLS.ACTOR_BUILD}.`
        : 'Start the build again to make this version runnable.';
    // API messages rarely end with a period; give the message its own sentence so the retry hint does not run into it.
    return `${writtenText}, but the build could not be started: ${errMessage.replace(/\.?$/, '.')} ${retry}`;
}

/** The build hint for a write without autoBuild; names build-actor only when the session has it. */
export function formatBuildLaterHint(loadedToolNames: readonly string[]): string {
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD) ? ` Build it with ${HELPER_TOOLS.ACTOR_BUILD}.` : '';
}

/**
 * The response for an error thrown by a source tool: a user error for `UserInputError` (AUTH for `AccountAuthError`),
 * the API's message for a 4xx, which respondServerError records as AUTH for 401 and 403 and INVALID_INPUT otherwise.
 * Anything else is rethrown.
 */
export function respondToSourceToolError(error: unknown): ToolResponse {
    if (error instanceof AccountAuthError) {
        return respondUserError(error.message, { category: FAILURE_CATEGORY.AUTH });
    }
    if (error instanceof UserInputError) return respondUserError(error.message);
    if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
        return respondServerError(error.message, { error });
    }
    throw error;
}
