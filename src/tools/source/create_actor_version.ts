import type { ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { APIFY_ERROR_TYPE_VERSION_ALREADY_EXISTS, HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { createActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesManifest, buildFilesRevision } from './source_files.js';
import {
    buildEmptyFilesWarnings,
    buildSourceFileEntries,
    extractSourceFiles,
    fetchActor,
    resolveVersion,
    respondAfterWrite,
    respondToSourceToolError,
    sourceFileArgs,
} from './source_helpers.js';

const createActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to add the version to: its ID, or its full name as username/name or username~name. A name without the username is not enough.',
        ),
    versionNumber: z.string().min(1).describe('Number of the new version in MAJOR.MINOR form, for example 0.2.'),
    copyFromVersion: z
        .string()
        .min(1)
        .optional()
        .describe('The version to copy instead of sending files, for example 0.1.'),
    files: z.array(sourceFileArgs).min(1).optional().describe("The version's files, each with its whole content."),
    buildTag: z
        .string()
        .min(1)
        .optional()
        .describe('Tag that builds of the new version get, for example beta. No default: without it, they get no tag.'),
    autoBuild: z
        .boolean()
        .default(false)
        .describe('Start a build of the new version after creating it, and return without waiting. Default: false.'),
});

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/actor-versions-post
 *  /v2/actors/{actorId}/versions
 *
 * One POST creates the version with its files. apify-client retries the POST after a network error, a timeout, a 429,
 * or a 5xx, so when the platform saved an attempt it did not answer, the retry fails on the number that attempt took,
 * and the call says the version may exist. A copy sends the other version's files as the Actor GET returns them, so
 * their content never passes through the model.
 */
export const createActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_CREATE,
    title: 'Create Actor version',
    description: dedent`
        Add a new version to an existing Actor, with the files you give or as a copy of another version. It never changes an existing version: the platform refuses a versionNumber the Actor already has.
        - files: every file with its path and content. Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it.
        - copyFromVersion: copies that version's files and non-secret environment variables on the server, so no file content passes through the call. Only versions stored as files can be copied.
        buildTag has no default, and a copy does not take the tag of the version it copies: without buildTag, builds of the new version get no tag, so they never move a tag such as latest.
        autoBuild starts a build after creating the version and returns without waiting.

        USAGE:
        - Use to make a working copy of a version to change and test while the tagged build keeps running.

        USAGE EXAMPLES:
        - user_input: Copy version 0.1 of my Actor john/my-scraper to a new version 0.2`,
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
        const { args, apifyClient: client, signal, loadedToolNames } = toolArgs;
        const parsed = createActorVersionArgs.parse(args);
        const { versionNumber, copyFromVersion } = parsed;
        if ((copyFromVersion === undefined) === (parsed.files === undefined)) {
            return respondUserError('Give either files or copyFromVersion.');
        }
        try {
            const { actor, fullName } = await fetchActor(client, parsed.actor);
            // TODO: A copy takes every file of the other version from the Actor GET and sends them all back in the POST
            // below: the Apify API cannot copy a version or apply atomic changes to an Actor's source. Once it can, let
            // the platform make the copy.
            const copied =
                copyFromVersion === undefined ? undefined : resolveVersion(actor, copyFromVersion, parsed.actor);
            const sourceFiles = copied
                ? extractSourceFiles(copied, `Version ${copied.versionNumber} of ${fullName}`)
                : buildSourceFileEntries(parsed.files!);
            // A cancel during the read creates nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            await client
                .actor(actor.id)
                .versions()
                .create({
                    versionNumber,
                    ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                    sourceType: ActorSourceType.SourceFiles,
                    sourceFiles,
                    // The API returns a secret env var without its value, so a copy takes only the others.
                    ...(copied && {
                        envVars: copied.envVars?.filter(({ isSecret }) => !isSecret),
                        applyEnvVarsToBuild: copied.applyEnvVarsToBuild,
                    }),
                } satisfies ActorVersion);
            // Per the MCP spec a cancelled request gets no response; the version stands, and no build is started.
            if (signal?.aborted) return respondAborted();
            const files = buildFilesManifest(sourceFiles);
            const emptyPaths = files.filter(({ sizeBytes }) => sizeBytes === 0).map(({ path }) => path);
            const { warnings = [] } = buildEmptyFilesWarnings(emptyPaths);
            const secretNames = copied?.envVars?.filter(({ isSecret }) => isSecret).map(({ name }) => name) ?? [];
            if (secretNames.length > 0) {
                warnings.push(
                    `These secret environment variables were not copied, so set them on version ${versionNumber} ` +
                        `in Apify Console before building or running it: ${secretNames.join(', ')}.`,
                );
            }
            return await respondAfterWrite({
                toolArgs,
                autoBuild: parsed.autoBuild,
                target: { actorId: actor.id, versionNumber },
                structuredContent: {
                    actorId: actor.id,
                    fullName,
                    versionNumber,
                    revision: buildFilesRevision(files),
                    files: files.map(({ path, sizeBytes, hash }) => ({ path, sizeBytes, hash })),
                    ...(warnings.length > 0 && { warnings }),
                },
                summary: `Created version ${versionNumber} of ${fullName}.`,
            });
        } catch (error) {
            if (
                error instanceof ApifyApiError &&
                error.type === APIFY_ERROR_TYPE_VERSION_ALREADY_EXISTS &&
                error.attempt > 1
            ) {
                const readTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_GET)
                    ? ` with ${HELPER_TOOLS.ACTOR_VERSION_GET}`
                    : '';
                return respondUserError(
                    `The platform refused version ${versionNumber} as taken when the request was retried, so an ` +
                        `earlier attempt of this call may have created it. Read it${readTool} before calling ` +
                        `${HELPER_TOOLS.ACTOR_VERSION_CREATE} again; if it holds the files this call sent, this call ` +
                        'created it.',
                    { httpStatus: error.statusCode },
                );
            }
            return respondToSourceToolError(error);
        }
    },
} as const);
