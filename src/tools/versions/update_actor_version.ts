import { posix } from 'node:path';

import { ActorSourceType } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getApifyErrorType } from '../../utils/apify_errors.js';
import { getHttpStatusCode, logHttpError } from '../../utils/logging.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondAborted, respondServerError, respondUserError } from '../../utils/mcp.js';
import { respondWithBuild } from '../builds/build_helpers.js';
import { updateActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import type { SourceFile } from './source_files.js';
import {
    buildFilesManifest,
    buildFilesRevision,
    buildInlineSourceFile,
    compareSourcePaths,
    isFolderEntry,
} from './source_files.js';
import {
    buildEmptyFilesWarnings,
    buildSourceFileEntry,
    extractSourceFiles,
    fetchActor,
    redactSourceToolArgs,
    resolveVersion,
    respondAfterWrite,
    respondToSourceToolError,
    SourcePathIndex,
    validateFileContent,
    validateFilePath,
    validatePathCharacters,
} from './source_helpers.js';

/** Why an operation or the revision check failed; the caller reads the code to decide how to recover. */
const PRECONDITION_REASON = {
    FILE_EXISTS: 'FILE_EXISTS',
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    HASH_MISMATCH: 'HASH_MISMATCH',
    NO_MATCH: 'NO_MATCH',
    MULTIPLE_MATCHES: 'MULTIPLE_MATCHES',
    NOT_TEXT: 'NOT_TEXT',
    REVISION_MISMATCH: 'REVISION_MISMATCH',
} as const;
type PRECONDITION_REASON = (typeof PRECONDITION_REASON)[keyof typeof PRECONDITION_REASON];

// Each edit searches the whole text of its file, which is at most MAX_EDITED_TEXT_LENGTH long, and blocks the event loop
// meanwhile: up to about 20 ms for an oldText over 250 characters, so 20 edits take up to about 0.4 s. Writes and deletes
// never search a stored file.
const MAX_OPERATIONS_PER_CALL = 100;
const MAX_EDITS_PER_CALL = 20;
// In UTF-16 code units, which a string's length gives at no cost and the search time grows with. The platform refuses
// a version whose stored file contents pass 3 MiB in total, in UTF-8 bytes (MAX_MULTIFILE_BYTES in @apify/consts), but
// checks that only at the PUT, after the edits ran. UTF-8 takes at least one byte per code unit, so no file the platform
// stored is longer than this; a file within it can still be over the platform's limit, which the PUT then refuses.
const MAX_EDITED_TEXT_LENGTH = 3 * 1024 * 1024;

// One flat object with an explicit `type`: AJV's `removeAdditional` drops the fields of all but one branch of a
// union, so the field each type needs is checked in code.
const operationArgs = z.object({
    type: z
        .enum(['write', 'edit', 'delete'])
        .describe('write creates or replaces a file, edit replaces text in one, delete removes one.'),
    path: z.string().min(1).describe('The file, relative to the Actor root, for example src/main.js.'),
    content: z.string().optional().describe('write: the whole new content.'),
    encoding: z
        .enum(['utf8', 'base64'])
        .optional()
        .describe(
            'write: utf8 for text, base64 for binary files. Defaults to base64 for binary extensions such as .png and to utf8 otherwise.',
        ),
    expectedHash: z
        .string()
        .optional()
        .describe(
            "write over an existing file, and delete: the file's hash from the version listing. Leave it out to create a new file. An edit checks it when given.",
        ),
    edits: z
        .array(
            z.object({
                oldText: z.string().min(1).describe('The exact current text to replace, copied from the file content.'),
                newText: z.string().describe('The text to put in its place; empty to remove oldText.'),
            }),
        )
        .min(1)
        .optional()
        .describe('edit: replacements applied in order, each to the text the previous ones left.'),
});

type OperationArgs = z.infer<typeof operationArgs>;

type TextEdit = NonNullable<OperationArgs['edits']>[number];

const updateActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to change: its ID, its name (resolved against your own Actors), or its full name as username/name or username~name.',
        ),
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version to change in MAJOR.MINOR form, for example 0.1. Defaults to the only version when the Actor has exactly one.',
        ),
    operations: z
        .array(operationArgs)
        .max(MAX_OPERATIONS_PER_CALL)
        .describe(
            'File changes, applied in order to the current files. They are saved together, or none is saved when any fails.',
        ),
    expectedRevision: z
        .string()
        .optional()
        .describe(
            'The revision of the version when you read it; the call fails if any file changed since. ' +
                'Pass it so that a retried call fails instead of applying its edits twice.',
        ),
    autoBuild: z
        .boolean()
        .default(false)
        .describe('Start a build of the version after the write, and return without waiting for it. Default: false.'),
});

