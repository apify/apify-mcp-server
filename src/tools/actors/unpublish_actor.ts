import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { unpublishActorToolOutputSchema } from '../structured_output_schemas.js';
import { formatActorFullName, resolveActorNameInput, resolveTargetActor } from './actor_helpers.js';

const unpublishActorArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or name; your own account only'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Unpublish an Actor of your account: remove it from Apify Store.
The Actor stays in your account with its builds and settings.
Users who ran it recently are notified that it was unpublished.
Publishing it again${hasTool(HELPER_TOOLS.ACTOR_PUBLISH) ? ` with ${HELPER_TOOLS.ACTOR_PUBLISH}` : ''} repeats every \
publication check, including the input and output schemas
an older Actor may lack, and counts against the daily publication limit.
Unpublishing an Actor that is not public does nothing.
Paid Actors and Actors marked as critical cannot be unpublished.

USAGE:
- Use when the user wants to take their Actor off Apify Store.

USAGE EXAMPLES:
- user_input: Unpublish my-actor
- user_input: Make my Actor E2jjCZBezvAZnX8Rb private again`;
}

/**
 * https://docs.apify.com/api/v2/act-put
 *  /v2/acts/{actorId}
 */
export const unpublishActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_UNPUBLISH,
    title: 'Unpublish Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(unpublishActorArgs) as ToolInputSchema,
    outputSchema: unpublishActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(unpublishActorArgs)),
    annotations: {
        title: 'Unpublish Actor',
        readOnlyHint: false,
        // The Actor disappears from Apify Store for everyone, so clients should confirm.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = unpublishActorArgs.parse(args);
        try {
            const { actor } = await resolveTargetActor(client, resolveActorNameInput(parsed.actor));
            if (!actor) return respondUserError(`Actor '${parsed.actor}' not found.`);
            // The platform's spelling, not the input's: the API matches a name case-insensitively.
            const fullName = formatActorFullName(actor.username, actor.name);
            const structuredContent = { id: actor.id, fullName, isPublic: false };
            if (!actor.isPublic) {
                return respondOk([JSON.stringify(structuredContent), `${fullName} is already private.`], {
                    structuredContent,
                });
            }
            try {
                await client.actor(actor.id).update({ isPublic: false });
            } catch (error) {
                // Paid and critical Actors are refused with specific, user-facing messages. Read failures stay
                // out of this catch: the generic mapper reports a bad token as auth.
                if (error instanceof ApifyApiError && error.statusCode >= 400 && error.statusCode < 500) {
                    return respondUserError(error.message, { httpStatus: error.statusCode, detail: error.type });
                }
                throw error;
            }
            const summary = `${fullName} is now private and no longer listed in Apify Store.`;
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            throw error;
        }
    },
} as const);
