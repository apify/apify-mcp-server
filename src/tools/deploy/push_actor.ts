import type { ActorCollectionCreateOptions, ActorVersionSourceFile, ActorVersionSourceFiles, Build } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';
import { pushActorToolOutputSchema } from '../structured_output_schemas.js';
import { buildNextStepForBuild, startBuild, toBuildResult } from './build_helpers.js';
import {
    ACTOR_CONFIG_PATH,
    getSourceFilesSizeBytes,
    hasActorConfig,
    mergeSourceFiles,
    MULTIFILE_SOURCE_MAX_BYTES,
    MULTIFILE_SOURCE_MAX_MIB,
    toSourceFiles,
    validateSourceFiles,
} from './source_files.js';

/** `apify push` defaults to this tag too, because the platform complains when an Actor has no `latest` build. */
const DEFAULT_BUILD_TAG = 'latest';

/** `apify push` starts a new Actor at this version. */
const DEFAULT_VERSION_NUMBER = '0.0';

const pushActorArgs = z.object({
    actorName: z
        .string()
        .min(3)
        .regex(
            /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]$/,
            'Actor name must be 3 to 63 letters, digits and dashes, cannot start or end with a dash, and may be prefixed with your username and a slash',
        )
        .describe(
            'Actor name in your account, bare (my-scraper) or with your username (john/my-scraper); created if it does not exist. The returned actorId is the Actor ID the build and run tools take',
        ),
    versionNumber: z
        .string()
        .regex(/^\d+\.\d+$/, 'Version number must be MAJOR.MINOR, for example 0.1')
        .optional()
        .describe(
            'Version to push the files to, in MAJOR.MINOR form. Defaults to the only version of an existing Actor, or to 0.0 for a new Actor; a version that does not exist yet is created',
        ),
    buildTag: z.string().min(1).optional().describe('Build tag for this version, for example latest'),
    files: z
        .array(
            z.object({
                path: z
                    .string()
                    .min(1)
                    .describe('Path relative to the Actor root, for example .actor/actor.json or src/main.js'),
                content: z.string().describe('File content, as text or as base64 when encoding is base64'),
                // `.optional()` instead of `.default('utf8')`: `fixZodSchemaRequired` only fixes top-level
                // fields, so a nested default would stay in the item's `required` list and AJV would
                // reject files that omit it.
                encoding: z.enum(['utf8', 'base64']).optional().describe('Use base64 for binary files; defaults to utf8'),
            }),
        )
        .min(1)
        .describe('Files to upload'),
    mode: z
        .enum(['merge', 'replace'])
        .default('merge')
        .describe('merge keeps existing files not listed here; replace makes the version contain exactly these files'),
    build: z.boolean().default(true).describe('Start a build of the version after pushing the files'),
    waitSecs: z
        .number()
        .int()
        .min(0)
        .max(WAIT_SECS_MAX)
        .default(WAIT_SECS_MAX)
        .describe('How long to wait for the build to finish before returning its current status'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const actorIdTakers = [HELPER_TOOLS.ACTOR_BUILD, HELPER_TOOLS.ACTOR_CALL].filter(hasTool);
    return `Push source files to an Actor in your account and, by default, build the pushed version.
Creates the Actor when it does not exist and creates or updates the version otherwise: the equivalent of the Apify CLI's apify push.
Returns the Actor ID and name, the version, its build tag, the number of files now in the version, the build when one was started, and a summary with one next step.${
        actorIdTakers.length > 0 ? ` Pass the returned actorId as actor to ${actorIdTakers.join(' and ')}.` : ''
    }
Files are text (utf8) or base64 for binaries; paths are relative to the Actor root and the version must end up containing ${ACTOR_CONFIG_PATH}.
The files may total at most ${MULTIFILE_SOURCE_MAX_MIB} MiB; larger projects need the Apify CLI.
Omit versionNumber to push to the only version of an existing Actor; an Actor with several versions needs it, and a version that does not exist yet is created.
mode merge (default) keeps files already in the version that are not listed; mode replace makes the version contain exactly the listed files.${
        hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
            ? ` If the build is still running when the wait ends, check it with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
            : ''
    }${
        hasTool(HELPER_TOOLS.ACTOR_BUILD)
            ? ` Set build to false to push without building and build later with ${HELPER_TOOLS.ACTOR_BUILD}.`
            : ''
    }

USAGE:
- Use to deploy a new Actor from source files written in the conversation or read from disk.
- Use to change one or more files of an existing Actor version and rebuild it.

USAGE EXAMPLES:
- user_input: Deploy this code as an Actor called my-scraper
- user_input: Update src/main.js in my-scraper and rebuild it`;
}

type PushSourceFilesParams = {
    client: ApifyClient;
    /** As given by the caller: a bare name or `username/name`. */
    actorName: string;
    versionNumber: string | undefined;
    buildTag: string | undefined;
    mode: 'merge' | 'replace';
    sourceFiles: ActorVersionSourceFile[];
};

type PushSourceFilesResult = {
    actorId: string;
    /** Full name, `username/name`. */
    actorName: string;
    versionNumber: string;
    /** The Actor was created; false when only the version was created or updated. */
    created: boolean;
    versionCreated: boolean;
    buildTag: string;
    /** Files now in the version: the pushed files plus, in merge mode, the kept ones. */
    filesPushed: number;
};

const ACTOR_CONFIG_MISSING_TEXT = `The files must include ${ACTOR_CONFIG_PATH}; the platform needs it to build the Actor.`;

/** Splits `username/name` into its parts; a bare name has no `ownerPrefix`. */
function parseActorName(actorName: string): { ownerPrefix: string | undefined; bareName: string } {
    const slashIndex = actorName.indexOf('/');
    if (slashIndex === -1) return { ownerPrefix: undefined, bareName: actorName };
    return { ownerPrefix: actorName.slice(0, slashIndex), bareName: actorName.slice(slashIndex + 1) };
}

function formatVersionList(versionNumbers: readonly string[]): string {
    if (versionNumbers.length === 0) return 'this Actor has no versions';
    return `this Actor has versions: ${versionNumbers.join(', ')}`;
}

/**
 * Creates the Actor with the files, or creates or updates the version of an existing Actor. Returns
 * `userError` for problems the user must fix; `envVars` is never sent so the version keeps its own.
 */
async function pushSourceFiles(params: PushSourceFilesParams): Promise<PushSourceFilesResult | { userError: string }> {
    const { client, buildTag, mode, sourceFiles } = params;
    const { username } = await client.user('me').get();
    const { ownerPrefix, bareName } = parseActorName(params.actorName);
    if (ownerPrefix !== undefined && ownerPrefix.toLowerCase() !== username.toLowerCase()) {
        return {
            userError: `This tool pushes only to your own account (${username}); '${params.actorName}' names another account.`,
        };
    }
    const actorName = `${username}/${bareName}`;
    const actorClient = client.actor(actorName);
    const actor = await actorClient.get();
    if (!actor) {
        if (!hasActorConfig(sourceFiles)) return { userError: ACTOR_CONFIG_MISSING_TEXT };
        const versionNumber = params.versionNumber ?? DEFAULT_VERSION_NUMBER;
        const created = await client.actors().create({
            name: bareName,
            versions: [
                {
                    versionNumber,
                    buildTag: buildTag ?? DEFAULT_BUILD_TAG,
                    sourceType: ActorSourceType.SourceFiles,
                    sourceFiles,
                },
            ],
        } satisfies ActorCollectionCreateOptions);
        return {
            actorId: created.id,
            actorName,
            versionNumber,
            created: true,
            versionCreated: true,
            buildTag: buildTag ?? DEFAULT_BUILD_TAG,
            filesPushed: sourceFiles.length,
        };
    }

    const versionNumbers = actor.versions.flatMap((version) => version.versionNumber ?? []);
    if (params.versionNumber === undefined && versionNumbers.length > 1) {
        return { userError: `Specify versionNumber; ${formatVersionList(versionNumbers)}.` };
    }
    const versionNumber = params.versionNumber ?? versionNumbers[0] ?? DEFAULT_VERSION_NUMBER;
    const versionClient = actorClient.version(versionNumber);
    const existing = await versionClient.get();
    if (!existing) {
        // Only merge mode reaches this check; replace mode was checked before any API call. The version
        // list tells the caller a new version is about to be created, in case that was not intended.
        if (!hasActorConfig(sourceFiles)) {
            return {
                userError: `Version ${versionNumber} does not exist and would be created (${formatVersionList(versionNumbers)}). ${ACTOR_CONFIG_MISSING_TEXT}`,
            };
        }
        await actorClient.versions().create({
            versionNumber,
            buildTag: buildTag ?? DEFAULT_BUILD_TAG,
            sourceType: ActorSourceType.SourceFiles,
            sourceFiles,
        } satisfies ActorVersionSourceFiles);
        return {
            actorId: actor.id,
            actorName,
            versionNumber,
            created: false,
            versionCreated: true,
            buildTag: buildTag ?? DEFAULT_BUILD_TAG,
            filesPushed: sourceFiles.length,
        };
    }

    let files = sourceFiles;
    if (mode === 'merge') {
        if (existing.sourceType !== ActorSourceType.SourceFiles) {
            return {
                userError: `Version ${versionNumber} uses source type ${existing.sourceType}; use mode 'replace' to overwrite it with source files.`,
            };
        }
        files = mergeSourceFiles(existing.sourceFiles, sourceFiles);
        if (!hasActorConfig(files)) return { userError: ACTOR_CONFIG_MISSING_TEXT };
    }
    await versionClient.update({
        sourceType: ActorSourceType.SourceFiles,
        sourceFiles: files,
        ...(buildTag !== undefined && { buildTag }),
    } satisfies ActorVersionSourceFiles);
    return {
        actorId: actor.id,
        actorName,
        versionNumber,
        created: false,
        versionCreated: false,
        buildTag: buildTag ?? existing.buildTag ?? DEFAULT_BUILD_TAG,
        filesPushed: files.length,
    };
}

function formatOutcome({ created, versionCreated, versionNumber }: PushSourceFilesResult): string {
    if (created) return 'created the Actor';
    if (versionCreated) return `created version ${versionNumber}`;
    return 'updated the version';
}

function formatFileCount(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function buildNextStep(build: Build | undefined, loadedToolNames: readonly string[]): string {
    if (build) {
        return buildNextStepForBuild(build, {
            loadedToolNames,
            nonTerminalNextStep: loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_GET)
                ? `Check progress with ${HELPER_TOOLS.ACTOR_BUILD_GET} using buildId ${build.id} (it waits up to ${WAIT_SECS_MAX} seconds per call).`
                : 'The build is still running; check its status again in a few seconds.',
        });
    }
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Trigger a build with ${HELPER_TOOLS.ACTOR_BUILD} to make this version runnable.`
        : 'Build this version to make it runnable.';
}