type FileChange = { path: string; action: 'created' | 'updated' | 'deleted'; hash?: string };

/** `label` names the operation, or expectedRevision. */
function buildPreconditionError(label: string, reason: PRECONDITION_REASON, detail: string): UserInputError {
    return new UserInputError(`Nothing was written: ${label} failed with ${reason}. ${detail}`);
}

/** Throws FILE_NOT_FOUND when there is no file at `path`. */
function findFile(files: ReadonlyMap<string, SourceFile>, path: string, label: string): SourceFile {
    const file = files.get(path);
    if (!file) throw buildPreconditionError(label, PRECONDITION_REASON.FILE_NOT_FOUND, `There is no file at ${path}.`);
    return file;
}

function validateHash(file: SourceFile, expectedHash: string, label: string): void {
    if (expectedHash.toLowerCase() === file.hash) return;
    const detail = `${file.path} has hash ${file.hash}, not ${expectedHash}.`;
    throw buildPreconditionError(label, PRECONDITION_REASON.HASH_MISMATCH, detail);
}

/** Every line break is CRLF; a file with mixed line endings gets no conversion. */
function hasOnlyCrlfLineBreaks(text: string): boolean {
    return text.includes('\r\n') && !/(?<!\r)\n/.test(text);
}

function convertToCrlf(text: string): string {
    return text.replace(/(?<!\r)\n/g, '\r\n');
}

// V8's indexOf keeps its Boyer-Moore shift tables for the last 250 characters of a pattern (kBMMaxShift in
// https://github.com/v8/v8/blob/main/src/strings/string-search.h). For a longer pattern its time grows with the text
// length times the pattern length: over 4 s for a 10,001-character pattern in 3 MiB.
const MAX_INDEX_OF_PATTERN_LENGTH = 250;

/**
 * The offsets of the first two matches of `pattern` in `text`, counting two matches that overlap as two. A pattern
 * longer than MAX_INDEX_OF_PATTERN_LENGTH is searched with Knuth-Morris-Pratt, which reads each text character once:
 * https://en.wikipedia.org/wiki/Knuth%E2%80%93Morris%E2%80%93Pratt_algorithm
 */
function findMatchOffsets(text: string, pattern: string): [] | [number] | [number, number] {
    if (pattern.length <= MAX_INDEX_OF_PATTERN_LENGTH) {
        const offset = text.indexOf(pattern);
        if (offset === -1) return [];
        // From the next character, so two matches that overlap count as two.
        const nextOffset = text.indexOf(pattern, offset + 1);
        return nextOffset === -1 ? [offset] : [offset, nextOffset];
    }
    // fallback[i]: the length of the longest proper prefix of pattern[0..i] that is also its suffix.
    const fallback = new Int32Array(pattern.length);
    for (let i = 1, matched = 0; i < pattern.length; i++) {
        while (matched > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(matched)) matched = fallback[matched - 1];
        if (pattern.charCodeAt(i) === pattern.charCodeAt(matched)) matched++;
        fallback[i] = matched;
    }
    let firstOffset: number | undefined;
    for (let i = 0, matched = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        while (matched > 0 && charCode !== pattern.charCodeAt(matched)) matched = fallback[matched - 1];
        if (charCode === pattern.charCodeAt(matched)) matched++;
        if (matched === pattern.length) {
            const offset = i - matched + 1;
            if (firstOffset !== undefined) return [firstOffset, offset];
            firstOffset = offset;
            matched = fallback[matched - 1];
        }
    }
    return firstOffset === undefined ? [] : [firstOffset];
}

