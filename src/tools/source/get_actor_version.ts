import type { Actor, ActorVersion } from 'apify-client';
import { ActorSourceType } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, MAX_INLINE_BYTES } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { listVersionNumbers } from '../builds/build_helpers.js';
import { getActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import type { SourceFile } from './source_files.js';
import { buildFilesManifest, buildFilesRevision } from './source_files.js';

const INLINE_LIMIT_KIB = MAX_INLINE_BYTES / 1024;

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
        .optional()
        .describe(
            `Files to return, relative to the Actor root, for example src/main.js; they fill the ${INLINE_LIMIT_KIB} KiB limit in this order. Omit for the listing only.`,
        ),
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
            'Number of lines to return from startLine; defaults to the rest of the file. Only with exactly one path in paths.',
        ),
});

type LineRange = { startLine: number; lineCount: number | undefined };

type ReturnedContent = {
    path: string;
    content: string;
    encoding: 'utf8' | 'base64';
    startLine?: number;
    endLine?: number;
    totalLines?: number;
};

/** The requested version, or the only one when none is requested; throws `UserInputError` otherwise. */
function resolveVersion(
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
 * The URL without what can grant access to it: the query string (for example a store signature), the password, and,
 * for http and https, the user. An SSH user such as `git@` is not a secret and stays. A URL the parser cannot read,
 * such as `git@github.com:user/repo.git`, loses only its query string.
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

/** Picked by source type, since a version can keep the fields of a source type it used before. */
function getSourceUrl(version: ActorVersion): string | undefined {
    if (version.sourceType === ActorSourceType.GitRepo) return version.gitRepoUrl;
    if (version.sourceType === ActorSourceType.Tarball) return version.tarballUrl;
    if (version.sourceType === ActorSourceType.GitHubGist) return version.gitHubGistUrl;
    return undefined;
}

/** Throws `UserInputError` for a version not stored as files and for one whose source the API hides. */
function extractVersionFiles(version: ActorVersion, versionLabel: string): SourceFile[] {
    if (version.sourceType !== ActorSourceType.SourceFiles) {
        // TODO(#1452): Read zip-stored (TARBALL) versions with adm-zip 0.6.1 or later, within the download and unpacking
        // limits the issue lists.
        // The API's legacy SOURCE_CODE type and any type added later are not in apify-client's enum.
        const { sourceType }: { sourceType: string } = version;
        const url = getSourceUrl(version);
        const source = url ? `${sourceType}, ${formatUrlWithoutSecrets(url)}` : sourceType;
        throw new UserInputError(
            `${versionLabel} is not stored as files (source type ${source}), and this tool reads only versions stored as files.`,
        );
    }
    // The API returns only the number, type, and build tag of a version whose source it hides from this account.
    if (!version.sourceFiles) {
        throw new UserInputError(
            `${versionLabel} came back without its source: the API hides it from accounts that cannot modify the Actor. Ask the Actor's owner for the source.`,
        );
    }
    return buildFilesManifest(version.sourceFiles);
}

/** Lines with their line endings kept, so joined back they give the exact text. */
function splitLines(text: string): string[] {
    if (text === '') return [];
    return text.split(/(?<=\n)/);
}

/** Throws `UserInputError` for a base64 file and for a `startLine` past the end. */
function extractLineRange(file: SourceFile, { startLine, lineCount }: LineRange): ReturnedContent {
    if (file.encoding === 'base64') {
        throw new UserInputError(
            `${file.path} is returned as base64, and startLine and lineCount work only on text files.`,
        );
    }
    const lines = splitLines(file.content);
    if (startLine > lines.length) {
        throw new UserInputError(`${file.path} has ${lines.length} lines, so startLine ${startLine} is past its end.`);
    }
    const selectedLines = lines.slice(startLine - 1, startLine - 1 + (lineCount ?? lines.length));
    return {
        path: file.path,
        content: selectedLines.join(''),
        encoding: 'utf8',
        startLine,
        endLine: startLine + selectedLines.length - 1,
        totalLines: lines.length,
    };
}

/**
 * The named files in order while they fit in `MAX_INLINE_BYTES`; a file that does not fit goes to `omittedPaths`, and
 * the files after it still get their turn.
 */
function selectContents(files: readonly SourceFile[], paths: readonly string[], lineRange: LineRange | undefined) {
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const contents: ReturnedContent[] = [];
    const omittedPaths: string[] = [];
    const notFoundPaths: string[] = [];
    let remainingBytes = MAX_INLINE_BYTES;
    for (const path of new Set(paths)) {
        const file = filesByPath.get(path);
        if (!file) {
            notFoundPaths.push(path);
            continue;
        }
        const range = lineRange && extractLineRange(file, lineRange);
        const bytes = range ? Buffer.byteLength(range.content) : file.contentBytes;
        if (bytes > remainingBytes) {
            omittedPaths.push(path);
            continue;
        }
        contents.push(range ?? { path, content: file.content, encoding: file.encoding });
        remainingBytes -= bytes;
    }
    return {
        contents,
        ...(omittedPaths.length > 0 && { omittedPaths }),
        ...(notFoundPaths.length > 0 && { notFoundPaths }),
    };
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 *
 * The Actor GET returns each version with its source, so one call is enough.
 */
export const getActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_GET,
    title: 'Get Actor version',
    description: dedent`
        Read an Actor version's files: a listing with each file's size and hash, a revision for the whole set, and the content of the files you name.
        Read-only. The API hides the source of most Actors you cannot modify, and the call then fails with a message saying so.
        - Without paths: the listing only.
        - With paths: those files, in that order, up to ${INLINE_LIMIT_KIB} KiB of content; files that do not fit are named in omittedPaths, and paths with no file in notFoundPaths.
        - For part of a large text file, pass its path alone with startLine and lineCount.
        - Content is raw, with no line numbers: text as utf8, binary files as base64.
        - hash is the first 16 hex characters of the SHA-256 of the file's bytes, the same as sha256sum <file> | cut -c1-16 (shasum -a 256 on macOS). revision identifies the whole file set and changes when any file changes.
        Only versions stored as files can be read; a version built from a Git repository, a gist, or a zip is refused.
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
        const { paths = [], startLine, lineCount } = parsed;
        const lineRange =
            startLine !== undefined || lineCount !== undefined ? { startLine: startLine ?? 1, lineCount } : undefined;
        if (lineRange && paths.length !== 1) {
            return respondUserError('startLine and lineCount need exactly one path in paths.');
        }
        try {
            // TODO: The Actor GET returns every file of every version; read only the files asked for once the API can.
            // apify-client turns username/name into the API's username~name.
            const actor = await client.actor(parsed.actor).get();
            // Extra path segments, such as username/name/runs/last, reach a sub-resource that is not an Actor.
            if (!actor || typeof actor.name !== 'string' || typeof actor.username !== 'string') {
                return respondUserError(
                    `Actor '${parsed.actor}' not found. Give its ID or its full name, username/name; a name without the username is not enough.`,
                );
            }
            const fullName = `${actor.username}/${actor.name}`;
            const version = resolveVersion(actor, parsed.versionNumber, parsed.actor);
            const files = extractVersionFiles(version, `Version ${version.versionNumber} of ${fullName}`);
            const structuredContent = {
                actorId: actor.id,
                fullName,
                versionNumber: version.versionNumber,
                revision: buildFilesRevision(files),
                files: files.map(({ path, sizeBytes, hash }) => ({ path, sizeBytes, hash })),
                ...selectContents(files, paths, lineRange),
            };
            const { omittedPaths, notFoundPaths } = structuredContent;
            const omittedHint = lineRange
                ? 'ask for fewer lines with lineCount'
                : 'ask for a file alone, or for part of it with startLine and lineCount';
            // Names the requested files that did not come back, for a caller that reads only the text.
            const summary = [
                `Read version ${version.versionNumber} of ${fullName}.`,
                omittedPaths &&
                    `Left out over the ${INLINE_LIMIT_KIB} KiB limit: ${omittedPaths.join(', ')}; ${omittedHint}.`,
                notFoundPaths &&
                    `Not found: ${notFoundPaths.join(', ')}; check the paths against files (folders are not files).`,
            ]
                .filter(Boolean)
                .join(' ');
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            throw error;
        }
    },
} as const);
