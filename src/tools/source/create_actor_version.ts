import type {
    Actor,
    ActorEnvironmentVariable,
    ActorVersion,
    ActorVersionGitHubGist,
    ActorVersionGitRepo,
    ActorVersionSourceFile,
    ActorVersionSourceFiles,
} from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted } from '../../utils/mcp.js';
import { buildNextStepForBuild, listVersionNumbers, respondWithBuild, toBuildResult } from '../builds/build_helpers.js';
import { createActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesRevision, buildUrlRevision } from './source_files.js';
import type { BuildAfterWriteResult } from './source_helpers.js';
import {
    ACTOR_CONFIG_PATH,
    buildFilesManifest,
    buildSentFilesWarnings,
    formatBuildLaterHint,
    formatBuildStartFailure,
    formatUrlSourceText,
    formatUrlWithoutSecrets,
    formatWithUpdateToolText,
    hasUrlSecrets,
    MAX_WRITE_FILES,
    parseInputFiles,
    resolveOwnActor,
    resolveVersionNumber,
    respondToSourceToolError,
    sourceFileArgs,
    startBuildAfterWrite,
    validateNewFilesCallSize,
} from './source_helpers.js';

/** The error type the platform returns when the Actor already has the version, also when two creates race. */
const VERSION_EXISTS_ERROR_TYPE = 'version-already-exists';

const createActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to add the version to: its ID, or its full name as username/name or username~name. ' +
                'A name without the username is not enough. It must be in your own account.',
        ),
    versionNumber: z
        .string()
        .min(1)
        .describe(
            'Number of the new version in MAJOR.MINOR form, for example 0.2, each part 0 to 99. The Actor must not have it yet.',
        ),
    copyFromVersion: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Copy the source and the non-secret environment variables of this existing version, for example 0.1. ' +
                'The source is copied on the server and does not pass through this call.',
        ),
    files: z
        .array(sourceFileArgs)
        .min(1)
        .max(MAX_WRITE_FILES)
        .optional()
        .describe(`The version's files, 1 to ${MAX_WRITE_FILES}; they must include ${ACTOR_CONFIG_PATH}.`),
    gitRepoUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Build the version from this Git repository, as repository#branch:directory (branch and directory are optional).',
        ),
    buildTag: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Tag that builds of the new version get, for example beta. No default: without it, its builds get no tag.',
        ),
    autoBuild: z
        .boolean()
        .default(false)
        .describe('Start a build of the new version after creating it, and return without waiting. Default: false.'),
});

type CreateActorVersionArgs = z.infer<typeof createActorVersionArgs>;

type RequestedSource =
    | { kind: 'empty' }
    | { kind: 'files'; entries: ActorVersionSourceFile[] }
    | { kind: 'git'; gitRepoUrl: string }
    | { kind: 'copy'; versionNumber: string };

/** The source keys of the POST body: sourceType and the one field that holds the source. */
type SourceBody =
    | Pick<ActorVersionSourceFiles, 'sourceType' | 'sourceFiles'>
    | Pick<ActorVersionGitRepo, 'sourceType' | 'gitRepoUrl'>
    | Pick<ActorVersionGitHubGist, 'sourceType' | 'gitHubGistUrl'>;

/** The version to create, as the POST body and as the result describes it. */
type NewVersion = {
    sourceBody: SourceBody;
    sourceType: string;
    /** The stored entries, for the manifest; undefined for a version built from a URL. */
    entries?: readonly ActorVersionSourceFile[];
    /** The URL without its credentials, for the revision and the summary; set for a version built from a URL. */
    shownUrl?: string;
    envVars: ActorEnvironmentVariable[];
    applyEnvVarsToBuild: boolean;
    secretEnvVarNames: string[];
    warnings: string[];
};

