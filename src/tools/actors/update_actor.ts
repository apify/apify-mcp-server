import type { Actor, ActorDefaultRunOptions, ActorStandby, ActorUpdateOptions } from 'apify-client';
import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { ACTOR_CATEGORIES, ACTOR_LIMITS, ACTOR_NAME } from '@apify/consts';

import { FAILURE_CATEGORY, HELPER_TOOLS, HTTP_CONFLICT, HTTP_FORBIDDEN } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import type { ToolResponse } from '../../utils/mcp.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { updateActorToolOutputSchema } from '../structured_output_schemas.js';
import {
    ACTOR_NAME_RULE_TEXT,
    formatActorFullName,
    resolveActorNameInput,
    resolveTargetActor,
} from './actor_helpers.js';
import { toIsoString } from './actor_run_response.js';

// Limits of the platform's Actor schema (`Act2Schema` and its run options and standby schemas in
// apify-core) that `@apify/consts` does not export.
const ACTOR_TITLE_MAX_LENGTH = 63;
const ACTOR_DESCRIPTION_MAX_LENGTH = 300;
const ACTOR_SEO_TITLE_MAX_LENGTH = 60;
const ACTOR_SEO_DESCRIPTION_MAX_LENGTH = 200;
const ACTOR_CATEGORIES_MAX_COUNT = 3;
const RUN_TIMEOUT_SECS_MAX = 999_999_999;
const STANDBY_IDLE_TIMEOUT_SECS_MIN = 5;

const { MIN_RUN_MEMORY_MBYTES, MAX_RUN_MEMORY_MBYTES } = ACTOR_LIMITS;

// The power-of-two rule has no JSON-schema form, so `validateMemoryMbytes` checks it.
const memoryMbytesSchema = z.number().int().min(MIN_RUN_MEMORY_MBYTES).max(MAX_RUN_MEMORY_MBYTES);

const updateActorArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe('Actor ID or name: my-scraper, john/my-scraper, or the ID; your own account only'),
    // The shared AJV compiler drops `pattern`, so the character rule is checked in `validateNewName`.
    name: z
        .string()
        .min(ACTOR_NAME.MIN_LENGTH)
        .max(ACTOR_NAME.MAX_LENGTH)
        .optional()
        .describe(
            `New name: ${ACTOR_NAME.MIN_LENGTH} to ${ACTOR_NAME.MAX_LENGTH} letters, digits and dashes, not starting or ending with a dash. Renaming changes the Actor's URL and every username/name reference to it`,
        ),
    title: z
        .string()
        .max(ACTOR_TITLE_MAX_LENGTH)
        .optional()
        .describe(
            `Human-readable title, at most ${ACTOR_TITLE_MAX_LENGTH} characters; an empty string clears it. A public Actor must have one`,
        ),
    description: z
        .string()
        .max(ACTOR_DESCRIPTION_MAX_LENGTH)
        .optional()
        .describe(`Short description, at most ${ACTOR_DESCRIPTION_MAX_LENGTH} characters; an empty string clears it`),
    seoTitle: z
        .string()
        .max(ACTOR_SEO_TITLE_MAX_LENGTH)
        .optional()
        .describe(
            `Title of the Actor's Store page for search engines, at most ${ACTOR_SEO_TITLE_MAX_LENGTH} characters`,
        ),
    seoDescription: z
        .string()
        .max(ACTOR_SEO_DESCRIPTION_MAX_LENGTH)
        .optional()
        .describe(
            `Description of the Actor's Store page for search engines, at most ${ACTOR_SEO_DESCRIPTION_MAX_LENGTH} characters`,
        ),
    categories: z
        .array(z.enum(Object.keys(ACTOR_CATEGORIES) as (keyof typeof ACTOR_CATEGORIES)[]))
        .max(ACTOR_CATEGORIES_MAX_COUNT)
        .optional()
        .describe(
            `Store categories, at most ${ACTOR_CATEGORIES_MAX_COUNT}, as keys such as AI, DEVELOPER_TOOLS or MCP_SERVERS. Replaces the whole list; a public Actor needs at least one`,
        ),
    isDeprecated: z.boolean().optional().describe('true marks the Actor as deprecated, false takes the mark off'),
    defaultRunOptions: z
        .object({
            build: z.string().optional().describe('Build tag or number that runs use, e.g. latest'),
            memoryMbytes: memoryMbytesSchema
                .optional()
                .describe(
                    `Memory of a run in megabytes: a power of two from ${MIN_RUN_MEMORY_MBYTES} to ${MAX_RUN_MEMORY_MBYTES}`,
                ),
            timeoutSecs: z
                .number()
                .int()
                .min(0)
                .max(RUN_TIMEOUT_SECS_MAX)
                .optional()
                .describe('Run timeout in seconds; 0 means no timeout'),
        })
        .optional()
        .describe('Defaults for runs that do not set their own. Only the sub-fields given change'),
    actorStandby: z
        .object({
            isEnabled: z.boolean().optional().describe('Turns standby mode on or off'),
            build: z.string().optional().describe('Build tag or number that standby runs use'),
            memoryMbytes: memoryMbytesSchema
                .optional()
                .describe(
                    `Memory of a standby run in megabytes: a power of two from ${MIN_RUN_MEMORY_MBYTES} to ${MAX_RUN_MEMORY_MBYTES}`,
                ),
            idleTimeoutSecs: z
                .number()
                .int()
                .min(STANDBY_IDLE_TIMEOUT_SECS_MIN)
                .optional()
                .describe(
                    `Seconds a standby run waits without requests before it stops; at least ${STANDBY_IDLE_TIMEOUT_SECS_MIN}`,
                ),
            desiredRequestsPerActorRun: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('Concurrent requests a standby run aims to handle before another run starts'),
            maxRequestsPerActorRun: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('Most concurrent requests a standby run handles; not below desiredRequestsPerActorRun'),
        })
        .optional()
        .describe(
            'Standby mode, which keeps the Actor ready to answer HTTP requests. Only the sub-fields given change',
        ),
});