/**
 * The text after the edits, each applied to the text the previous ones left. Each oldText must match exactly once,
 * byte for byte. The one exception: in a file with only CRLF line breaks, LF in oldText and newText is taken as CRLF,
 * since models write LF. Matched as given, such an LF could split a CRLF, and inserted, it would mix line endings.
 */
function applyTextEdits(originalText: string, edits: readonly TextEdit[], label: string): string {
    const isCrlfFile = hasOnlyCrlfLineBreaks(originalText);
    let text = originalText;
    for (const [editIndex, edit] of edits.entries()) {
        // A lone surrogate can match half of a character, and UTF-8 stores it as U+FFFD.
        if (!edit.oldText.isWellFormed() || !edit.newText.isWellFormed()) {
            throw new UserInputError(
                `${label} has a lone UTF-16 surrogate in edits[${editIndex}], which UTF-8 cannot store.`,
            );
        }
        // An upper bound of the length after this edit, taken before the CRLF conversion and the search: converting only
        // lengthens oldText, and at most doubles newText.
        if (text.length - edit.oldText.length + (isCrlfFile ? 2 : 1) * edit.newText.length > MAX_EDITED_TEXT_LENGTH) {
            const crlfNote = isCrlfFile
                ? ' In a file with CRLF line breaks, each character of newText counts as two, since each LF in it becomes CRLF.'
                : '';
            throw new UserInputError(
                `Nothing was written: edits[${editIndex}] of ${label} can make the file longer than ${MAX_EDITED_TEXT_LENGTH} UTF-16 code units, the limit for an edited file.${crlfNote}`,
            );
        }
        const oldText = isCrlfFile ? convertToCrlf(edit.oldText) : edit.oldText;
        const newText = isCrlfFile ? convertToCrlf(edit.newText) : edit.newText;
        const [offset, nextOffset] = findMatchOffsets(text, oldText);
        if (offset === undefined) {
            const detail = `oldText of edits[${editIndex}] is not in the file.`;
            throw buildPreconditionError(label, PRECONDITION_REASON.NO_MATCH, detail);
        }
        if (nextOffset !== undefined) {
            const detail = `oldText of edits[${editIndex}] matches more than once; surrounding lines in oldText can narrow it to one match.`;
            throw buildPreconditionError(label, PRECONDITION_REASON.MULTIPLE_MATCHES, detail);
        }
        text = text.slice(0, offset) + newText + text.slice(offset + oldText.length);
    }
    return text;
}

/** The file an operation names, with the expectedHash it gives and the label its errors start with. */
type OperationTarget = { path: string; expectedHash: string | undefined; label: string };

/** Writes the file at `target.path` into `version.files`; throws `UserInputError` when it cannot. */
function applyWrite(
    version: { files: Map<string, SourceFile>; pathIndex: SourcePathIndex },
    target: OperationTarget,
    { content, encoding }: Pick<OperationArgs, 'content' | 'encoding'>,
): void {
    const { files, pathIndex } = version;
    const { path, expectedHash, label } = target;
    if (content === undefined) throw new UserInputError(`${label} needs content.`);
    // Only a write is checked, so a stored file at such a path can still be edited or deleted.
    validateFilePath(path, label);
    const existing = files.get(path);
    if (existing && expectedHash === undefined) {
        const detail = `${path} exists with hash ${existing.hash}; a write with that hash as expectedHash replaces it.`;
        throw buildPreconditionError(label, PRECONDITION_REASON.FILE_EXISTS, detail);
    }
    if (expectedHash !== undefined) validateHash(findFile(files, path, label), expectedHash, label);
    if (!existing) pathIndex.validateNewFilePath(path, label);
    const entry = buildSourceFileEntry({ path, content, encoding });
    validateFileContent(entry, label);
    files.set(path, buildInlineSourceFile(entry));
    pathIndex.addFile(path);
}

