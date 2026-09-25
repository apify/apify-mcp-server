import type { ActorVersion, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { buildNextStepForBuild, respondWithBuild, toBuildResult } from '../builds/build_helpers.js';
import { updateActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import type { TextEdit, TextExcerpt, TextRange } from './source_edits.js';
import { applyTextEdits, buildTextExcerpts, limitTextExcerpts } from './source_edits.js';
import type { SourceFile } from './source_files.js';
import {
    buildFilesRevision,
    buildInlineSourceFile,
    buildUrlRevision,
    compareSourcePaths,
    formatMib,
    MAX_SOURCE_PATH_LENGTH,
    parseStoredPath,
} from './source_files.js';
import type { BuildAfterWriteResult } from './source_helpers.js';
import {
    ACTOR_CONFIG_PATH,
    buildSourceFileEntry,
    formatBuildLaterHint,
    formatBuildStartFailure,
    formatEmptyFilesWarning,
    formatUrlSourceText,
    formatUrlWithoutSecrets,
    getInlineSourceBytes,
    getSourceFileEntryBytes,
    hasUrlSecrets,
    isFolderEntry,
    MAX_INLINE_SOURCE_BYTES,
    MAX_WRITE_FILES,
    parseInputFileEntries,
    parseInputPath,
    resolveOwnActor,
    resolveVersionNumber,
    respondToSourceToolError,
    sourceFileArgs,
    startBuildAfterWrite,
    validateCallContentSize,
    validateInlineSourceSize,
} from './source_helpers.js';

const MAX_OPERATIONS = 100;
const MAX_EDITS_PER_OPERATION = 50;
const EXCERPT_CONTEXT_LINES = 2;
const MAX_EXCERPT_BYTES = 4 * 1024;

const OPERATION_TYPE = {
    WRITE: 'write',
    EDIT: 'edit',
    DELETE: 'delete',
    MOVE: 'move',
} as const;
type OPERATION_TYPE = (typeof OPERATION_TYPE)[keyof typeof OPERATION_TYPE];

/** Why a precondition failed; the caller reads the code to decide how to recover. */
const PRECONDITION_REASON = {
    FILE_EXISTS: 'FILE_EXISTS',
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    HASH_MISMATCH: 'HASH_MISMATCH',
    NO_MATCH: 'NO_MATCH',
    MULTIPLE_MATCHES: 'MULTIPLE_MATCHES',
    REVISION_MISMATCH: 'REVISION_MISMATCH',
    NOT_TEXT: 'NOT_TEXT',
} as const;
type PRECONDITION_REASON = (typeof PRECONDITION_REASON)[keyof typeof PRECONDITION_REASON];

/** The reasons that mean the version changed since the caller read it, so reading it again is the way out. */
const STALE_READ_REASONS: ReadonlySet<PRECONDITION_REASON> = new Set([
    PRECONDITION_REASON.FILE_EXISTS,
    PRECONDITION_REASON.FILE_NOT_FOUND,
    PRECONDITION_REASON.HASH_MISMATCH,
    PRECONDITION_REASON.REVISION_MISMATCH,
]);

// One flat object with an explicit `type`: AJV's `removeAdditional` drops the fields of all but one branch of a
// union, so the rules for each type are checked in code (`parseOperation`).
const operationArgs = z.object({
    type: z
        .enum([OPERATION_TYPE.WRITE, OPERATION_TYPE.EDIT, OPERATION_TYPE.DELETE, OPERATION_TYPE.MOVE])
        .describe('write creates or replaces a file, edit replaces text in one, delete removes one, move renames one.'),
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
            "write over an existing file, and delete: the file's hash from the version listing. Leave it out to create a new file.",
        ),
    edits: z
        .array(
            z.object({
                oldText: z.string().min(1).describe('The exact current text to replace, copied from the file content.'),
                newText: z.string().describe('The text to put in its place; empty to remove oldText.'),
                allOccurrences: z
                    .boolean()
                    .optional()
                    .describe('Replace every match instead of requiring exactly one.'),
            }),
        )
        .min(1)
        .max(MAX_EDITS_PER_OPERATION)
        .optional()
        .describe(
            `edit: 1 to ${MAX_EDITS_PER_OPERATION} replacements, applied in order, each to the text the previous ones left.`,
        ),
    newPath: z.string().min(1).optional().describe('move: the new path; no file may exist there.'),
});

type OperationArgs = z.infer<typeof operationArgs>;

const updateActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to change: its ID, or its full name as username/name or username~name. ' +
                'A name without the username is not enough. It must be in your own account.',
        ),
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Version to change in MAJOR.MINOR form, for example 0.1. Defaults to the only version when the Actor has exactly one.',
        ),
    operations: z
        .array(operationArgs)
        .max(MAX_OPERATIONS)
        .optional()
        .describe(
            `Up to ${MAX_OPERATIONS} file changes, applied in order to the current files. They are saved together, or none is saved when any fails.`,
        ),
    replaceFiles: z
        .array(sourceFileArgs)
        .min(1)
        .max(MAX_WRITE_FILES)
        .optional()
        .describe(
            `Replace every file of the version with these, up to ${MAX_WRITE_FILES}. Needs expectedRevision; not with operations or gitRepoUrl.`,
        ),
    gitRepoUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Build the version from this Git repository, as repository#branch:directory (branch and directory are optional). ' +
                'Needs expectedRevision; not with operations or replaceFiles.',
        ),
    expectedRevision: z
        .string()
        .optional()
        .describe(
            'The revision of the version when you read it; the call fails if the version changed since. Required with replaceFiles and gitRepoUrl. ' +
                'Pass it with operations too, so that a retried call fails instead of applying its edits twice.',
        ),
    buildTag: z.string().min(1).optional().describe('Tag that builds of this version get, for example latest.'),
    autoBuild: z
        .boolean()
        .default(false)
        .describe('Start a build of the version after the write, and return without waiting for it. Default: false.'),
});