/** Checks the input without any API call; throws `UserInputError` for the first problem. */
function parseCreateVersionRequest(args: CreateActorVersionArgs, loadedToolNames: readonly string[]): RequestedSource {
    const { copyFromVersion, files, gitRepoUrl } = args;
    const sourceCount = [copyFromVersion, files, gitRepoUrl].filter((source) => source !== undefined).length;
    if (sourceCount > 1) throw new UserInputError('Give at most one of copyFromVersion, files, or gitRepoUrl.');
    if (copyFromVersion !== undefined) return { kind: 'copy', versionNumber: copyFromVersion };
    if (gitRepoUrl !== undefined) return { kind: 'git', gitRepoUrl };
    if (files === undefined) {
        if (args.autoBuild) {
            throw new UserInputError(
                'An empty version has nothing to build. Give copyFromVersion, files, or gitRepoUrl, or leave out autoBuild.',
            );
        }
        return { kind: 'empty' };
    }
    validateNewFilesCallSize(files, { subject: 'version', loadedToolNames });
    return { kind: 'files', entries: parseInputFiles(files) };
}

/** The platform's limit for each part of MAJOR.MINOR. */
const MAX_VERSION_PART = 99;

/** A number after the highest MAJOR.MINOR version, for the caller to pick instead; undefined when none is left. */
function suggestFreeVersionNumber(versionNumbers: readonly string[]): string | undefined {
    const parsed = versionNumbers.flatMap((versionNumber) => {
        const match = /^(\d+)\.(\d+)$/.exec(versionNumber);
        return match ? [{ major: Number(match[1]), minor: Number(match[2]) }] : [];
    });
    if (parsed.length === 0) return undefined;
    const { major, minor } = parsed.reduce((highest, part) =>
        part.major > highest.major || (part.major === highest.major && part.minor > highest.minor) ? part : highest,
    );
    if (minor < MAX_VERSION_PART) return `${major}.${minor + 1}`;
    return major < MAX_VERSION_PART ? `${major + 1}.0` : undefined;
}

/**
 * Leads with a free number, since a parallel caller that finds the number taken needs a version of its own; changing
 * the existing version is offered only to a caller who meant that version.
 */
function formatVersionExistsText(params: {
    fullName: string;
    versionNumber: string;
    versionNumbers: readonly string[];
    loadedToolNames: readonly string[];
}): string {
    const { fullName, versionNumber, loadedToolNames } = params;
    // After a race the versions were read before the other call created this one.
    const versionNumbers = params.versionNumbers.includes(versionNumber)
        ? params.versionNumbers
        : [...params.versionNumbers, versionNumber];
    const freeVersionNumber = suggestFreeVersionNumber(versionNumbers);
    const pickText =
        freeVersionNumber === undefined
            ? ' Pick another versionNumber.'
            : ` Pick another versionNumber, such as ${freeVersionNumber}.`;
    const updateHint = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_UPDATE)
        ? ` If you meant to change version ${versionNumber} itself, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`
        : '';
    return (
        `${fullName} already has version ${versionNumber}, and this tool never changes an existing version. ` +
        `Its versions: ${versionNumbers.join(', ')}.${pickText}${updateHint}`
    );
}

/**
 * The warning for a version that turns Standby on for the whole Actor. The platform's version POST does that when the
 * first entry named `.actor/actor.json` sets usesStandbyMode and Standby is off. It parses the content as stored, so a
 * BASE64 entry never turns it on; it reads JSON5, and a file JSON.parse cannot read only loses this warning.
 */
function formatStandbyWarning(
    actor: Pick<Actor, 'actorStandby'>,
    entries: readonly ActorVersionSourceFile[] | undefined,
): string | undefined {
    if (actor.actorStandby?.isEnabled === true) return undefined;
    const config = entries?.find(({ name }) => name === ACTOR_CONFIG_PATH);
    if (!config || config.format === 'BASE64' || typeof config.content !== 'string') return undefined;
    try {
        const parsed = JSON.parse(config.content) as { usesStandbyMode?: unknown };
        if (!parsed?.usesStandbyMode) return undefined;
    } catch {
        return undefined;
    }
    return (
        `Creating this version turned on Standby for the whole Actor, because its ${ACTOR_CONFIG_PATH} sets ` +
        'usesStandbyMode and Standby was off. Turn it off again in Apify Console if it should stay off.'
    );
}

/**
 * Non-secret env vars go to the copy with their values. The API returns a secret with its value removed, so it cannot
 * be copied; its name is returned for the caller to set it again.
 */
function splitEnvVars(envVars: readonly ActorEnvironmentVariable[] | undefined): {
    envVars: ActorEnvironmentVariable[];
    secretEnvVarNames: string[];
} {
    const copied: ActorEnvironmentVariable[] = [];
    const secretEnvVarNames: string[] = [];
    for (const { name, value, isSecret } of envVars ?? []) {
        if (name === undefined) continue;
        if (isSecret === true) secretEnvVarNames.push(name);
        else copied.push({ name, value, isSecret: false });
    }
    return { envVars: copied, secretEnvVarNames };
}