type UpdateActorFields = Omit<z.infer<typeof updateActorArgs>, 'actor'>;

/** What is sent: the client types these two objects as whole, but the API merges partial ones. */
type ActorUpdatePayload = Omit<ActorUpdateOptions, 'defaultRunOptions' | 'actorStandby'> & {
    defaultRunOptions?: Partial<ActorDefaultRunOptions>;
    actorStandby?: Partial<ActorStandby & { isEnabled: boolean }>;
};

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Update the settings of an Actor in your own account: its name, title, description, SEO title and description,
Store categories, deprecation, default run options (build, memory, timeout), and standby mode.
Only the fields given change; the others keep their stored values, and so do the sub-fields of defaultRunOptions and
actorStandby that are not given. categories replaces the whole list.
Renaming changes the Actor's URL and every username/name reference to it.
This does not publish or unpublish the Actor.${
        hasTool(HELPER_TOOLS.ACTOR_PUSH) ? ` To change its source code, use ${HELPER_TOOLS.ACTOR_PUSH}.` : ''
    }
Returns the Actor's settings as stored after the update and a summary of the fields sent.

USAGE:
- Use to rename an Actor or change its title, description, or SEO texts.
- Use to set an Actor's Store categories or mark it as deprecated.
- Use to change the default build, memory, or timeout of an Actor's runs, or to set up its standby mode.

