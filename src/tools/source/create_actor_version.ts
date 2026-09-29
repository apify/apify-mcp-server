import type { Actor, ActorEnvironmentVariable, ActorVersion, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondAborted } from '../../utils/mcp.js';
import { listVersionNumbers } from '../builds/build_helpers.js';
import { createActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesManifest, buildFilesRevision } from './source_files.js';
import {
    buildEmptyFilesWarnings,
    buildSourceFileEntry,
    extractSourceFiles,
    fetchActor,
    resolveVersion,
    respondAfterWrite,
    respondToSourceToolError,
    sourceFileArgs,
} from './source_helpers.js';

/** The error type the platform returns when the Actor already has the version, also when two creates race. */
const VERSION_EXISTS_ERROR_TYPE = 'version-already-exists';

/** The build reads the Actor's configuration, such as its Dockerfile and input schema, from this file. */
const ACTOR_CONFIG_PATH = '.actor/actor.json';

const createActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to add the version to: its ID, or its full name as username/name or username~name. ' +
                'A name without the username is not enough.',
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
    files: z.array(sourceFileArgs).min(1).optional().describe("The version's files, each with its whole content."),
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
    | { kind: 'copy'; versionNumber: string };

/** The version to create, as the POST body and as the result describes it. */
type NewVersion = {
    entries: ActorVersionSourceFile[];
    envVars: ActorEnvironmentVariable[];
    applyEnvVarsToBuild: boolean;
    secretEnvVarNames: string[];
};

