import type { ActorCollectionCreateOptions, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { APIFY_ERROR_TYPE_ACTOR_NAME_NOT_UNIQUE, HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { createActorToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesManifest, buildFilesRevision } from './source_files.js';
import {
    buildEmptyFilesWarnings,
    buildSourceFileEntries,
    extractSourceFiles,
    redactSourceToolArgs,
    resolveVersion,
    respondAfterWrite,
    respondToSourceToolError,
    sourceFileArgs,
} from './source_helpers.js';

const createActorArgs = z.object({
    name: z.string().min(1).describe('Name of the new Actor, without a username, for example my-scraper.'),
    title: z.string().min(1).optional().describe('Display title, for example My Scraper.'),
    description: z.string().optional().describe('A short description of what the Actor does.'),
    files: z.array(sourceFileArgs).min(1).describe("The Actor's files, each with its whole content."),
    versionNumber: z
        .string()
        .optional()
        .describe(
            'Number of the version in MAJOR.MINOR form. Default: the version in .actor/actor.json, or 0.0 when it has none.',
        ),
    buildTag: z
        .string()
        .min(1)
        .optional()
        .describe('Tag that builds of the version get. The platform uses latest when it is omitted.'),
    autoBuild: z
        .boolean()
        .default(false)
        .describe('Start a build of the version after creating the Actor, and return without waiting. Default: false.'),
});

/** The `version` of .actor/actor.json when it is a non-empty string in valid JSON, as `apify push` reads it. */
function readActorJsonVersion(entries: readonly ActorVersionSourceFile[]): string | undefined {
    const actorJson = entries.find(({ name, format }) => name === '.actor/actor.json' && format === 'TEXT');
    if (!actorJson) return undefined;
    try {
        const { version } = JSON.parse(actorJson.content) as { version?: unknown };
        return typeof version === 'string' && version !== '' ? version : undefined;
    } catch {
        return undefined;
    }
}

/**
 * https://docs.apify.com/api/v2/actors-post
 *  /v2/actors
 *
 * One POST creates the Actor and its version together, private and in the token's account. apify-client retries the
 * POST after a network error, a timeout, a 429, or a 5xx, so when the platform saved an attempt it did not answer, the
 * retry fails on the name that attempt took, and the call says the Actor may exist.
 */
export const createActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_CREATE,
    title: 'Create Actor',
    description: dedent`
        Create a new private Actor in your account, with one version holding the files you give. It never changes an existing Actor: the platform refuses a name your account already uses.
        - files: every file with its path and content. Binary files take base64 content with encoding base64; files with a binary extension such as .png default to it.
        The platform sets the name field of .actor/actor.json to the Actor name, so the result lists each file's hash and the version's revision as stored.
        autoBuild starts a build after creating the Actor and returns without waiting.

        USAGE:
        - Use to upload new Actor code to the Apify platform for the first time.

        USAGE EXAMPLES:
        - user_input: Create an Actor called hacker-news-scraper from these files`,
    // `fixZodSchemaRequired` strips `autoBuild` from `required` because it has a default.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(createActorArgs)) as ToolInputSchema,
    outputSchema: createActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(createActorArgs)),
    annotations: {
        title: 'Create Actor',
        readOnlyHint: false,
        destructiveHint: false,
        // A second call with the same name is refused rather than repeated.
        idempotentHint: false,
        // autoBuild starts a build, like build-actor.
        openWorldHint: true,
    },
    redactArgs: (args: Record<string, unknown>) =>
        redactSourceToolArgs(args, {
            keys: ['name', 'title', 'description', 'versionNumber', 'buildTag', 'autoBuild'],
            listKey: 'files',
            entryKeys: ['path', 'encoding'],
        }),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal, loadedToolNames } = toolArgs;
        const parsed = createActorArgs.parse(args);
        // A cancel before the POST creates nothing; per the MCP spec the cancelled request gets no response.
        if (signal?.aborted) return respondAborted();
        try {
            const sourceFiles = buildSourceFileEntries(parsed.files);
            // The platform refuses a version without a number, so this defaults to what `apify push` uses.
            // AJV turns a null versionNumber into an empty string, which counts as not given.
            const versionNumber = parsed.versionNumber || readActorJsonVersion(sourceFiles) || '0.0';
            const created = await client.actors().create({
                name: parsed.name,
                ...(parsed.title !== undefined && { title: parsed.title }),
                ...(parsed.description !== undefined && { description: parsed.description }),
                versions: [
                    {
                        versionNumber,
                        ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                        sourceType: ActorSourceType.SourceFiles,
                        sourceFiles,
                    },
                ],
            } satisfies ActorCollectionCreateOptions);
            const fullName = `${created.username}/${created.name}`;
            // The platform sets the name in .actor/actor.json on create, so the stored files, not the sent ones, match
            // a later read.
            const version = resolveVersion(created, undefined, fullName);
            const files = buildFilesManifest(
                extractSourceFiles(version, `Version ${version.versionNumber} of ${fullName}`),
            );
            const emptyPaths = files.filter(({ sizeBytes }) => sizeBytes === 0).map(({ path }) => path);
            return await respondAfterWrite({
                toolArgs,
                autoBuild: parsed.autoBuild,
                target: { actorId: created.id, versionNumber: version.versionNumber },
                structuredContent: {
                    actorId: created.id,
                    fullName,
                    versionNumber: version.versionNumber,
                    revision: buildFilesRevision(files),
                    files: files.map(({ path, sizeBytes, hash }) => ({ path, sizeBytes, hash })),
                    ...buildEmptyFilesWarnings(emptyPaths),
                },
                summary: `Created the private Actor ${fullName}.`,
            });
        } catch (error) {
            if (
                error instanceof ApifyApiError &&
                error.type === APIFY_ERROR_TYPE_ACTOR_NAME_NOT_UNIQUE &&
                error.attempt > 1
            ) {
                const readTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_VERSION_GET)
                    ? `; ${HELPER_TOOLS.ACTOR_VERSION_GET} reads its files`
                    : '';
                return respondUserError(
                    `The platform refused the name ${parsed.name} as taken when the request was retried, so an earlier ` +
                        `attempt of this call may have created the Actor ${parsed.name}. ` +
                        `If it holds the files you sent, this call created it${readTool}.`,
                    { httpStatus: error.statusCode },
                );
            }
            return respondToSourceToolError(error);
        }
    },
} as const);