/** Applies `edits` to the file at `target.path` in `files`; throws `UserInputError` when they cannot apply. */
function applyEdit(files: Map<string, SourceFile>, target: OperationTarget, edits: OperationArgs['edits']): void {
    const { path, expectedHash, label } = target;
    if (edits === undefined) throw new UserInputError(`${label} needs edits.`);
    const existing = findFile(files, path, label);
    if (expectedHash !== undefined) validateHash(existing, expectedHash, label);
    // The same rule get-actor-version returns text by, so a file it returned as utf8 can be edited.
    if (existing.encoding !== 'utf8') {
        const detail = `${path} is not UTF-8 text; only a write can replace it.`;
        throw buildPreconditionError(label, PRECONDITION_REASON.NOT_TEXT, detail);
    }
    const text = applyTextEdits(existing.content, edits, label);
    // A UTF-8 file that `apify push` stored as BASE64 stays BASE64.
    const isBase64 = existing.entry.format === 'BASE64';
    const newContent = isBase64 ? Buffer.from(text).toString('base64') : text;
    files.set(path, buildInlineSourceFile({ name: path, format: isBase64 ? 'BASE64' : 'TEXT', content: newContent }));
}

/** Deletes the file at `target.path` from `version.files`; throws `UserInputError` when it cannot. */
function applyDelete(
    version: { files: Map<string, SourceFile>; pathIndex: SourcePathIndex },
    target: OperationTarget,
): void {
    const { files, pathIndex } = version;
    const { path, expectedHash, label } = target;
    if (expectedHash === undefined) throw new UserInputError(`${label} needs expectedHash.`);
    validateHash(findFile(files, path, label), expectedHash, label);
    files.delete(path);
    pathIndex.deleteFile(path);
}

/**
 * The files after the operations, each applied to the files the previous ones left; throws `UserInputError` for the
 * first operation that cannot apply, before anything is written.
 */
function applyOperations(
    version: { files: ReadonlyMap<string, SourceFile>; folderPaths: readonly string[] },
    operations: readonly OperationArgs[],
): Map<string, SourceFile> {
    const files = new Map(version.files);
    const pathIndex = new SourcePathIndex(files.keys(), version.folderPaths);
    for (const [index, operation] of operations.entries()) {
        const { type } = operation;
        const target = {
            // Normalized the way get-actor-version lists paths, so a listed path always matches.
            path: posix.normalize(operation.path),
            // AJV turns a null expectedHash into an empty string, which no file has, so it counts as not given.
            expectedHash: operation.expectedHash || undefined,
            label: `operations[${index}] (${type} ${operation.path})`,
        };
        if (type === 'write') applyWrite({ files, pathIndex }, target, operation);
        if (type === 'edit') applyEdit(files, target, operation.edits);
        if (type === 'delete') applyDelete({ files, pathIndex }, target);
    }
    return files;
}

/** One entry per file the operations created, updated, or deleted, sorted by path. */
function buildFileChanges(
    before: ReadonlyMap<string, SourceFile>,
    after: ReadonlyMap<string, SourceFile>,
): FileChange[] {
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareSourcePaths);
    return paths.flatMap((path): FileChange[] => {
        const file = after.get(path);
        if (!file) return [{ path, action: 'deleted' }];
        const previousHash = before.get(path)?.hash;
        if (previousHash === file.hash) return [];
        return [{ path, action: previousHash === undefined ? 'created' : 'updated', hash: file.hash }];
    });
}

/**
 * The response to a version PUT that failed with a 5xx or without an HTTP response, such as on a timeout: the platform
 * may have saved the files of that attempt, or of an earlier one apify-client retried, so the reply gives the revisions
 * that show whether it did. Any other error, such as a 4xx, is rethrown.
 */