/** Checks the input without any API call; throws `UserInputError` for the first problem. */
function parseCreateVersionRequest(args: CreateActorVersionArgs): RequestedSource {
    const { copyFromVersion, files } = args;
    if (copyFromVersion !== undefined && files !== undefined) {
        throw new UserInputError('Give at most one of copyFromVersion or files.');
    }
    if (copyFromVersion !== undefined) return { kind: 'copy', versionNumber: copyFromVersion };
    if (files === undefined) {
        if (args.autoBuild) {
            throw new UserInputError(
                'An empty version has nothing to build. Give copyFromVersion or files, or leave out autoBuild.',
            );
        }
        return { kind: 'empty' };
    }
    return { kind: 'files', entries: files.map(buildSourceFileEntry) };
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
    entries: readonly ActorVersionSourceFile[],
): string | undefined {
    if (actor.actorStandby?.isEnabled === true) return undefined;
    const config = entries.find(({ name }) => name === ACTOR_CONFIG_PATH);
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
 * The copy of a version as read: its files exactly as stored, so formats and folder entries are kept. Throws
 * `UserInputError` for a version not stored as files and for one whose source the API hid.
 */
function buildCopiedVersion(version: ActorVersion, versionLabel: string): NewVersion {
    return {
        entries: extractSourceFiles(version, versionLabel),
        ...splitEnvVars(version.envVars),
        applyEnvVarsToBuild: version.applyEnvVarsToBuild === true,
    };
}

function buildNewVersion(source: Exclude<RequestedSource, { kind: 'copy' }>): NewVersion {
    // The platform takes an empty list of files, which gives a version to fill later.
    const entries = source.kind === 'files' ? source.entries : [];
    return { entries, envVars: [], applyEnvVarsToBuild: false, secretEnvVarNames: [] };
}

function formatSourceText(source: RequestedSource, fileCount: number): string {
    const filesText = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
    if (source.kind === 'copy') return `as a copy of version ${source.versionNumber} (${filesText})`;
    if (source.kind === 'files') return `from ${filesText}`;
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

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const updateNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_UPDATE)
        ? ` To change an existing version, use ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}.`
        : '';
    const fillNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_UPDATE) ? ` with ${HELPER_TOOLS.ACTOR_VERSION_UPDATE}` : '';
    const waitNote = hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
        ? ` Follow the build with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
        : '';
    return dedent`
        Add a new version to an Actor: a copy of another version, new files, or an empty version.
        It never changes an existing version: a versionNumber the Actor already has is refused.${updateNote}
        - copyFromVersion: copies that version's files on the server exactly as they are stored, so no file content passes through the call. Non-secret environment variables are copied with their values; secret values cannot be read, so their names come back in secretEnvVarsNotCopied. Only versions stored as files can be copied.
        - files: every file with its path and content. Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it.
        - None of them: an empty version with no files, to fill later${fillNote}.
        Give at most one of them. The result lists each file's hash and the version's revision.
        buildTag has no default: without it, the version's builds get no tag, so a working copy never takes over a tag such as latest; run its builds by build number. autoBuild starts a build after creating the version and returns without waiting.${waitNote}

        USAGE:
        - Use to make a working copy of a version to change and test while the tagged build keeps running, or to add a version with new source.

        USAGE EXAMPLES:
        - user_input: Copy version 0.1 of my Actor john/my-scraper to a new version 0.2`;
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
        const { args, apifyClient: client, loadedToolNames, signal } = toolArgs;
        const parsed = createActorVersionArgs.parse(args);
        try {
            const source = parseCreateVersionRequest(parsed);
            const { actor, fullName } = await fetchActor(client, parsed.actor);
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
                const sourceVersionNumber = resolveVersion(actor, source.versionNumber, parsed.actor).versionNumber;
                // TODO: A copy reads every file of the source version here and sends them all back in the POST below:
                // the Apify API cannot copy a version or apply atomic changes to an Actor's source. Once it can, let
                // the platform make the copy.
                const sourceVersion = await client.actor(actor.id).version(sourceVersionNumber).get();
                if (!sourceVersion) {
                    throw new UserInputError(`Actor ${fullName} has no version ${sourceVersionNumber}.`);
                }
                newVersion = buildCopiedVersion(sourceVersion, `Version ${sourceVersionNumber} of ${fullName}`);
            } else {
                newVersion = buildNewVersion(source);
            }
            const files = buildFilesManifest(newVersion.entries);
            const emptyPaths = files.filter(({ sizeBytes }) => sizeBytes === 0).map(({ path }) => path);
            const standbyWarning = formatStandbyWarning(actor, newVersion.entries);
            const warnings = [
                ...(buildEmptyFilesWarnings(emptyPaths).warnings ?? []),
                ...(standbyWarning === undefined ? [] : [standbyWarning]),
            ];
            // A cancel before the POST creates nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            try {
                await client
                    .actor(actor.id)
                    .versions()
                    .create({
                        versionNumber,
                        ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                        sourceType: ActorSourceType.SourceFiles,
                        sourceFiles: newVersion.entries,
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
            const revision = buildFilesRevision(files);
            const { secretEnvVarNames } = newVersion;
            const tagText =
                parsed.buildTag === undefined
                    ? 'no build tag, so its builds do not move tags such as latest'
                    : `build tag ${parsed.buildTag}`;
            const warningNote = warnings.length > 0 ? ` ${warnings.join(' ')}` : '';
            return await respondAfterWrite({
                toolArgs,
                autoBuild: parsed.autoBuild,
                target: { actorId: actor.id, versionNumber },
                structuredContent: {
                    actorId: actor.id,
                    fullName,
                    versionNumber,
                    ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                    revision,
                    files: files.map(({ path, sizeBytes, hash }) => ({ path, sizeBytes, hash })),
                    ...(source.kind === 'copy' && { copiedFromVersion: source.versionNumber }),
                    ...(secretEnvVarNames.length > 0 && { secretEnvVarsNotCopied: secretEnvVarNames }),
                    warnings,
                },
                summary:
                    `Created version ${versionNumber} of ${fullName} ${formatSourceText(source, files.length)}, ` +
                    `${tagText}, revision ${revision}.${formatEnvVarsNote(newVersion, versionNumber)}${warningNote}`,
            });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
