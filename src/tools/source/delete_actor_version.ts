import { ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondAborted, respondOk } from '../../utils/mcp.js';
import { deleteActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { resolveOwnActor, resolveVersionNumber, respondToSourceToolError } from './source_helpers.js';

/** The error type the platform returns for a delete that would leave the Actor with no version. */
const TOO_FEW_VERSIONS_ERROR_TYPE = 'too-few-versions';

const deleteActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to delete the version from: its ID, or its full name as username/name or username~name. ' +
                'A name without the username is not enough. It must be in your own account.',
        ),
    versionNumber: z.string().min(1).describe('The version to delete, in MAJOR.MINOR form, for example 0.2.'),
});

function formatLastVersionText(fullName: string, versionNumber: string): string {
    return (
        `Nothing was deleted: version ${versionNumber} is the only version of ${fullName}, and an Actor must keep ` +
        'at least one version. To remove it, delete the Actor instead.'
    );
}

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    const copyNote = hasTool(HELPER_TOOLS.ACTOR_VERSION_CREATE)
        ? ` such as a working copy made with ${HELPER_TOOLS.ACTOR_VERSION_CREATE}`
        : '';
    return dedent`
        Delete one version of one of your own Actors, with its source and environment variables.
        An Actor must keep at least one version, so its last version cannot be deleted; delete the Actor instead.
        The version's builds stay, and so do the tags that point to them: a run with such a tag still uses that build.

        USAGE:
        - Use to remove a version that is no longer needed${copyNote}.

        USAGE EXAMPLES:
        - user_input: Delete version 0.2 of my Actor john/my-scraper
        - user_input: Remove the working copies of my Actor now that the fix is in 0.1`;
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
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
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
        const { args, apifyClient: client, apifyToken, signal } = toolArgs;
        const parsed = deleteActorVersionArgs.parse(args);
        try {
            const { actor, fullName } = await resolveOwnActor({ client, apifyToken, actorSelector: parsed.actor });
            const versionNumber = resolveVersionNumber(actor, parsed.versionNumber, parsed.actor);
            if (actor.versions.length <= 1) throw new UserInputError(formatLastVersionText(fullName, versionNumber));
            // A cancel before the DELETE deletes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            try {
                await client.actor(actor.id).version(versionNumber).delete();
            } catch (error) {
                // Another writer deleted the other versions since the read.
                if (error instanceof ApifyApiError && error.type === TOO_FEW_VERSIONS_ERROR_TYPE) {
                    throw new UserInputError(formatLastVersionText(fullName, versionNumber));
                }
                throw error;
            }
            const structuredContent = { actorId: actor.id, fullName, versionNumber, deleted: true };
            const summary =
                `Deleted version ${versionNumber} of ${fullName}. Its builds stay, and so do the tags that point to ` +
                'them: a run with such a tag still uses that build.';
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