function respondToUnconfirmedSave(
    error: unknown,
    params: {
        target: { actorId: string; versionNumber: string; fullName: string };
        previousRevision: string;
        revision: string;
        loadedToolNames: readonly string[];
    },
): ToolResponse {
    const { target, previousRevision, revision, loadedToolNames } = params;
    const httpStatus = getHttpStatusCode(error);
    if (httpStatus !== undefined && httpStatus < 500) throw error;
    logHttpError(error, 'Failed to save the files of an Actor version', {
        actorId: target.actorId,
        versionNumber: target.versionNumber,
    });
    const message = error instanceof Error ? error.message : String(error);
    const apiErrorType = getApifyErrorType(error);
    const failure =
        httpStatus === undefined
            ? `without an HTTP response: ${message}`
            : `with HTTP ${httpStatus}: ${message}${apiErrorType ? ` (API error type: ${apiErrorType})` : ''}`;
    const readTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_GET)
        ? `; ${HELPER_TOOLS.ACTOR_VERSION_GET} reads the revision`
        : '';
    return respondServerError(
        `Saving version ${target.versionNumber} of ${target.fullName} failed ${failure}. ` +
            'The platform may still have saved the change. ' +
            `If the version's revision is ${revision}, this call saved it, and if it is ${previousRevision}, ` +
            `it saved nothing${readTool}.`,
        // The status, category, and detail the tool-call engine records for a thrown error.
        { error, detail: message.slice(0, 200) },
    );
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/actor-version-put
 *  /v2/actors/{actorId}/versions/{versionNumber}
 *
 * The operations apply to the version as read in this call, and the result is stored with one version PUT that
 * carries only the source keys, never envVars or buildTag. Conflicts are caught by each operation's check and by
 * expectedRevision. A save from Apify Console, `apify push`, or another MCP server that lands between this call's read
 * and its PUT is not detected: the platform's version PUT takes no precondition, and this stays so until it gets a
 * conditional one.
 */
