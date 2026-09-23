import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { ApifyClient } from '../../apify_client.js';
import { APIFY_ERROR_TYPE_CANNOT_PUBLISH_ACTOR, APIFY_STORE_URL, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { publishActorToolOutputSchema } from '../structured_output_schemas.js';
import { formatActorFullName, resolveActorNameInput, resolveTargetActor } from './actor_helpers.js';

const publishActorArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or name; your own account only'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Publish an Actor of your account in Apify Store.
Publishing lists the Actor in Apify Store and exposes its README and input schema to everyone, who can then
find and run it. Publish only an Actor the user asked to publish.

The API checks, in this order: the Actor has a title and at least one category; the account has a username
and a public profile; the Actor has at least one tagged build; the account has accepted the Apify Store terms;
the default build (usually latest) has a README and input and output schemas; the Actor has at least one run
and, unless it uses Standby mode, one successful run. \
If publishing fails, follow the API reason.${
        hasTool(HELPER_TOOLS.ACTOR_PUSH)
            ? ` Add a missing README or schema to the source with ${HELPER_TOOLS.ACTOR_PUSH}, which also rebuilds it.`
            : ''
    }${hasTool(HELPER_TOOLS.ACTOR_BUILD) ? ` Create a tagged build with ${HELPER_TOOLS.ACTOR_BUILD}.` : ''}${
        hasTool(HELPER_TOOLS.ACTOR_CALL) ? ` Get a successful run with ${HELPER_TOOLS.ACTOR_CALL}.` : ''
    }
At most 5 Actors can be published per rolling 24 hours.
Publishing an Actor that is already public has no effect.
${hasTool(HELPER_TOOLS.ACTOR_UNPUBLISH) ? `Use ${HELPER_TOOLS.ACTOR_UNPUBLISH} to remove it from Apify Store again.\n` : ''}
USAGE:
- Use when the user wants to make their Actor public in Apify Store.

USAGE EXAMPLES:
- user_input: Publish my-actor in Apify Store
- user_input: Make my Actor E2jjCZBezvAZnX8Rb public`;
}

/**
 * The API rejects an Actor with no run, or no successful run, with a generic reason that points to support,
 * although running the Actor once is the usual fix.
 */
function buildRejectionText(error: ApifyApiError, loadedToolNames: readonly string[]): string {
    if (error.type !== APIFY_ERROR_TYPE_CANNOT_PUBLISH_ACTOR) return error.message;
    const runStep = loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)
        ? `run it once with ${HELPER_TOOLS.ACTOR_CALL}`
        : 'run it once';
    return `${error.message} This usually means the Actor has no successful run yet; ${runStep} and publish again.`;
}

/**
 * https://docs.apify.com/api/v2/act-put
 *  /v2/acts/{actorId}
 */
export const publishActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_PUBLISH,
    title: 'Publish Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(publishActorArgs) as ToolInputSchema,
    outputSchema: publishActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(publishActorArgs)),
    annotations: {
        title: 'Publish Actor',
        readOnlyHint: false,
        // The Actor becomes public and the publication counts against the daily limit, so clients should confirm.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
        const parsed = publishActorArgs.parse(args);
        try {
            const { actor } = await resolveTargetActor(client, resolveActorNameInput(parsed.actor));
            if (!actor) return respondUserError(`Actor '${parsed.actor}' not found.`);
            // The platform's spelling, not the input's: the API matches a name case-insensitively.
            const fullName = formatActorFullName(actor.username, actor.name);
            const storeUrl = `${APIFY_STORE_URL}/${fullName}`;
            const structuredContent = { id: actor.id, fullName, isPublic: true, storeUrl };
            if (actor.isPublic) {
                return respondOk([JSON.stringify(structuredContent), `${fullName} is already public in Apify Store.`], {
                    structuredContent,
                });
            }
            // Checked here because the API rejects a missing title or category with a generic schema-validation message.
            if (!actor.title || !actor.categories?.length) {
                return respondUserError('Publishing needs a title and at least one category; set them first.');
            }
            try {
                // apify-client retries every 429, and the daily publication limit answers with one: nine attempts
                // over minutes, past the MCP request timeout, each notifying Apify admins. Publishing is
                // idempotent, so a transient failure is safe for the agent to repeat.
                const publicationClient = new ApifyClient({ token: apifyToken, maxRetries: 0 });
                await publicationClient.actor(actor.id).update({ isPublic: true });
            } catch (error) {
                // The publication checks answer with specific, user-facing messages (a missing README, the daily
                // limit, ...). Read failures stay out of this catch: the generic mapper reports a bad token as auth.
                if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                    return respondUserError(buildRejectionText(error, loadedToolNames), {
                        httpStatus: error.statusCode,
                        detail: error.type,
                    });
                }
                throw error;
            }
            const summary = `${fullName} is now public in Apify Store; its Store page is ${storeUrl}.`;
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            throw error;
        }
    },
} as const);