type UpdateActorVersionArgs = z.infer<typeof updateActorVersionArgs>;

type PreparedOperation =
    | { type: 'write'; label: string; path: string; entry: ActorVersionSourceFile; expectedHash?: string }
    | { type: 'edit'; label: string; path: string; edits: TextEdit[] }
    | { type: 'delete'; label: string; path: string; expectedHash: string }
    | { type: 'move'; label: string; path: string; newPath: string };

type PreparedUpdate = {
    operations: PreparedOperation[];
    replaceFiles?: ActorVersionSourceFile[];
    gitRepoUrl?: string;
};

type OperationField = 'content' | 'encoding' | 'expectedHash' | 'edits' | 'newPath';

const OPERATION_FIELDS: Record<OPERATION_TYPE, { required: OperationField[]; optional: OperationField[] }> = {
    write: { required: ['content'], optional: ['encoding', 'expectedHash'] },
    edit: { required: ['edits'], optional: [] },
    delete: { required: ['expectedHash'], optional: [] },
    move: { required: ['newPath'], optional: [] },
};

const OPERATION_FIELD_NAMES: OperationField[] = ['content', 'encoding', 'expectedHash', 'edits', 'newPath'];

/** A file of the version as the call changes it; `originPath` is where it was before the call, if it existed. */
type WorkingFile = { entry: ActorVersionSourceFile; file: SourceFile; originPath?: string };

type CurrentSource =
    | {
          kind: 'files';
          files: Map<string, WorkingFile>;
          folders: ActorVersionSourceFile[];
          /** Every stored entry in its stored order, so the entries the call leaves alone go back as they were. */
          storedEntries: ActorVersionSourceFile[];
          revision: string;
      }
    | { kind: 'url'; sourceType: string; url: string; revision: string };

type FileChange = {
    path: string;
    action: 'created' | 'updated' | 'deleted' | 'moved' | 'unchanged';
    newPath?: string;
    hash?: string;
    sizeBytes?: number;
};

/**
 * A precondition of the batch failed against the version as read. `label` names the operation, or is undefined for
 * the revision check.
 */
class PreconditionError extends UserInputError {
    /** Whether reading the version again is the way out, so the response says so. */
    readonly isStaleRead: boolean;

    constructor(
        readonly reason: PRECONDITION_REASON,
        label: string | undefined,
        detail: string,
        options: { isStaleRead?: boolean } = {},
    ) {
        super(`Nothing was written: ${label ?? 'expectedRevision'} failed with ${reason}. ${detail}`);
        this.isStaleRead = options.isStaleRead ?? STALE_READ_REASONS.has(reason);
    }
}

function buildWorkingFile(entry: ActorVersionSourceFile, originPath: string | undefined): WorkingFile {
    return { entry, file: buildInlineSourceFile(entry), originPath };
}

/** Throws `UserInputError` for a field the operation's type does not take, or a missing one it needs. */
function parseOperation(operation: OperationArgs, index: number): PreparedOperation {
    const { type } = operation;
    const { required, optional } = OPERATION_FIELDS[type];
    const label = `operations[${index}] (${type} ${operation.path})`;
    for (const field of OPERATION_FIELD_NAMES) {
        if (operation[field] === undefined || required.includes(field) || optional.includes(field)) continue;
        const takes = ['path', ...required, ...optional].join(', ');
        throw new UserInputError(`${label} does not take ${field}; ${type} takes ${takes}.`);
    }
    const missing = required.find((field) => operation[field] === undefined);
    if (missing) throw new UserInputError(`${label} needs ${missing}.`);
    const path = parseInputPath(operation.path, `${label} path`);
    if (type === OPERATION_TYPE.WRITE) {
        const entry = buildSourceFileEntry({
            path,
            content: operation.content ?? '',
            encoding: operation.encoding,
            label: `${label} content for`,
        });
        return { type, label, path, entry, expectedHash: operation.expectedHash };
    }
    if (type === OPERATION_TYPE.EDIT) return { type, label, path, edits: operation.edits ?? [] };
    if (type === OPERATION_TYPE.DELETE) return { type, label, path, expectedHash: operation.expectedHash ?? '' };
    return { type, label, path, newPath: parseInputPath(operation.newPath ?? '', `${label} newPath`) };
}

function formatNothingToWriteText(autoBuild: boolean, loadedToolNames: readonly string[]): string {
    const give = 'Give operations, replaceFiles, gitRepoUrl, or buildTag.';
    if (!autoBuild) return `Nothing to write. ${give}`;
    const buildHint = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `To build the version as it is, use ${HELPER_TOOLS.ACTOR_BUILD}.`
        : 'To build the version as it is, start a build of it instead.';
    return `autoBuild alone has nothing to write. ${give} ${buildHint}`;
}