/**
 * The copy of a version as read: its source exactly as stored, so formats, folder entries, and the credentials stored
 * with a URL are kept. Throws `UserInputError` for a zip-stored version, which this tool cannot copy yet, and for a
 * source the API hid or a type it does not know.
 */
function buildCopiedVersion(
    version: ActorVersion,
    {
        fullName,
        sourceVersionNumber,
        versionNumber,
    }: { fullName: string; sourceVersionNumber: string; versionNumber: string },
): NewVersion {
    const { sourceType }: { sourceType: string } = version;
    const subject = `Version ${sourceVersionNumber} of ${fullName}`;
    const hiddenText = `${subject} came back without its source, so it cannot be copied.`;
    const env = { ...splitEnvVars(version.envVars), applyEnvVarsToBuild: version.applyEnvVarsToBuild === true };
    if (version.sourceType === ActorSourceType.SourceFiles) {
        if (!Array.isArray(version.sourceFiles)) throw new UserInputError(hiddenText);
        const entries = version.sourceFiles;
        const sourceBody = { sourceType: ActorSourceType.SourceFiles, sourceFiles: entries } as const;
        return { ...env, sourceType, sourceBody, entries, warnings: [] };
    }
    if (version.sourceType === ActorSourceType.GitRepo || version.sourceType === ActorSourceType.GitHubGist) {
        const url = version.sourceType === ActorSourceType.GitRepo ? version.gitRepoUrl : version.gitHubGistUrl;
        if (!url) throw new UserInputError(hiddenText);
        const shownUrl = formatUrlWithoutSecrets(url);
        const warnings = hasUrlSecrets(url)
            ? [
                  `The credentials stored with the URL of version ${sourceVersionNumber} were copied too; they are not shown.`,
              ]
            : [];
        const sourceBody: SourceBody =
            version.sourceType === ActorSourceType.GitRepo
                ? { sourceType: ActorSourceType.GitRepo, gitRepoUrl: url }
                : { sourceType: ActorSourceType.GitHubGist, gitHubGistUrl: url };
        return { ...env, sourceType, sourceBody, shownUrl, warnings };
    }
    if (version.sourceType === ActorSourceType.Tarball) {
        // apify push takes the tag from .actor/actor.json without --build-tag and always builds, so the hint sets one.
        throw new UserInputError(
            `${subject} is stored as a zip (TARBALL), and this tool cannot copy zip-stored versions yet. Give the ` +
                'source as files or gitRepoUrl instead. Or upload your local project folder (not the stored zip) ' +
                `with the Apify CLI and a build tag no other version uses: apify push --version ${versionNumber} ` +
                `--build-tag wip-${versionNumber.replace('.', '-')}. Without --build-tag, apify push takes the tag ` +
                'from .actor/actor.json, often latest, and it builds right away.',
        );
    }
    throw new UserInputError(`${subject} has source type ${sourceType}, which this tool cannot copy.`);
}

function buildNewVersion(source: Exclude<RequestedSource, { kind: 'copy' }>): NewVersion {
    const common = { envVars: [], applyEnvVarsToBuild: false, secretEnvVarNames: [] };
    if (source.kind === 'git') {
        return {
            ...common,
            sourceType: ActorSourceType.GitRepo,
            sourceBody: { sourceType: ActorSourceType.GitRepo, gitRepoUrl: source.gitRepoUrl },
            shownUrl: formatUrlWithoutSecrets(source.gitRepoUrl),
            warnings: [],
        };
    }
    // The platform takes an empty list of files, which gives a version to fill later.
    const entries = source.kind === 'files' ? source.entries : [];
    return {
        ...common,
        sourceType: ActorSourceType.SourceFiles,
        sourceBody: { sourceType: ActorSourceType.SourceFiles, sourceFiles: entries },
        entries,
        warnings: source.kind === 'files' ? buildSentFilesWarnings(entries) : [],
    };
}