/** The push succeeded but the build request failed; the caller must know the write happened. */
function formatBuildStartFailure(errMessage: string, loadedToolNames: readonly string[]): string {
    const retry = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Retry the build with ${HELPER_TOOLS.ACTOR_BUILD}.`
        : 'Retry building this version to make it runnable.';
    return `The files were pushed, but the build could not be started: ${errMessage} ${retry}`;
}

/**
 * https://docs.apify.com/api/v2/acts-post
 *  /v2/acts
 * https://docs.apify.com/api/v2/act-version-put
 *  /v2/acts/{actorId}/versions/{versionNumber}
 * https://docs.apify.com/api/v2/act-versions-post
 *  /v2/acts/{actorId}/versions
 *
 * Uses the same JSON `sourceFiles` contract as `apify push` (actors().create, version().update,
 * versions().create). The documented tarball `/source-files` route returns 4xx
 * (apify/apify-core#29044), so it is not used. Resolves apify/apify-mcp-server#1217.
 */
export const pushActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_PUSH,
    title: 'Push Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `mode`, `build` and `waitSecs` from `required` because they have defaults.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(pushActorArgs)) as ToolInputSchema,
    outputSchema: pushActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(pushActorArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Push Actor',
        readOnlyHint: false,
        // mode replace overwrites the version's files.
        destructiveHint: true,
        // The default path starts a new build on every call, the same as build-actor.
        idempotentHint: false,
        openWorldHint: true,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
        // `safeParse` rather than `parse`: the repo's AJV drops `pattern` (see `src/utils/ajv.ts`), so
        // the regex fields are enforced here, as a soft fail instead of a thrown ZodError.
        const parsedArgs = pushActorArgs.safeParse(args);
        if (!parsedArgs.success) {
            return respondUserError(
                parsedArgs.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
            );
        }
        const parsed = parsedArgs.data;

        const fileProblem = validateSourceFiles(parsed.files);
        if (fileProblem) return respondUserError(fileProblem);
        const sourceFiles = toSourceFiles(parsed.files);
        const sizeBytes = getSourceFilesSizeBytes(sourceFiles);
        if (sizeBytes > MULTIFILE_SOURCE_MAX_BYTES) {
            return respondUserError(
                `The files total ${sizeBytes} bytes; the limit is ${MULTIFILE_SOURCE_MAX_BYTES} bytes (${MULTIFILE_SOURCE_MAX_MIB} MiB). Use the Apify CLI (apify push) for larger projects.`,
            );
        }
        // In replace mode the pushed files are the whole version, so this is known before any API call.
        if (parsed.mode === 'replace' && !hasActorConfig(sourceFiles)) return respondUserError(ACTOR_CONFIG_MISSING_TEXT);

        let pushed: PushSourceFilesResult | { userError: string };
        try {
            pushed = await pushSourceFiles({
                client,
                actorName: parsed.actorName,
                versionNumber: parsed.versionNumber,
                buildTag: parsed.buildTag,
                mode: parsed.mode,
                sourceFiles,
            });
        } catch (error) {
            // Covers the reads too: a scoped token can be denied the user, Actor or version lookup as well as the write.
            if (error instanceof ApifyApiError && error.statusCode === 403) {
                return respondUserError(
                    'The token is not allowed to read or modify Actors in this account; scoped tokens cannot. Use a token with full Actor access.',
                    { category: FAILURE_CATEGORY.AUTH, httpStatus: 403 },
                );
            }
            throw error;
        }
        if ('userError' in pushed) return respondUserError(pushed.userError);

        // The push is a completed write, so a failed build request is reported inside a normal
        // response that still carries the push result instead of a bare tool error.
        let build: Build | undefined;
        let buildStartErrMessage: string | undefined;
        if (parsed.build) {
            try {
                // No tag is passed: the version's buildTag applies, the same as `apify push`.
                build = await startBuild(client, pushed.actorId, pushed.versionNumber, {
                    useCache: true,
                    waitSecs: parsed.waitSecs,
                });
            } catch (error) {
                buildStartErrMessage = error instanceof Error ? error.message : String(error);
            }
        }
        const linkContext = build ? await getConsoleLinkContext(apifyToken, client) : undefined;
        const structuredContent = {
            actorId: pushed.actorId,
            actorName: pushed.actorName,
            created: pushed.created,
            versionNumber: pushed.versionNumber,
            buildTag: pushed.buildTag,
            filesPushed: pushed.filesPushed,
            ...(build !== undefined && { build: toBuildResult(build, linkContext) }),
        };
        const summary = `Pushed ${formatFileCount(sourceFiles.length)} to ${pushed.actorName} version ${pushed.versionNumber} (${formatOutcome(pushed)}); the version now has ${formatFileCount(pushed.filesPushed)}.`;
        const nextStep =
            buildStartErrMessage === undefined
                ? buildNextStep(build, loadedToolNames)
                : formatBuildStartFailure(buildStartErrMessage, loadedToolNames);
        const consoleLinkText = apifyConsoleLinkText(structuredContent.build?.apifyConsoleUrl);
        return respondOk(
            [JSON.stringify(structuredContent), `${summary}\n${nextStep}`, ...(consoleLinkText ? [consoleLinkText] : [])],
            { structuredContent },
        );
    },
} as const);