/** Checks the input without any API call; throws `UserInputError` for the first problem. */
function parseUpdateRequest(args: UpdateActorVersionArgs, loadedToolNames: readonly string[]): PreparedUpdate {
    const { replaceFiles, gitRepoUrl, expectedRevision, buildTag, autoBuild } = args;
    const operations = args.operations ?? [];
    if (gitRepoUrl !== undefined && (operations.length > 0 || replaceFiles !== undefined)) {
        throw new UserInputError('gitRepoUrl cannot be combined with operations or replaceFiles.');
    }
    if (replaceFiles !== undefined && operations.length > 0) {
        throw new UserInputError(
            'replaceFiles cannot be combined with operations; put every file the version should have in replaceFiles.',
        );
    }
    if ((replaceFiles !== undefined || gitRepoUrl !== undefined) && expectedRevision === undefined) {
        const field = replaceFiles === undefined ? 'gitRepoUrl' : 'replaceFiles';
        throw new UserInputError(
            `${field} replaces the whole source, so it needs expectedRevision: the revision of the version as you last read it.`,
        );
    }
    if (operations.length === 0 && replaceFiles === undefined && gitRepoUrl === undefined && buildTag === undefined) {
        throw new UserInputError(formatNothingToWriteText(autoBuild, loadedToolNames));
    }
    validateCallContentSize(
        [
            ...operations.flatMap((operation) => [
                operation.content ?? '',
                ...(operation.edits ?? []).flatMap(({ oldText, newText }) => [oldText, newText]),
            ]),
            ...(replaceFiles ?? []).map(({ content }) => content),
        ],
        { fieldsText: 'content, oldText, and newText together', recoveryText: 'Split the change into several calls.' },
    );
    const prepared = operations.map(parseOperation);
    if (replaceFiles === undefined) return { operations: prepared, gitRepoUrl };
    return { operations: prepared, replaceFiles: parseInputFileEntries(replaceFiles, 'replaceFiles') };
}

type VersionTarget = { actorId: string; fullName: string; versionNumber: string };

/**
 * The version's source as read now. Throws `UserInputError` for a zip-stored version, which this tool cannot write
 * yet, and for a source the API hid or a type it does not know.
 */
function readCurrentSource(version: ActorVersion, { fullName, versionNumber }: VersionTarget): CurrentSource {
    const { sourceType }: { sourceType: string } = version;
    const hiddenText = `Version ${versionNumber} of ${fullName} came back without its source, so it cannot be changed.`;
    if (version.sourceType === ActorSourceType.SourceFiles) {
        if (!version.sourceFiles) throw new UserInputError(hiddenText);
        const files = new Map<string, WorkingFile>();
        const folders: ActorVersionSourceFile[] = [];
        for (const entry of version.sourceFiles) {
            if (isFolderEntry(entry)) {
                folders.push(entry);
                continue;
            }
            const path = parseStoredPath(entry.name);
            // A path stored twice is written by the build in order, so the last one wins, as in get-actor-version.
            files.set(path, buildWorkingFile(entry, path));
        }
        const revision = buildFilesRevision([...files.values()].map(({ file }) => file));
        return { kind: 'files', files, folders, storedEntries: version.sourceFiles, revision };
    }
    if (version.sourceType === ActorSourceType.Tarball) {
        throw new UserInputError(
            `Version ${versionNumber} of ${fullName} is stored as a zip (TARBALL), and zip-stored versions cannot be ` +
                'edited with this tool yet. Push the whole source with the Apify CLI (apify push) instead.',
        );
    }
    if (version.sourceType === ActorSourceType.GitRepo || version.sourceType === ActorSourceType.GitHubGist) {
        const url = version.sourceType === ActorSourceType.GitRepo ? version.gitRepoUrl : version.gitHubGistUrl;
        if (!url) throw new UserInputError(hiddenText);
        const sanitizedUrl = formatUrlWithoutSecrets(url);
        return { kind: 'url', sourceType, url: sanitizedUrl, revision: buildUrlRevision(sourceType, sanitizedUrl) };
    }
    throw new UserInputError(
        `Version ${versionNumber} of ${fullName} has source type ${sourceType}, which this tool does not support.`,
    );
}

type ApplyState = {
    files: Map<string, WorkingFile>;
    /** Paths an operation targeted, so a write or edit that changed nothing is reported as unchanged. */
    touchedPaths: Set<string>;
    /** What the edits changed in each file, for the excerpts. */
    editedRanges: Map<string, TextRange[]>;
};

function applyWrite(state: ApplyState, operation: Extract<PreparedOperation, { type: 'write' }>): void {
    const { label, path, entry, expectedHash } = operation;
    const existing = state.files.get(path);
    state.touchedPaths.add(path);
    if (!existing) {
        if (expectedHash !== undefined) {
            throw new PreconditionError(
                PRECONDITION_REASON.FILE_NOT_FOUND,
                label,
                `There is no file at ${path}, but expectedHash was given. Leave expectedHash out to create it.`,
            );
        }
        state.files.set(path, buildWorkingFile(entry, undefined));
        return;
    }
    // A retried write finds its own content, which is reported as unchanged rather than as a conflict.
    if (getSourceFileEntryBytes(existing.entry).equals(getSourceFileEntryBytes(entry))) return;
    if (expectedHash === undefined) {
        throw new PreconditionError(
            PRECONDITION_REASON.FILE_EXISTS,
            label,
            `A file exists at ${path} with hash ${existing.file.hash}; to replace it, pass that as expectedHash.`,
        );
    }
    if (expectedHash.toLowerCase() !== existing.file.hash) {
        throw new PreconditionError(
            PRECONDITION_REASON.HASH_MISMATCH,
            label,
            `${path} has hash ${existing.file.hash}, not ${expectedHash}; it changed since it was read.`,
        );
    }
    state.editedRanges.delete(path);
    state.files.set(path, buildWorkingFile(entry, existing.originPath));
}