USAGE EXAMPLES:
- user_input: Rename my-scraper to google-maps-scraper
- user_input: Set the default memory of my-scraper to 4 GB
- user_input: Mark my old-scraper Actor as deprecated`;
}

function validateNewName(name: string | undefined): void {
    if (name !== undefined && !ACTOR_NAME.REGEX.test(name)) throw new UserInputError(ACTOR_NAME_RULE_TEXT);
}

function validateMemoryMbytes(fieldPath: string, memoryMbytes: number | undefined): void {
    if (memoryMbytes === undefined || Number.isInteger(Math.log2(memoryMbytes))) return;
    throw new UserInputError(
        `${fieldPath} must be a power of two between ${MIN_RUN_MEMORY_MBYTES} and ${MAX_RUN_MEMORY_MBYTES}, like 1024 or 4096.`,
    );
}

function hasFields<T extends object>(value: T | undefined): value is T {
    return value !== undefined && Object.keys(value).length > 0;
}

/**
 * The given fields and nothing else, so the stored values of the others stay. The API merges
 * `defaultRunOptions` and `actorStandby` into the stored objects, so their given sub-fields go alone,
 * with no read first; an empty one is left out, because the API would still write the schema defaults
 * into an Actor that has none. Throws `UserInputError` for a rule the input schema cannot express.
 */
function buildActorUpdate(fields: UpdateActorFields): ActorUpdatePayload {
    const { defaultRunOptions, actorStandby, ...topLevelFields } = fields;
    validateNewName(topLevelFields.name);
    validateMemoryMbytes('defaultRunOptions.memoryMbytes', defaultRunOptions?.memoryMbytes);
    validateMemoryMbytes('actorStandby.memoryMbytes', actorStandby?.memoryMbytes);
    const update = {
        ...topLevelFields,
        ...(hasFields(defaultRunOptions) && { defaultRunOptions }),
        ...(hasFields(actorStandby) && { actorStandby }),
    };
    if (Object.keys(update).length === 0) throw new UserInputError('Give at least one field to change.');
    return update;
}

/** The allowlisted settings; internal fields such as `userId` stay out. */
function buildUpdateActorResult(actor: Actor) {
    const { defaultRunOptions, actorStandby } = actor;
    return {
        id: actor.id,
        name: actor.name,
        username: actor.username,
        fullName: formatActorFullName(actor.username, actor.name),
        title: actor.title ?? null,
        description: actor.description ?? null,
        seoTitle: actor.seoTitle ?? null,
        seoDescription: actor.seoDescription ?? null,
        categories: actor.categories ?? null,
        isPublic: actor.isPublic,
        isDeprecated: actor.isDeprecated ?? null,
        defaultRunOptions: defaultRunOptions
            ? {
                  build: defaultRunOptions.build ?? null,
                  memoryMbytes: defaultRunOptions.memoryMbytes ?? null,
                  timeoutSecs: defaultRunOptions.timeoutSecs ?? null,
              }
            : null,
        // The tenancy and auth fields are admin-only, so they are neither accepted nor returned.
        actorStandby: actorStandby
            ? {
                  isEnabled: actorStandby.isEnabled ?? null,
                  build: actorStandby.build ?? null,
                  memoryMbytes: actorStandby.memoryMbytes ?? null,
                  idleTimeoutSecs: actorStandby.idleTimeoutSecs ?? null,
                  desiredRequestsPerActorRun: actorStandby.desiredRequestsPerActorRun ?? null,
                  maxRequestsPerActorRun: actorStandby.maxRequestsPerActorRun ?? null,
              }
            : null,
        // The client parses dates into `Date`; the output schema promises a string.
        modifiedAt: toIsoString(actor.modifiedAt) ?? null,
    };
}

/** A 4xx the caller can act on, answered with the API's own reason. */
function respondApiRejection(error: ApifyApiError, newName: string | undefined): ToolResponse {
    const httpStatus = error.statusCode;
    // A name clash is the only conflict this endpoint raises.
    if (httpStatus === HTTP_CONFLICT && newName !== undefined) {
        return respondUserError(`You already have an Actor named ${newName}.`, { httpStatus });
    }
    const category = httpStatus === HTTP_FORBIDDEN ? FAILURE_CATEGORY.AUTH : FAILURE_CATEGORY.INVALID_INPUT;
    return respondUserError(error.message, { category, httpStatus });
}

/**
 * https://docs.apify.com/api/v2/act-put
 *  /v2/acts/{actorId}
 *
 * Resolves apify/apify-mcp-server#1413.
 */
export const updateActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_UPDATE,
    title: 'Update Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(updateActorArgs) as ToolInputSchema,
    outputSchema: updateActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(updateActorArgs)),
    annotations: {
        title: 'Update Actor',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const { actor, ...fields } = updateActorArgs.parse(args);
        try {
            const actorNameParts = resolveActorNameInput(actor);
            const update = buildActorUpdate(fields);
            const target = await resolveTargetActor(client, actorNameParts);
            if (!target.actor) {
                return respondUserError(`Actor '${actor}' was not found in your account (${target.username}).`);
            }
            // The client types the two nested objects as whole; see `ActorUpdatePayload`.
            const updated = await client.actor(target.actor.id).update(update as ActorUpdateOptions);

            const result = buildUpdateActorResult(updated);
            const previousFullName = formatActorFullName(target.actor.username, target.actor.name);
            // The platform matches Actor names regardless of case, so a case-only rename keeps the URL and references.
            const renameNote =
                result.fullName.toLowerCase() === previousFullName.toLowerCase()
                    ? ''
                    : ` The Actor is now ${result.fullName}; its URL and references to ${previousFullName} changed.`;
            const summary = `Updated ${previousFullName}: ${Object.keys(update).join(', ')}.${renameNote}`;
            return respondOk([JSON.stringify(result), summary], { structuredContent: result });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            if (error instanceof ApifyApiError && error.statusCode < 500) {
                return respondApiRejection(error, fields.name);
            }
            throw error;
        }
    },
} as const);
