import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondAborted, respondOk } from '../../utils/mcp.js';
import { deleteActorVersionToolOutputSchema } from '../structured_output_schemas.js';
import { fetchActor, resolveVersion, respondToSourceToolError } from './source_helpers.js';

const deleteActorVersionArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to delete the version from: its ID, or its full name as username/name or username~name. A name without the username is not enough.',
        ),
    versionNumber: z.string().min(1).describe('The version to delete, in MAJOR.MINOR form, for example 0.2.'),
});

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
        The version's builds stay, and so do the tags that point to them: a run with such a tag still uses that build.

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
        const { args, apifyClient: client, signal } = toolArgs;
        const parsed = deleteActorVersionArgs.parse(args);
        try {
            const { actor, fullName } = await fetchActor(client, parsed.actor);
            const { versionNumber } = resolveVersion(actor, parsed.versionNumber, parsed.actor);
            // A cancel before the DELETE deletes nothing; per the MCP spec the cancelled request gets no response.
            if (signal?.aborted) return respondAborted();
            await client.actor(actor.id).version(versionNumber).delete();
            const structuredContent = { actorId: actor.id, fullName, versionNumber, deleted: true };
            const summary = `Deleted version ${versionNumber} of ${fullName}.`;
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            return respondToSourceToolError(error);
        }
    },
} as const);