function applyEdit(state: ApplyState, operation: Extract<PreparedOperation, { type: 'edit' }>): void {
    const { label, path, edits } = operation;
    const existing = state.files.get(path);
    if (!existing) {
        throw new PreconditionError(PRECONDITION_REASON.FILE_NOT_FOUND, label, `There is no file at ${path}.`);
    }
    // The same rule get-actor-version returns text by, so a file it returned as utf8 can be edited.
    if (existing.file.encoding !== 'utf8') {
        throw new PreconditionError(
            PRECONDITION_REASON.NOT_TEXT,
            label,
            `${path} is not UTF-8 text, so it cannot be edited; replace it with a write and its expectedHash.`,
        );
    }
    const result = applyTextEdits(existing.file.readContent(), edits, state.editedRanges.get(path));
    if ('failure' in result) {
        const { reason, detail, hasContext } = result.failure;
        // With none of the current text shown, reading the file again is how the caller corrects its oldText.
        throw new PreconditionError(PRECONDITION_REASON[reason], label, detail, { isStaleRead: !hasContext });
    }
    state.touchedPaths.add(path);
    state.editedRanges.set(path, result.changedRanges);
    // The file keeps its stored format: a UTF-8 file that `apify push` stored as BASE64 stays BASE64.
    const { format } = existing.file;
    const content = format === 'BASE64' ? Buffer.from(result.text, 'utf8').toString('base64') : result.text;
    state.files.set(path, buildWorkingFile({ name: path, format, content }, existing.originPath));
}

function applyDelete(state: ApplyState, operation: Extract<PreparedOperation, { type: 'delete' }>): void {
    const { label, path, expectedHash } = operation;
    const existing = state.files.get(path);
    if (!existing) {
        throw new PreconditionError(PRECONDITION_REASON.FILE_NOT_FOUND, label, `There is no file at ${path}.`);
    }
    if (expectedHash.toLowerCase() !== existing.file.hash) {
        throw new PreconditionError(
            PRECONDITION_REASON.HASH_MISMATCH,
            label,
            `${path} has hash ${existing.file.hash}, not ${expectedHash}; it changed since it was read.`,
        );
    }
    state.files.delete(path);
    state.editedRanges.delete(path);
}

function applyMove(state: ApplyState, operation: Extract<PreparedOperation, { type: 'move' }>): void {
    const { label, path, newPath } = operation;
    const existing = state.files.get(path);
    if (!existing) {
        throw new PreconditionError(PRECONDITION_REASON.FILE_NOT_FOUND, label, `There is no file at ${path}.`);
    }
    const occupant = state.files.get(newPath);
    if (occupant) {
        throw new PreconditionError(
            PRECONDITION_REASON.FILE_EXISTS,
            label,
            `A file exists at ${newPath} with hash ${occupant.file.hash}; move needs a newPath with no file.`,
        );
    }
    state.files.delete(path);
    state.files.set(newPath, buildWorkingFile({ ...existing.entry, name: newPath }, existing.originPath));
    const ranges = state.editedRanges.get(path);
    state.editedRanges.delete(path);
    if (ranges) state.editedRanges.set(newPath, ranges);
}

/** Applies every operation in order; throws `PreconditionError` at the first one that fails, before any write. */
function applyOperations(
    files: ReadonlyMap<string, WorkingFile>,
    operations: readonly PreparedOperation[],
): ApplyState {
    const state: ApplyState = { files: new Map(files), touchedPaths: new Set(), editedRanges: new Map() };
    for (const operation of operations) {
        if (operation.type === OPERATION_TYPE.WRITE) applyWrite(state, operation);
        if (operation.type === OPERATION_TYPE.EDIT) applyEdit(state, operation);
        if (operation.type === OPERATION_TYPE.DELETE) applyDelete(state, operation);
        if (operation.type === OPERATION_TYPE.MOVE) applyMove(state, operation);
    }
    return state;
}

/**
 * What changed against the files before the call, one entry per file, sorted by path. A file keeps its origin across
 * moves and edits, so a moved and edited file is one move.
 */
function buildFileChanges(
    before: ReadonlyMap<string, WorkingFile>,
    after: ReadonlyMap<string, WorkingFile>,
    touchedPaths: ReadonlySet<string>,
): FileChange[] {
    const changes: FileChange[] = [];
    const keptPaths = new Set<string>();
    const claimedOrigins = new Set([...after.values()].flatMap(({ originPath }) => originPath ?? []));
    for (const [path, { file, ...rest }] of after) {
        // A file deleted and written again in one call is an update of the file that was there.
        const originPath = rest.originPath ?? (before.has(path) && !claimedOrigins.has(path) ? path : undefined);
        const current = { hash: file.hash, sizeBytes: file.sizeBytes };
        if (originPath === undefined) {
            changes.push({ path, action: 'created', ...current });
            continue;
        }
        keptPaths.add(originPath);
        if (originPath !== path) {
            changes.push({ path: originPath, action: 'moved', newPath: path, ...current });
            continue;
        }
        if (before.get(path)?.file.hash !== file.hash) changes.push({ path, action: 'updated', ...current });
        else if (touchedPaths.has(path)) changes.push({ path, action: 'unchanged', ...current });
    }
    for (const path of before.keys()) if (!keptPaths.has(path)) changes.push({ path, action: 'deleted' });
    return changes.sort((a, b) => compareSourcePaths(a.path, b.path));
}

/** A new file set built from `entries`; a path the version had keeps it as its origin, so it reports as updated. */
function buildReplacedFiles(
    entries: readonly ActorVersionSourceFile[],
    before: ReadonlyMap<string, WorkingFile> | undefined,
): Map<string, WorkingFile> {
    return new Map(
        entries.map((entry) => [entry.name, buildWorkingFile(entry, before?.has(entry.name) ? entry.name : undefined)]),
    );
}

