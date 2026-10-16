import type { ActorVersion } from 'apify-client';
import { ActorSourceType, ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { APIFY_ERROR_TYPE_TOO_FEW_VERSIONS, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondAborted, respondOk, respondUserError } from '../../utils/mcp.js';
import { deleteActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { buildFilesManifest, buildFilesRevision } from './source_files.js';
import { extractSourceFiles, fetchActor, resolveVersion, respondToSourceToolError } from './source_helpers.js';

const deleteActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to delete the version from: its ID, its name (resolved against your own Actors), or its full name as username/name or username~name.',
        ),
    versionNumber: z.string().min(1).describe('The version to delete, in MAJOR.MINOR form, for example 0.2.'),
    expectedRevision: z
        .string()
        .optional()
        .describe(
            'The revision of the version when you read it. When given, the delete is refused if any file of the ' +
                'version changed since. Only a version stored as files has a revision.',
        ),
});

/**
 * Throws `UserInputError` unless the version's revision, computed as get-actor-version and the write tools compute it,
 * is `expectedRevision`, ignoring case. A version not stored as files has no revision.
 */
function validateRevision(
    version: ActorVersion & { versionNumber: string },
    fullName: string,
    expectedRevision: string,
) {
    if (version.sourceType !== ActorSourceType.SourceFiles) {
        throw new UserInputError(
            `Nothing was deleted: version ${version.versionNumber} of ${fullName} has source type ${version.sourceType}, ` +
                'and only a version stored as files has a revision to compare expectedRevision with.',
        );
    }
    if (!version.sourceFiles) {
        throw new UserInputError(
            `Nothing was deleted: version ${version.versionNumber} of ${fullName} came back without its source, so it ` +
                'has no revision to compare expectedRevision with.',
        );
    }
    const revision = buildFilesRevision(
        buildFilesManifest(extractSourceFiles(version, `Version ${version.versionNumber} of ${fullName}`)),
    );
    if (expectedRevision.toLowerCase() === revision) return;
    throw new UserInputError(
        `Nothing was deleted: expectedRevision failed with REVISION_MISMATCH. The version's revision is ${revision}, ` +
            `not ${expectedRevision}.`,
    );
}

/**
 * https://docs.apify.com/api/v2/actor-get
 *  /v2/actors/{actorId}
 * https://docs.apify.com/api/v2/actor-version-delete
 *  /v2/actors/{actorId}/versions/{versionNumber}
 *
 * The Actor is read first: apify-client swallows a 404 on delete, so a missing version would otherwise look deleted.
 * The platform refuses to delete the last version, and leaves the version's builds and tags in place.
 */
export const deleteActorVersion: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_VERSION_DELETE,
    title: 'Delete Actor version',
    description: dedent`
        Delete one version of an Actor, with its source and environment variables; a deleted version cannot be restored. The platform refuses to delete an Actor's last version.
        The version's builds stay, and so do the tags that point to them: a run with such a tag still uses that build. A build of the version that is still running keeps running, and takes its tag if it succeeds.

        USAGE:
        - Use only when the user explicitly wants the version removed.

        USAGE EXAMPLES:
        - user_input: Delete version 0.2 of my Actor john/my-scraper`,
    inputSchema: z.toJSONSchema(deleteActorVersionArgs) as ToolInputSchema,
    outputSchema: deleteActorVersionToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(deleteActorVersionArgs)),
    annotations: {
        title: 'Delete Actor version',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, signal, loadedToolNames } = toolArgs;
        const parsed = deleteActorVersionArgs.parse(args);
        try {
            const { actor, fullName } = await fetchActor(client, parsed.actor);
            const version = resolveVersion(actor, parsed.versionNumber, parsed.actor);
            const { versionNumber } = version;
            // AJV turns a null expectedRevision into an empty string, which no version has, so it counts as not given.
            if (parsed.expectedRevision) validateRevision(version, fullName, parsed.expectedRevision);
            // A cancel before the DELETE deletes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            try {
                await client.actor(actor.id).version(versionNumber).delete();
            } catch (error) {
                if (error instanceof ApifyApiError && error.type === APIFY_ERROR_TYPE_TOO_FEW_VERSIONS) {
                    return respondUserError(
                        `Version ${versionNumber} is the only version of ${fullName}, and an Actor keeps at least one version.`,
                        { httpStatus: error.statusCode },
                    );
                }
                throw error;
            }
            const summary = `Deleted version ${versionNumber} of ${fullName}.`;
            const buildTool = loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD)
                ? `${HELPER_TOOLS.ACTOR_BUILD} and `
                : '';
            // A tag points to the build it was last given to, which may be a build of another version than the one with
            // that buildTag.
            const tags = Object.entries(actor.taggedBuilds ?? {})
                .filter(([, { buildNumber }]) => buildNumber?.startsWith(`${versionNumber}.`))
                .map(([tag]) => tag);
            const structuredContent = { actorId: actor.id, fullName, versionNumber, deleted: true, tags };
            // build-actor takes one tag, so the text names one build per tag.
            const text =
                tags.length > 0
                    ? `${summary}\nRuns with tag ${tags.join(', ')} still use the deleted version's build until each tag ` +
                      `points to another build, such as one of another version made with ${buildTool}` +
                      `tag ${tags.join(', then one with tag ')}.`
                    : summary;
            return respondOk([JSON.stringify(structuredContent), text], { structuredContent });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