export const updateActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_UPDATE,
    title: 'Update Actor version',
    description: dedent`
        Change files of an Actor version in one call: write, edit, or delete them. Files the call does not mention stay as they are.
        The operations apply in order to a fresh read of the version and are saved together; when any of them fails, nothing is saved.
        - write {path, content, encoding?}: creates a file, or replaces one given its expectedHash.
        - edit {path, edits: [{oldText, newText}], expectedHash?}: replaces text in a UTF-8 file. Each oldText must match exactly once, byte for byte.
        - delete {path, expectedHash}: removes a file. To rename a file, delete it and write it at the new path.
        A call takes at most ${MAX_OPERATIONS_PER_CALL} operations and at most ${MAX_EDITS_PER_CALL} edits in total across its edit operations.
        expectedHash and expectedRevision take the hash and revision from the version listing. A failed check names the operation, the file, and one of FILE_EXISTS, FILE_NOT_FOUND, HASH_MISMATCH, NO_MATCH, MULTIPLE_MATCHES, NOT_TEXT, or REVISION_MISMATCH.
        Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it.
        Only versions stored as files can be changed. Env vars and the build tag are never changed.
        autoBuild starts a build after the write and returns without waiting. Without it, runs keep using the previous build.

        USAGE:
        - Use to fix a bug or add a feature in an Actor's code, a few files at a time.

        USAGE EXAMPLES:
        - user_input: Fix the typo in src/main.js of my Actor john/my-scraper
        - user_input: Add a README to my Actor and rebuild it`,
    // `fixZodSchemaRequired` strips `autoBuild` from `required` because it has a default.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(updateActorVersionArgs)) as ToolInputSchema,
    outputSchema: updateActorVersionToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(updateActorVersionArgs)),
    annotations: {
        title: 'Update Actor version',
        readOnlyHint: false,
        // Writes and deletes overwrite files.
        destructiveHint: true,
        idempotentHint: false,
        // autoBuild starts a build, like build-actor.
        openWorldHint: true,
    },
    redactArgs: (args: Record<string, unknown>) =>
        redactSourceToolArgs(args, {
            keys: ['actor', 'versionNumber', 'expectedRevision', 'autoBuild'],
            listKey: 'operations',
            entryKeys: ['type', 'path', 'encoding', 'expectedHash'],
        }),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal, loadedToolNames } = toolArgs;
        const parsed = updateActorVersionArgs.parse(args);
        const editCount = parsed.operations
            .filter(({ type }) => type === 'edit')
            .reduce((count, { edits = [] }) => count + edits.length, 0);
        if (editCount > MAX_EDITS_PER_CALL) {
            return respondUserError(
                `Nothing was written: the operations have ${editCount} edits in total, and one call takes at most ${MAX_EDITS_PER_CALL}.`,
            );
        }
        try {
            for (const [index, { path }] of parsed.operations.entries()) {
                validatePathCharacters(path, `operations[${index}]`);
            }
            // TODO: The Apify API has no way to read or change single files of an Actor's source, so even a one-line
            // edit reads the whole version here and writes all its files back with the PUT below. That read and write
            // is also what leaves a save landing between them undetected. Once the API can apply atomic changes to an
            // Actor's source, send only the changed files instead.
            const { actor, fullName } = await fetchActor(client, parsed.actor);
            const version = resolveVersion(actor, parsed.versionNumber, parsed.actor);
            const { versionNumber } = version;
            const storedEntries = extractSourceFiles(version, `Version ${versionNumber} of ${fullName}`);
            const before = new Map(buildFilesManifest(storedEntries).map((file) => [file.path, file]));
            const previousRevision = buildFilesRevision([...before.values()]);
            // AJV turns a null expectedRevision into an empty string, which no version has, so it counts as not given.
            if (parsed.expectedRevision && parsed.expectedRevision.toLowerCase() !== previousRevision) {
                const detail = `The version's revision is ${previousRevision}, not ${parsed.expectedRevision}.`;
                throw buildPreconditionError('expectedRevision', PRECONDITION_REASON.REVISION_MISMATCH, detail);
            }
            const folderPaths = storedEntries.filter(isFolderEntry).map(({ name }) => posix.normalize(name));
            const after = applyOperations({ files: before, folderPaths }, parsed.operations);
            const revision = buildFilesRevision([...after.values()]);
            // A cancel during the read writes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            // Nothing to write, so autoBuild starts no build; the stored files may already be in the build runs use.
            if (revision === previousRevision) {
                return respondWithBuild({
                    structuredContent: { revision, changed: false, changes: [] },
                    summary: `Nothing changed in version ${versionNumber} of ${fullName}, so nothing was written.`,
                    nextStep: 'No build was started.',
                });
            }
            // Console keeps an empty folder as an entry of its own, which goes back as it was.
            const sourceFiles = [
                ...storedEntries.filter(isFolderEntry),
                ...[...after.values()].map(({ entry }) => entry),
            ];
            try {
                await client
                    .actor(actor.id)
                    .version(versionNumber)
                    .update({ sourceType: ActorSourceType.SourceFiles, sourceFiles });
            } catch (error) {
                return respondToUnconfirmedSave(error, {
                    target: { actorId: actor.id, versionNumber, fullName },
                    previousRevision,
                    revision,
                    loadedToolNames,
                });
            }
            const changes = buildFileChanges(before, after);
            const emptyPaths = changes.flatMap(({ path }) => (after.get(path)?.sizeBytes === 0 ? [path] : []));
            return await respondAfterWrite({
                toolArgs,
                autoBuild: parsed.autoBuild,
                target: { actorId: actor.id, versionNumber },
                structuredContent: { revision, changed: true, changes, ...buildEmptyFilesWarnings(emptyPaths) },
                summary: `Updated version ${versionNumber} of ${fullName}.`,
            });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