/**
 * Each file path that is also a folder of the result, with a path under it, or itself when a folder entry names it.
 * The build cannot write both, so such a version fails to build.
 */
function findFileFolderConflicts(filePaths: readonly string[], folderPaths: readonly string[]): Map<string, string> {
    const folders = new Map<string, string>();
    const addFolders = (path: string, isFolder: boolean) => {
        const segments = path.split('/');
        for (let count = isFolder ? segments.length : segments.length - 1; count > 0; count--) {
            const folder = segments.slice(0, count).join('/');
            if (!folders.has(folder)) folders.set(folder, path);
        }
    };
    for (const path of filePaths) addFolders(path, false);
    for (const path of folderPaths) addFolders(path, true);
    return new Map(filePaths.flatMap((path) => (folders.has(path) ? [[path, folders.get(path) ?? path]] : [])));
}

/**
 * Throws `UserInputError` when the result could not be stored or built; returns the size the platform measures.
 * `before` is the file set the result replaces, undefined for a version that built from a URL.
 */
function validateResultFiles(params: {
    files: ReadonlyMap<string, WorkingFile>;
    folders: readonly ActorVersionSourceFile[];
    sourceFiles: readonly ActorVersionSourceFile[];
    before: { files: ReadonlyMap<string, WorkingFile>; folders: readonly ActorVersionSourceFile[] } | undefined;
    /** replaceFiles: the new set stands on its own, so a conflict the version had is not excused. */
    isReplacingAll: boolean;
}): number {
    const { files, folders, sourceFiles, before, isReplacingAll } = params;
    if (!files.has(ACTOR_CONFIG_PATH)) {
        // Older versions build from a root Dockerfile alone, so only removing the file is refused.
        if (before?.files.has(ACTOR_CONFIG_PATH)) {
            throw new UserInputError(
                `Nothing was written: the changes remove ${ACTOR_CONFIG_PATH}, which the build reads the Actor's ` +
                    'configuration from. Keep it, or give its new content with a write.',
            );
        }
        if (!before) {
            throw new UserInputError(
                `Nothing was written: to switch a version to stored files, this tool needs ${ACTOR_CONFIG_PATH} in ` +
                    "replaceFiles, since the build reads the Actor's configuration from it.",
            );
        }
    }
    const longPath = [...files.keys()].find((path) => path.length > MAX_SOURCE_PATH_LENGTH);
    if (longPath) {
        throw new UserInputError(
            `Nothing was written: the path ${longPath.slice(0, 40)}... is over ${MAX_SOURCE_PATH_LENGTH} characters.`,
        );
    }
    const getFolderPaths = (entries: readonly ActorVersionSourceFile[]) =>
        entries.map(({ name }) => parseStoredPath(name));
    const conflicts = findFileFolderConflicts([...files.keys()], getFolderPaths(folders));
    // A conflict the version already had is not this call's doing, so it does not block the call.
    const previousConflicts =
        before && !isReplacingAll
            ? findFileFolderConflicts([...before.files.keys()], getFolderPaths(before.folders))
            : new Map<string, string>();
    const newConflict = [...conflicts].find(([path]) => !previousConflicts.has(path));
    if (newConflict) {
        const [path, other] = newConflict;
        const otherText = other === path ? 'a folder entry has the same path' : `${other} is inside it`;
        throw new UserInputError(
            `Nothing was written: after the changes ${path} would be a file and also a folder (${otherText}), ` +
                'so the build could not write it.',
        );
    }
    return validateInlineSourceSize(sourceFiles);
}

/**
 * The entries to store after operations. An entry whose file the call left alone goes back verbatim and in place,
 * duplicates that normalize to the same path included. A changed file takes the place of the last entry for its path
 * and keeps that entry's name; a file at a new path goes at the end.
 */
function buildStoredEntries(params: {
    storedEntries: readonly ActorVersionSourceFile[];
    before: ReadonlyMap<string, WorkingFile>;
    after: ReadonlyMap<string, WorkingFile>;
}): ActorVersionSourceFile[] {
    const { storedEntries, before, after } = params;
    const lastIndexByPath = new Map<string, number>();
    for (const [index, entry] of storedEntries.entries()) {
        if (!isFolderEntry(entry)) lastIndexByPath.set(parseStoredPath(entry.name), index);
    }
    const entries = storedEntries.flatMap((entry, index) => {
        if (isFolderEntry(entry)) return [entry];
        const path = parseStoredPath(entry.name);
        const current = after.get(path);
        if (!current) return [];
        if (current === before.get(path)) return [entry];
        return index === lastIndexByPath.get(path) ? [{ ...current.entry, name: entry.name }] : [];
    });
    for (const [path, { entry }] of after) if (!lastIndexByPath.has(path)) entries.push(entry);
    return entries;
}

/** Excerpts of what the edits changed, within `MAX_EXCERPT_BYTES`, for the files whose content changed. */
function buildEditExcerpts(
    state: ApplyState,
    changes: readonly FileChange[],
): { excerpts: TextExcerpt[]; isTruncated: boolean } {
    const changedPaths = new Set(
        changes.filter(({ action }) => action !== 'unchanged').map(({ path, newPath }) => newPath ?? path),
    );
    const excerpts = [...state.editedRanges]
        .filter(([path]) => changedPaths.has(path))
        .sort(([a], [b]) => compareSourcePaths(a, b))
        .flatMap(([path, ranges]) => {
            const text = state.files.get(path)?.file.readContent() ?? '';
            return buildTextExcerpts({ path, text, ranges, contextLines: EXCERPT_CONTEXT_LINES });
        });
    return limitTextExcerpts(excerpts, MAX_EXCERPT_BYTES);
}