function formatSourceText(source: RequestedSource, newVersion: NewVersion, fileCount: number): string {
    const filesText = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
    const { sourceType, shownUrl } = newVersion;
    const urlText = shownUrl === undefined ? '' : formatUrlSourceText({ sourceType, url: shownUrl });
    if (source.kind === 'copy') {
        const copiedText = shownUrl === undefined ? filesText : `building from ${urlText}`;
        return `as a copy of version ${source.versionNumber} (${copiedText})`;
    }
    if (source.kind === 'files') return `from ${filesText}`;
    if (source.kind === 'git') return `from ${urlText}`;
    return 'with no files';
}

function formatEnvVarsNote(newVersion: NewVersion, versionNumber: string): string {
    const { envVars, secretEnvVarNames } = newVersion;
    const copiedNote =
        envVars.length > 0
            ? ` Copied ${envVars.length} environment ${envVars.length === 1 ? 'variable with its value' : 'variables with their values'}.`
            : '';
    const secretNote =
        secretEnvVarNames.length > 0
            ? ` These secret environment variables were not copied, because their values cannot be read: ` +
              `${secretEnvVarNames.join(', ')}. Set them on version ${versionNumber} yourself, for example in Apify Console.`
            : '';
    return `${copiedNote}${secretNote}`;
}

function formatNextStep(params: {
    source: RequestedSource;
    buildResult: BuildAfterWriteResult | undefined;
    loadedToolNames: readonly string[];
}): string {
    const { source, buildResult, loadedToolNames } = params;
    if (buildResult?.build) return buildNextStepForBuild(buildResult.build, { loadedToolNames });
    if (buildResult?.buildErrMessage !== undefined) {
        return formatBuildStartFailure('The version was created', buildResult.buildErrMessage, loadedToolNames);
    }
    if (source.kind === 'empty') {
        return `The version has no files yet: add them${formatWithUpdateToolText(loadedToolNames)}, then build it.`;
    }
    return `The version has no build yet, so it cannot run until it is built.${formatBuildLaterHint(loadedToolNames)}`;
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const updateNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_UPDATE)
        ? ` To change an existing version, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`
        : '';
    const fillNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_UPDATE) ? ` with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}` : '';
    const waitNote = hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
        ? ` Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
        : '';
    return dedent`
        Add a new version to one of your own Actors: a copy of another version, new files, a Git repository to build from, or an empty version.
        It never changes an existing version: a versionNumber the Actor already has is refused.${updateNote}
        - copyFromVersion: copies that version's source on the server, so no file content passes through the call: stored files exactly as they are, or the Git or gist URL with any credentials stored with it. Non-secret environment variables are copied with their values; secret values cannot be read, so their names come back in secretEnvVarsNotCopied. Versions stored as a zip cannot be copied yet.
        - files: every file with its path and content; they must include ${ACTOR_CONFIG_PATH}. Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it.
        - gitRepoUrl: repository#branch:directory, with the branch and directory optional.
        - None of them: an empty version with no files, to fill later${fillNote}.
        Give at most one of them. Limits: ${MAX_WRITE_FILES} files and 2 MiB of content. The result lists each file's hash and the version's revision.
        buildTag has no default: without it, the version's builds get no tag, so a working copy never takes over a tag such as latest; run its builds by build number. autoBuild starts a build after creating the version and returns without waiting.${waitNote}

        USAGE:
        - Use to make a working copy of a version to change and test while the tagged build keeps running, or to add a version with new source.

        USAGE EXAMPLES:
        - user_input: Copy version 0.1 of my Actor john/my-scraper to a new version 0.2
        - user_input: Add version 1.0 to my Actor, built from https://github.com/john/my-actor.git`;
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/actor-version-get
 *  /v2/actors/{actorId}/versions/{versionNumber}
 * https://docs.apify.com/api/v2/actor-versions-post
 *  /v2/actors/{actorId}/versions
 *
 * One POST creates the version with its source, so a failed call leaves nothing behind. A copy reads the other version
 * in this call and sends its source as stored, so the content never passes through the model.
 */
