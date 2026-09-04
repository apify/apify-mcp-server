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
import { pushActorSourceToolOutputSchema } from '../structured_output_schemas.js';
import { buildNextStepForBuild, startBuild, toBuildResult } from './build_helpers.js';
import {
    ACTOR_CONFIG_PATH,
    getSourceFilesSizeBytes,
    hasActorConfig,
    mergeSourceFiles,
    MULTIFILE_SOURCE_MAX_BYTES,
    toSourceFiles,
    validateSourcePaths,
} from './source_files.js';

/** `apify push` defaults to this tag too, because the platform complains when an Actor has no `latest` build. */
const DEFAULT_BUILD_TAG = 'latest';

const pushActorSourceArgs = z.object({
    actorName: z
        .string()
        .min(3)
        .max(63)
        .regex(
            /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
            'Actor name may contain only letters, digits and dashes, and cannot start or end with a dash',
        )
        .describe('Actor name in your account; created if it does not exist'),
    versionNumber: z
        .string()
        .regex(/^\d+\.\d+$/, 'Version number must be MAJOR.MINOR, for example 0.1')
        .default('0.0')
        .describe('Version to push the files to, in MAJOR.MINOR form'),
    buildTag: z.string().optional().describe('Build tag for this version, for example latest'),
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
    return `Push source files to an Actor in your account and, by default, build the pushed version.
Creates the Actor when it does not exist and creates or updates the version otherwise: the equivalent of the Apify CLI's apify push.
Returns the Actor ID and name, the version, its build tag, the number of files now in the version, the build when one was started, and a summary with one next step.
Files are text (utf8) or base64 for binaries; paths are relative to the Actor root and the version must end up containing ${ACTOR_CONFIG_PATH}.
The files may total at most 3 MiB; larger projects need the Apify CLI.
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
    fullName: string;
    actorName: string;
    versionNumber: string;
    buildTag: string | undefined;
    mode: 'merge' | 'replace';
    sourceFiles: ActorVersionSourceFile[];
};

type PushSourceFilesResult = {
    actorId: string;
    /** The Actor was created; false when only the version was created or updated. */
    created: boolean;
    versionCreated: boolean;
    buildTag: string;
    filesPushed: number;
};

const ACTOR_CONFIG_MISSING_TEXT = `The files must include ${ACTOR_CONFIG_PATH}; the platform needs it to build the Actor.`;

/**
 * Creates the Actor with the files, or creates or updates the version of an existing Actor. Returns
 * `userError` for problems the user must fix; `envVars` is never sent so the version keeps its own.
 */
async function pushSourceFiles(params: PushSourceFilesParams): Promise<PushSourceFilesResult | { userError: string }> {
    const { client, fullName, actorName, versionNumber, buildTag, mode, sourceFiles } = params;
    const actorClient = client.actor(fullName);
    const actor = await actorClient.get();
    if (!actor) {
        if (!hasActorConfig(sourceFiles)) return { userError: ACTOR_CONFIG_MISSING_TEXT };
        const created = await client.actors().create({
            name: actorName,
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
            created: true,
            versionCreated: true,
            buildTag: buildTag ?? DEFAULT_BUILD_TAG,
            filesPushed: sourceFiles.length,
        };
    }

    const versionClient = actorClient.version(versionNumber);
    const existing = await versionClient.get();
    if (!existing) {
        if (!hasActorConfig(sourceFiles)) return { userError: ACTOR_CONFIG_MISSING_TEXT };
        await actorClient.versions().create({
            versionNumber,
            buildTag: buildTag ?? DEFAULT_BUILD_TAG,
            sourceType: ActorSourceType.SourceFiles,
            sourceFiles,
        } satisfies ActorVersionSourceFiles);
        return {
            actorId: actor.id,
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
        created: false,
        versionCreated: false,
        buildTag: buildTag ?? existing.buildTag ?? DEFAULT_BUILD_TAG,
        filesPushed: files.length,
    };
}

function describeOutcome({ created, versionCreated }: PushSourceFilesResult): string {
    if (created) return 'created the Actor';
    if (versionCreated) return 'created the version';
    return 'updated the version';
}

function buildNextStep(build: Build | undefined, buildTag: string, loadedToolNames: readonly string[]): string {
    if (build) return buildNextStepForBuild(build, buildTag, loadedToolNames);
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
        ? `Trigger a build with ${HELPER_TOOLS.ACTOR_BUILD} to make this version runnable.`
        : 'Build this version to make it runnable.';
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
export const pushActorSource: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_SOURCE_PUSH,
    title: 'Push Actor source',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `versionNumber`, `mode`, `build` and `waitSecs` from `required` because they have defaults.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(pushActorSourceArgs)) as ToolInputSchema,
    outputSchema: pushActorSourceToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(pushActorSourceArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Push Actor source',
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
        const parsedArgs = pushActorSourceArgs.safeParse(args);
        if (!parsedArgs.success) {
            return respondUserError(
                parsedArgs.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
            );
        }
        const parsed = parsedArgs.data;

        const pathProblem = validateSourcePaths(parsed.files.map((file) => file.path));
        if (pathProblem) return respondUserError(pathProblem);
        const sourceFiles = toSourceFiles(parsed.files);
        const sizeBytes = getSourceFilesSizeBytes(sourceFiles);
        if (sizeBytes > MULTIFILE_SOURCE_MAX_BYTES) {
            return respondUserError(
                `The files total ${sizeBytes} bytes; the limit is ${MULTIFILE_SOURCE_MAX_BYTES} bytes (3 MiB). Use the Apify CLI (apify push) for larger projects.`,
            );
        }
        // In replace mode the pushed files are the whole version, so this is known before any API call.
        if (parsed.mode === 'replace' && !hasActorConfig(sourceFiles)) return respondUserError(ACTOR_CONFIG_MISSING_TEXT);

        const { username } = await client.user('me').get();
        const fullName = `${username}/${parsed.actorName}`;
        let pushed: PushSourceFilesResult | { userError: string };
        try {
            pushed = await pushSourceFiles({
                client,
                fullName,
                actorName: parsed.actorName,
                versionNumber: parsed.versionNumber,
                buildTag: parsed.buildTag,
                mode: parsed.mode,
                sourceFiles,
            });
        } catch (error) {
            // Covers the reads too: a scoped token can be denied the Actor or version lookup as well as the write.
            if (error instanceof ApifyApiError && error.statusCode === 403) {
                return respondUserError(
                    'The token is not allowed to read or modify Actors in this account; scoped tokens cannot. Use a token with full Actor access.',
                    { category: FAILURE_CATEGORY.AUTH, httpStatus: 403 },
                );
            }
            throw error;
        }
        if ('userError' in pushed) return respondUserError(pushed.userError);

        // No tag is passed: the version's buildTag applies, the same as `apify push`.
        const build = parsed.build
            ? await startBuild(client, pushed.actorId, parsed.versionNumber, { useCache: true, waitSecs: parsed.waitSecs })
            : undefined;
        const linkContext = build ? await getConsoleLinkContext(apifyToken, client) : undefined;
        const structuredContent = {
            actorId: pushed.actorId,
            actorName: fullName,
            created: pushed.created,
            versionNumber: parsed.versionNumber,
            buildTag: pushed.buildTag,
            filesPushed: pushed.filesPushed,
            ...(build !== undefined && { build: toBuildResult(build, linkContext) }),
        };
        const fileWord = pushed.filesPushed === 1 ? 'file' : 'files';
        const summary = `Pushed ${pushed.filesPushed} ${fileWord} to ${fullName} version ${parsed.versionNumber} (${describeOutcome(pushed)}).`;
        const consoleLinkText = apifyConsoleLinkText(structuredContent.build?.apifyConsoleUrl);
        return respondOk(
            [
                JSON.stringify(structuredContent),
                `${summary}\n${buildNextStep(build, pushed.buildTag, loadedToolNames)}`,
                ...(consoleLinkText ? [consoleLinkText] : []),
            ],
            { structuredContent },
        );
    },
} as const);