function formatChangeCounts(changes: readonly FileChange[]): string {
    const actions = ['created', 'updated', 'moved', 'deleted'] as const;
    const parts = actions.flatMap((action) => {
        const count = changes.filter((change) => change.action === action).length;
        return count === 0 ? [] : [`${count} ${count === 1 ? 'file' : 'files'} ${action}`];
    });
    return parts.length === 0 ? 'no file changes' : parts.join(', ');
}

type UpdateOutcome = {
    sourceType: string;
    revision: string;
    changed: boolean;
    /** What changed, for the summary. */
    changeText: string;
    changes: FileChange[];
    excerpts: TextExcerpt[];
    isExcerptTruncated: boolean;
    totalSizeBytes?: number;
    warnings: string[];
    /** The version body to PUT; undefined when nothing changed. */
    putBody?: Record<string, unknown>;
};

/**
 * The stored URL with the credentials of `storedUrl` carried over, when both are http(s) URLs on the same host;
 * undefined otherwise.
 */
function buildUrlWithStoredSecrets(storedUrl: string, requestedUrl: string): string | undefined {
    if (!URL.canParse(storedUrl) || !URL.canParse(requestedUrl)) return undefined;
    const stored = new URL(storedUrl);
    const requested = new URL(requestedUrl);
    if (stored.protocol !== requested.protocol || stored.host !== requested.host) return undefined;
    if (stored.protocol === 'http:' || stored.protocol === 'https:') {
        requested.username = stored.username;
        requested.password = stored.password;
    }
    if (requested.search === '') requested.search = stored.search;
    return requested.href;
}

/**
 * The Git URL to store, undefined when the version already builds from it, and a warning when stored credentials were
 * carried over. get-actor-version shows the URL without its credentials, so an agent that sends that URL back, or
 * the same repository with another branch, must not remove them: builds of a private repository would then fail.
 */
function resolveGitRepoUrl(version: ActorVersion, requestedUrl: string): { url?: string; warning?: string } {
    const storedUrl = version.sourceType === ActorSourceType.GitRepo ? version.gitRepoUrl : undefined;
    if (!storedUrl || hasUrlSecrets(requestedUrl)) return storedUrl === requestedUrl ? {} : { url: requestedUrl };
    const shownUrl = formatUrlWithoutSecrets(requestedUrl);
    if (formatUrlWithoutSecrets(storedUrl) === shownUrl) return {};
    if (!hasUrlSecrets(storedUrl)) return { url: requestedUrl };
    const url = buildUrlWithStoredSecrets(storedUrl, requestedUrl);
    if (!url) {
        throw new UserInputError(
            'The stored Git URL carries credentials or a query string that are not shown, and they cannot be kept for ' +
                `${shownUrl}, which is on another host. Include the credentials in gitRepoUrl, or change the URL in ` +
                'Apify Console.',
        );
    }
    return { url, warning: `The credentials stored with the previous Git URL were kept for ${shownUrl}.` };
}

