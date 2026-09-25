import { ApifyApiError } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
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
        A public Actor cannot be deleted: unpublish it in Apify Console first, after cancelling its monetization if it is paid.
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
        // Without a token (a payment-only session) the account cannot be checked, so stop before any request.
        if (!apifyToken) {
            return respondUserError('Deleting an Actor needs an Apify API token, and this session has none.', {
                category: FAILURE_CATEGORY.AUTH,
            });
        }
        try {
            // The client swallows a 404 on delete, so read first to report a missing Actor and to name the
            // one that was removed. apify-client turns username/name into the API's username~name.
            const actor = await client.actor(parsed.actor).get();
            // Extra path segments, such as username/name/runs/last, reach a sub-resource that is not an Actor.
            if (!actor || typeof actor.name !== 'string' || typeof actor.username !== 'string') {
                return respondUserError(
                    `Actor ${parsed.actor} not found. Give its ID or its full name, username/name; ` +
                        'a name without the username is not enough.',
                );
            }
            const fullName = `${actor.username}/${actor.name}`;
            // The platform deletes an Actor for anyone with write access to it, and an Actor's old username~name
            // still reaches it after a move to another account, so check that it is the caller's own Actor.
            const { userId } = await getUserInfoCached(apifyToken, client);
            // users/me gives no ID to a token with limited permissions or an Actor run's token, and none on a
            // failed request; the Actor is not someone else's then, but ownership cannot be confirmed.
            if (!userId) {
                return respondUserError(
                    `Could not confirm which account this token belongs to, so ${fullName} was not deleted. ` +
                        'A token with limited permissions cannot read its account: use one without limits, or delete ' +
                        'the Actor in Apify Console.',
                    { category: FAILURE_CATEGORY.AUTH },
                );
            }
            if (actor.userId !== userId) {
                return respondUserError(`${fullName} is not in your account; this tool deletes only your own Actors.`);
            }
            if (actor.isPublic) {
                // The platform omits stats on some older Actors.
                const totalUsers = actor.stats?.totalUsers;
                const users =
                    totalUsers === undefined ? '' : ` and has ${totalUsers} ${totalUsers === 1 ? 'user' : 'users'}`;
                return respondUserError(
                    `${fullName} is public in Apify Store${users}; unpublish it in Apify Console first. ` +
                        'A paid Actor needs its monetization cancelled before it can be unpublished.',
                );
            }
            await client.actor(actor.id).delete();

            const result = { actorId: actor.id, fullName, deleted: true };
            const summary = `Deleted ${fullName}. This cannot be undone; any unfinished runs were aborted.`;
            return respondOk([JSON.stringify(result), summary], { structuredContent: result });
        } catch (error) {
            // For example a token without write access, or a critical Actor; the API's message says why, and
            // respondServerError records a 401/403 as AUTH and any other 4xx as INVALID_INPUT.
            if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                return respondServerError(error.message, { error });
            }
            throw error;
        }
    },
} as const);
