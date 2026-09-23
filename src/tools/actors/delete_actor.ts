import { ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { deleteActorToolOutputSchema } from '../structured_output_schemas.js';
import { formatActorFullName, resolveActorNameInput, resolveTargetActor } from './actor_helpers.js';

const deleteActorArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or name; your own account only'),
});

/**
 * https://docs.apify.com/api/v2/act-delete
 *  /v2/acts/{actorId}
 *
 * The platform deletes a public Actor as long as it is free; its users would lose it without warning, so
 * the tool refuses every public Actor and the owner has to unpublish it first. Resolves apify/apify-mcp-server#1417.
 */
export const deleteActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_DELETE,
    title: 'Delete Actor',
    description: dedent`
        Delete an Actor from your own account permanently; this cannot be undone.
        Its unfinished runs are aborted, its webhooks are removed, and it is removed from the schedules that start it.
        A public Actor cannot be deleted: unpublish it from Apify Store first.
        For a reversible option, set it as deprecated instead.

        USAGE:
        - Use only when the user explicitly wants the Actor removed.

        USAGE EXAMPLES:
        - user_input: Delete my Actor my-test-scraper
        - user_input: Remove Actor E2jjCZBezvAZnX8Rb`,
    inputSchema: z.toJSONSchema(deleteActorArgs) as ToolInputSchema,
    outputSchema: deleteActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(deleteActorArgs)),
    annotations: {
        title: 'Delete Actor',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = deleteActorArgs.parse(args);
        try {
            // The client swallows a 404 on delete, so read first to report a missing Actor and to name the
            // one that was removed.
            const { actor } = await resolveTargetActor(client, resolveActorNameInput(parsed.actor));
            if (!actor) {
                return respondUserError(`Actor ${parsed.actor} was not found in your account.`);
            }
            const fullName = formatActorFullName(actor.username, actor.name);
            if (actor.isPublic) {
                return respondUserError(
                    `${fullName} is public in Apify Store and has ${actor.stats.totalUsers} users; unpublish it first.`,
                );
            }
            await client.actor(actor.id).delete();

            const result = { actorId: actor.id, fullName, deleted: true };
            const summary = `Deleted ${fullName}. This cannot be undone; its unfinished runs were aborted.`;
            return respondOk([JSON.stringify(result), summary], { structuredContent: result });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            // For example a token without write access, or a critical Actor; the API's message says why.
            if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                return respondUserError(error.message, { httpStatus: error.statusCode });
            }
            throw error;
        }
    },
} as const);