/** The whole update against the version as read; throws `UserInputError` (and `PreconditionError`) before any write. */
function resolveUpdateOutcome(params: {
    current: CurrentSource;
    version: ActorVersion;
    request: PreparedUpdate;
    args: UpdateActorVersionArgs;
    target: VersionTarget;
}): UpdateOutcome {
    const { current, version, request, args, target } = params;
    if (current.kind === 'url' && request.operations.length > 0) {
        throw new UserInputError(
            `Version ${target.versionNumber} of ${target.fullName} builds from ${formatUrlSourceText(current)}, so its ` +
                'files cannot be changed here; change them there. To build from stored files instead, send the whole ' +
                'file set as replaceFiles with expectedRevision.',
        );
    }
    if (args.expectedRevision !== undefined && args.expectedRevision.toLowerCase() !== current.revision) {
        throw new PreconditionError(
            PRECONDITION_REASON.REVISION_MISMATCH,
            undefined,
            `The version's revision is ${current.revision}, not ${args.expectedRevision}; it changed since it was read.`,
        );
    }
    const isBuildTagChanged = args.buildTag !== undefined && args.buildTag !== version.buildTag;
    const buildTagBody = args.buildTag === undefined ? {} : { buildTag: args.buildTag };
    if (request.gitRepoUrl !== undefined) {
        const resolved = resolveGitRepoUrl(version, request.gitRepoUrl);
        const gitRepoUrl = formatUrlWithoutSecrets(resolved.url ?? request.gitRepoUrl);
        const isSourceChanged = resolved.url !== undefined;
        const changed = isSourceChanged || isBuildTagChanged;
        const buildTagText = isBuildTagChanged ? `; build tag set to ${args.buildTag}` : '';
        return {
            sourceType: ActorSourceType.GitRepo,
            revision: buildUrlRevision(ActorSourceType.GitRepo, gitRepoUrl),
            changed,
            changeText: `it builds from the Git repository ${gitRepoUrl}${buildTagText}`,
            changes: [],
            excerpts: [],
            isExcerptTruncated: false,
            warnings: resolved.warning === undefined ? [] : [resolved.warning],
            // sourceType goes with the URL so the platform validates it; a gitRepoUrl alone skips that check.
            ...(changed && {
                putBody: {
                    ...(isSourceChanged && { sourceType: ActorSourceType.GitRepo, gitRepoUrl: resolved.url }),
                    ...buildTagBody,
                },
            }),
        };
    }
    const before = current.kind === 'files' ? current.files : undefined;
    if (current.kind === 'url' && request.replaceFiles === undefined) {
        // Only a buildTag change reaches here for a Git or gist version.
        return {
            sourceType: current.sourceType,
            revision: current.revision,
            changed: isBuildTagChanged,
            changeText: `build tag set to ${args.buildTag}`,
            changes: [],
            excerpts: [],
            isExcerptTruncated: false,
            warnings: [],
            ...(isBuildTagChanged && { putBody: buildTagBody }),
        };
    }
    const state =
        request.replaceFiles === undefined
            ? applyOperations(before ?? new Map(), request.operations)
            : {
                  files: buildReplacedFiles(request.replaceFiles, before),
                  touchedPaths: new Set<string>(),
                  editedRanges: new Map(),
              };
    const isReplacingAll = request.replaceFiles !== undefined;
    // replaceFiles starts from an empty set, so Console's empty folder entries go too.
    const folders = current.kind === 'files' && !isReplacingAll ? current.folders : [];
    const revision = buildFilesRevision([...state.files.values()].map(({ file }) => file));
    const isSourceChanged = current.kind === 'url' || revision !== current.revision;
    const changes = buildFileChanges(before ?? new Map(), state.files, state.touchedPaths);
    const { excerpts, isTruncated } = buildEditExcerpts(state, changes);
    const emptyPaths = changes
        .filter(({ action, sizeBytes }) => action !== 'deleted' && action !== 'unchanged' && sizeBytes === 0)
        .map(({ path, newPath }) => newPath ?? path);
    const warnings = [
        current.kind === 'url' &&
            `The version no longer builds from ${formatUrlSourceText(current)}; it now builds from the files stored in the version.`,
        formatEmptyFilesWarning(emptyPaths),
    ].filter((warning): warning is string => typeof warning === 'string');
    const changed = isSourceChanged || isBuildTagChanged;
    const sourceFiles =
        current.kind === 'files' && !isReplacingAll
            ? buildStoredEntries({ storedEntries: current.storedEntries, before: current.files, after: state.files })
            : [...state.files.values()].map(({ entry }) => entry);
    const buildTagText = isBuildTagChanged ? `; build tag set to ${args.buildTag}` : '';
    return {
        sourceType: ActorSourceType.SourceFiles,
        revision,
        changed,
        changeText: `${formatChangeCounts(changes)}${buildTagText}`,
        changes,
        excerpts,
        isExcerptTruncated: isTruncated,
        totalSizeBytes: isSourceChanged
            ? validateResultFiles({
                  files: state.files,
                  folders,
                  sourceFiles,
                  before: current.kind === 'files' ? current : undefined,
                  isReplacingAll,
              })
            : getInlineSourceBytes(sourceFiles),
        warnings,
        ...(changed && {
            putBody: {
                ...(isSourceChanged && { sourceType: ActorSourceType.SourceFiles, sourceFiles }),
                ...buildTagBody,
            },
        }),
    };
}

function formatUpdateSummary(target: VersionTarget, previousRevision: string, outcome: UpdateOutcome): string {
    const { changed, changes, revision, totalSizeBytes, warnings } = outcome;
    const subject = `version ${target.versionNumber} of ${target.fullName}`;
    const unchangedPaths = changes.filter(({ action }) => action === 'unchanged').map(({ path }) => path);
    const unchangedNote =
        unchangedPaths.length > 0 ? ` These files already had the content sent: ${unchangedPaths.join(', ')}.` : '';
    const sizeNote =
        totalSizeBytes === undefined
            ? ''
            : ` The stored files measure ${formatMib(totalSizeBytes)} of ${formatMib(MAX_INLINE_SOURCE_BYTES)} MiB.`;
    const excerptNote = outcome.isExcerptTruncated
        ? ` The excerpts cover only part of the edited lines (at most ${MAX_EXCERPT_BYTES / 1024} KiB).`
        : '';
    const warningNote = warnings.length > 0 ? ` ${warnings.join(' ')}` : '';
    if (!changed) {
        return `Nothing changed in ${subject}, so nothing was written; revision ${revision}.${unchangedNote}${warningNote}`;
    }
    const revisionNote =
        revision === previousRevision ? `revision ${revision}` : `revision ${previousRevision} is now ${revision}`;
    return `Updated ${subject}: ${outcome.changeText}; ${revisionNote}.${unchangedNote}${sizeNote}${excerptNote}${warningNote}`;
}

