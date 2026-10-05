import type { ActorCollectionCreateOptions, ActorVersionSourceFile } from 'apify-client';
import { ActorSourceType } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondAborted } from '../../utils/mcp.js';
import { createActorToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesManifest, buildFilesRevision } from './source_files.js';
import {
    buildEmptyFilesWarnings,
    buildSourceFileEntry,
    extractSourceFiles,
    resolveVersion,
    respondAfterWrite,
    respondToSourceToolError,
    sourceFileArgs,
    validateFilePath,
    validateNewFilePath,
} from './source_helpers.js';

const createActorArgs = z.object({
    name: z.string().min(1).describe('Name of the new Actor, without a username, for example my-scraper.'),
    title: z.string().min(1).optional().describe('Display title, for example My Scraper.'),
    description: z.string().optional().describe('A short description of what the Actor does.'),
    files: z.array(sourceFileArgs).min(1).describe("The Actor's files, each with its whole content."),
    // The platform refuses a version without a number, so this defaults to what `apify push` uses.
    versionNumber: z.string().default('0.0').describe('Number of the version in MAJOR.MINOR form. Default: 0.0.'),
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

/** The entries to send, one per file; throws `UserInputError` for a path no file can be written at. */
function buildSourceFileEntries(files: readonly z.infer<typeof sourceFileArgs>[]): ActorVersionSourceFile[] {
    const entries: ActorVersionSourceFile[] = [];
    for (const [index, file] of files.entries()) {
        const entry = buildSourceFileEntry(file);
        const label = `files[${index}] (${file.path})`;
        validateFilePath(entry.name, label);
        validateNewFilePath(entry.name, { filePaths: entries.map(({ name }) => name), folderPaths: [] }, label);
        entries.push(entry);
    }
    return entries;
}

/**
 * https://docs.apify.com/api/v2/actors-post
 *  /v2/actors
 *
 * One POST creates the Actor and its version together, so a failed call leaves nothing behind. The platform creates
 * it private and in the token's account.
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
        - Use to publish new Actor code to the Apify platform for the first time.

        USAGE EXAMPLES:
        - user_input: Create an Actor called hacker-news-scraper from these files`,
    // `fixZodSchemaRequired` strips `versionNumber` and `autoBuild` from `required` because they have defaults.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(createActorArgs)) as ToolInputSchema,
    outputSchema: createActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(createActorArgs)),
    annotations: {
        title: 'Create Actor',
        readOnlyHint: false,
        destructiveHint: false,
        // A second call with the same name is refused rather than repeated.
        idempotentHint: false,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal } = toolArgs;
        const parsed = createActorArgs.parse(args);
        // A cancel before the POST creates nothing; per the MCP spec the cancelled request gets no response.
        if (signal?.aborted) return respondAborted();
        try {
            const created = await client.actors().create({
                name: parsed.name,
                ...(parsed.title !== undefined && { title: parsed.title }),
                ...(parsed.description !== undefined && { description: parsed.description }),
                versions: [
                    {
                        versionNumber: parsed.versionNumber,
                        ...(parsed.buildTag !== undefined && { buildTag: parsed.buildTag }),
                        sourceType: ActorSourceType.SourceFiles,
                        sourceFiles: buildSourceFileEntries(parsed.files),
                    },
                ],
            } satisfies ActorCollectionCreateOptions);
            // Per the MCP spec a cancelled request gets no response; the Actor stands, and no build is started.
            if (signal?.aborted) return respondAborted();
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
            return respondToSourceToolError(error);
        }
    },
} as const);
