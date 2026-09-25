import { ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS, HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { getUserInfoCached } from '../../utils/userid_cache.js';
import { deleteActorToolOutputSchema } from '../structured_output_schemas.js';

const deleteActorArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe(
            'The Actor to delete: its ID, or its full name as username/name or username~name. ' +
                'A name without the username is not enough. It must be in your own account.',
        ),
});

/**
 * https://docs.apify.com/api/v2/actor-delete
 *  /v2/actors/{actorId}
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
        A public Actor cannot be deleted: unpublish it from Apify Store in Apify Console first.
        For a reversible option, set it as deprecated in Apify Console instead.

        USAGE:
        - Use only when the user explicitly wants the Actor removed.

        USAGE EXAMPLES:
        - user_input: Delete my Actor john/my-test-scraper
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
        const { args, apifyClient: client, apifyToken } = toolArgs;
        const parsed = deleteActorArgs.parse(args);
        try {
            // The client swallows a 404 on delete, so read first to report a missing Actor and to name the
            // one that was removed. apify-client turns username/name into the API's username~name.
            const actor = await client.actor(parsed.actor).get();
            if (!actor) {
                return respondUserError(
                    `Actor ${parsed.actor} not found. Give its ID or its full name, username/name; ` +
                        'a name without the username is not enough.',
                );
            }
            const fullName = `${actor.username}/${actor.name}`;
            // The platform deletes an Actor for anyone with write access to it, and an Actor's old username~name
            // still reaches it after a move to another account, so check that it is the caller's own Actor.
            const { userId } = await getUserInfoCached(apifyToken, client);
            if (!userId || actor.userId !== userId) {
                return respondUserError(`${fullName} is not in your account; this tool deletes only your own Actors.`);
            }
            if (actor.isPublic) {
                const { totalUsers } = actor.stats;
                return respondUserError(
                    `${fullName} is public in Apify Store and has ${totalUsers} ${totalUsers === 1 ? 'user' : 'users'}; unpublish it in Apify Console first.`,
                );
            }
            await client.actor(actor.id).delete();

            const result = { actorId: actor.id, fullName, deleted: true };
            const summary = `Deleted ${fullName}. This cannot be undone; its unfinished runs were aborted.`;
            return respondOk([JSON.stringify(result), summary], { structuredContent: result });
        } catch (error) {
            // For example a token without write access, or a critical Actor; the API's message says why. A 401/403
            // is recorded as AUTH, as it would be if rethrown, so no report-problem nudge follows a token problem.
            if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                const isAuthError = error.statusCode === HTTP_UNAUTHORIZED || error.statusCode === HTTP_FORBIDDEN;
                return respondUserError(error.message, {
                    category: isAuthError ? FAILURE_CATEGORY.AUTH : FAILURE_CATEGORY.INVALID_INPUT,
                    httpStatus: error.statusCode,
                });
            }
            throw error;
        }
    },
} as const);