function formatNextStep(
    outcome: UpdateOutcome,
    buildResult: BuildAfterWriteResult | undefined,
    loadedToolNames: readonly string[],
): string {
    if (buildResult?.build) return buildNextStepForBuild(buildResult.build, { loadedToolNames });
    if (buildResult?.buildErrMessage !== undefined) {
        const writtenText = outcome.changed ? 'The change was saved' : 'Nothing needed saving';
        return formatBuildStartFailure(writtenText, buildResult.buildErrMessage, loadedToolNames);
    }
    if (!outcome.changed) return 'No build is needed for this call.';
    return `Runs keep using the previously tagged build until this version is built.${formatBuildLaterHint(loadedToolNames)}`;
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const readNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_GET)
        ? ` Read the version with ${HELPER_TOOLS.ACTOR_VERSION_GET} first: its hashes and revision are what expectedHash and expectedRevision take, and its content is what oldText is copied from.`
        : '';
    const waitNote = hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
        ? ` Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
        : '';
    return dedent`
        Change the source of a version of one of your own Actors: write, edit, delete, or move files, replace the whole file set, point the version at a Git repository, or set its buildTag.${readNote}
        The operations apply in order to a fresh read of the version and are saved together in one write; when any of them fails, nothing is saved.
        - write {path, content, encoding?}: creates a file, or replaces one given its expectedHash. The same content again is reported as unchanged.
        - edit {path, edits: [{oldText, newText, allOccurrences?}]}: replaces text in a UTF-8 file. Each oldText must match exactly once (at least once with allOccurrences), byte for byte.
        - delete {path, expectedHash}; move {path, newPath}: newPath must have no file.
        - replaceFiles replaces every file, and gitRepoUrl (repository#branch:directory) makes the version build from Git; both need expectedRevision. replaceFiles also turns a Git version into stored files.
        A failed check names the operation, the path, and one of FILE_EXISTS, FILE_NOT_FOUND, HASH_MISMATCH, NO_MATCH, MULTIPLE_MATCHES, REVISION_MISMATCH, or NOT_TEXT.
        Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it. Limits: ${MAX_OPERATIONS} operations, ${MAX_EDITS_PER_OPERATION} edits per operation, 2 MiB of content, oldText, and newText per call, and 3 MiB for the stored files. Versions stored as a zip cannot be changed with this tool yet.
        autoBuild starts a build after the write and returns without waiting.${waitNote} Without it, runs keep using the previous build.

        USAGE:
        - Use to fix a bug or add a feature in an Actor's code, a few files at a time.

        USAGE EXAMPLES:
        - user_input: Fix the typo in src/main.js of my Actor john/my-scraper
        - user_input: Add a README to my Actor and rebuild it`;
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/actor-version-get
 *  /v2/actors/{actorId}/versions/{versionNumber}
 * https://docs.apify.com/api/v2/actor-version-put
 *  /v2/actors/{actorId}/versions/{versionNumber}
 *
 * The operations apply to the version as read in this call, and the result is stored with one version PUT that
 * carries only the source keys and buildTag, never envVars or versionNumber. Conflicts are caught by each operation's
 * precondition and by expectedRevision. A save from Apify Console, `apify push`, or another MCP server that lands
 * between this call's read and its PUT is not detected: the platform's version PUT takes no precondition, and this
 * stays so until it gets a conditional one.
 */
export const updateActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_UPDATE,
    title: 'Update Actor version',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `autoBuild` from `required` because it has a default.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(updateActorVersionArgs)) as ToolInputSchema,
    outputSchema: updateActorVersionToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(updateActorVersionArgs)),
    annotations: {
        title: 'Update Actor version',
        readOnlyHint: false,
        // Writes, deletes, and replaceFiles overwrite files.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames, signal } = toolArgs;
        const parsed = updateActorVersionArgs.parse(args);
        try {
            const request = parseUpdateRequest(parsed, loadedToolNames);
            const { actor, fullName } = await resolveOwnActor({ client, apifyToken, actorSelector: parsed.actor });
            const addVersionHint = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_CREATE)
                ? ` To add it, use ${HELPER_TOOLS.ACTOR_VERSION_CREATE}.`
                : '';
            const versionNumber = resolveVersionNumber(actor, parsed.versionNumber, parsed.actor, addVersionHint);
            const target = { actorId: actor.id, fullName, versionNumber };
            const versionClient = client.actor(actor.id).version(versionNumber);
            const version = await versionClient.get();
            if (!version) throw new UserInputError(`Actor ${fullName} has no version ${versionNumber}.`);
            const current = readCurrentSource(version, target);
            const outcome = resolveUpdateOutcome({ current, version, request, args: parsed, target });
            // A cancel during the reads writes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            if (outcome.putBody) {
                // apify-client types the body as a whole version; the API takes any subset of its fields, and
                // sending only these keeps the PUT away from envVars and the rest.
                await versionClient.update(outcome.putBody as unknown as ActorVersion);
            }
            // Per the MCP spec a cancelled request gets no response; the write stands, and no build is started.
            if (signal?.aborted) return respondAborted();
            const buildResult = parsed.autoBuild
                ? await startBuildAfterWrite(client, actor.id, versionNumber)
                : undefined;
            const linkContext = buildResult?.build ? await getConsoleLinkContext(apifyToken, client) : undefined;
            const buildTag = parsed.buildTag ?? version.buildTag;
            const structuredContent = {
                ...target,
                sourceType: outcome.sourceType,
                ...(buildTag ? { buildTag } : {}),
                previousRevision: current.revision,
                revision: outcome.revision,
                changed: outcome.changed,
                changes: outcome.changes,
                excerpts: outcome.excerpts,
                ...(outcome.totalSizeBytes !== undefined && { totalSizeBytes: outcome.totalSizeBytes }),
                warnings: outcome.warnings,
                ...(buildResult?.build && { build: toBuildResult(buildResult.build, linkContext) }),
                ...(buildResult?.buildErrMessage !== undefined && { buildError: buildResult.buildErrMessage }),
            };
            return respondWithBuild({
                structuredContent,
                summary: formatUpdateSummary(target, current.revision, outcome),
                nextStep: formatNextStep(outcome, buildResult, loadedToolNames),
            });
        } catch (error) {
            if (error instanceof PreconditionError && error.isStaleRead) {
                const readAgain = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_GET)
                    ? `Read the version again with ${HELPER_TOOLS.ACTOR_VERSION_GET} and retry.`
                    : 'Read the version again and retry.';
                return respondUserError(`${error.message} ${readAgain}`);
            }
            return respondToSourceToolError(error);
        }
    },
} as const);