export const createActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_CREATE,
    title: 'Create Actor version',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `autoBuild` from `required` because it has a default.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(createActorVersionArgs)) as ToolInputSchema,
    outputSchema: createActorVersionToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(createActorVersionArgs)),
    annotations: {
        title: 'Create Actor version',
        readOnlyHint: false,
        destructiveHint: false,
        // A second call with the same versionNumber is refused rather than repeated.
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames, signal } = toolArgs;
        const parsed = createActorVersionArgs.parse(args);
        try {
            const source = parseCreateVersionRequest(parsed, loadedToolNames);
            const { actor, fullName } = await resolveOwnActor({ client, apifyToken, actorSelector: parsed.actor });
            const { versionNumber } = parsed;
            const versionNumbers = listVersionNumbers(actor);
            const versionExistsText = formatVersionExistsText({
                fullName,
                versionNumber,
                versionNumbers,
                loadedToolNames,
            });
            if (versionNumbers.includes(versionNumber)) throw new UserInputError(versionExistsText);
            let newVersion: NewVersion;
            if (source.kind === 'copy') {
                const sourceVersionNumber = resolveVersionNumber(actor, source.versionNumber, parsed.actor);
                // TODO: A copy reads every file of the source version here and sends them all back in the POST below:
                // the Apify API cannot copy a version or apply atomic changes to an Actor's source. Once it can, let
                // the platform make the copy.
                const sourceVersion = await client.actor(actor.id).version(sourceVersionNumber).get();
                if (!sourceVersion) {
                    throw new UserInputError(`Actor ${fullName} has no version ${sourceVersionNumber}.`);
                }
                newVersion = buildCopiedVersion(sourceVersion, { fullName, sourceVersionNumber, versionNumber });
            } else {
                newVersion = buildNewVersion(source);
            }
            const standbyWarning = formatStandbyWarning(actor, newVersion.entries);
            if (standbyWarning !== undefined) newVersion.warnings.push(standbyWarning);
            // A cancel before the POST creates nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            try {
                await client
                    .actor(actor.id)
                    .versions()
                    .create({
                        versionNumber,
                        ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                        ...newVersion.sourceBody,
                        ...(newVersion.envVars.length > 0 && { envVars: newVersion.envVars }),
                        ...(newVersion.applyEnvVarsToBuild && { applyEnvVarsToBuild: true }),
                    } satisfies ActorVersion);
            } catch (error) {
                if (error instanceof ApifyApiError && error.type === VERSION_EXISTS_ERROR_TYPE) {
                    throw new UserInputError(versionExistsText);
                }
                throw error;
            }
            // Per the MCP spec a cancelled request gets no response; the version stands, and no build is started.
            if (signal?.aborted) return respondAborted();
            const buildResult = parsed.autoBuild
                ? await startBuildAfterWrite(client, actor.id, versionNumber)
                : undefined;
            const linkContext = buildResult?.build ? await getConsoleLinkContext(apifyToken, client) : undefined;
            const files = newVersion.entries === undefined ? [] : buildFilesManifest(newVersion.entries);
            const revision =
                newVersion.shownUrl === undefined
                    ? buildFilesRevision(files)
                    : buildUrlRevision(newVersion.sourceType, newVersion.shownUrl);
            const { secretEnvVarNames, warnings } = newVersion;
            const structuredContent = {
                actorId: actor.id,
                fullName,
                versionNumber,
                sourceType: newVersion.sourceType,
                ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                revision,
                files: files.map(({ path, sizeBytes, hash, format }) => ({ path, sizeBytes, hash, format })),
                ...(source.kind === 'copy' && { copiedFromVersion: source.versionNumber }),
                ...(secretEnvVarNames.length > 0 && { secretEnvVarsNotCopied: secretEnvVarNames }),
                warnings,
                ...(buildResult?.build && { build: toBuildResult(buildResult.build, linkContext) }),
                ...(buildResult?.buildErrMessage !== undefined && { buildError: buildResult.buildErrMessage }),
            };
            const tagText =
                parsed.buildTag === undefined
                    ? 'no build tag, so its builds do not move tags such as latest'
                    : `build tag ${parsed.buildTag}`;
            const warningNote = warnings.length > 0 ? ` ${warnings.join(' ')}` : '';
            const summary =
                `Created version ${versionNumber} of ${fullName} ${formatSourceText(source, newVersion, files.length)}, ` +
                `${tagText}, revision ${revision}.${formatEnvVarsNote(newVersion, versionNumber)}${warningNote}`;
            return respondWithBuild({
                structuredContent,
                summary,
                nextStep: formatNextStep({ source, buildResult, loadedToolNames }),
            });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
