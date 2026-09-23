import type { Actor } from 'apify-client';
import { ApifyApiError } from 'apify-client';
import { z } from 'zod';

import { FAILURE_CATEGORY, HELPER_TOOLS } from '../../const.js';
import { UserInputError } from '../../errors.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { actorSettingsOutputSchema } from '../structured_output_schemas.js';
import { formatActorFullName, resolveActorNameInput, resolveTargetActor } from './actor_helpers.js';
import { toIsoString } from './actor_run_response.js';

const getActorSettingsArgs = z.object({
    actor: z
        .string()
        .min(1)
        .describe('Actor ID or name: my-scraper, john/my-scraper, or the ID; your own account only'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Get the settings of an Actor in your own account, as its owner sees them: name, title, description, SEO title and description, categories, whether it is public or deprecated, default run options, standby settings, the versions with their source type, build tag and environment variables, and the tagged builds.
Environment variables are listed by name and secret flag only; their values are never returned.
Works for an Actor that was never built.
${hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS) ? `For the Store view of an Actor (README, input schema, pricing), use ${HELPER_TOOLS.ACTOR_GET_DETAILS}.\n` : ''}
USAGE:
- Use to check how your own Actor is configured before changing it.
- Use to see which versions, build tags and environment variables an Actor has.

USAGE EXAMPLES:
- user_input: Show the settings of my Actor my-scraper
- user_input: Which environment variables does john/my-scraper have?
- user_input: Is my Actor my-scraper public?`;
}

/**
 * The allowlisted owner's view of an Actor. Environment variables keep only their name and secret flag: the API
 * returns non-secret values in plaintext and a hash of secret ones, and neither may reach the agent.
 */
function buildActorSettingsResult(actor: Actor) {
    const { actorStandby } = actor;
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
        defaultRunOptions: {
            build: actor.defaultRunOptions.build,
            memoryMbytes: actor.defaultRunOptions.memoryMbytes,
            timeoutSecs: actor.defaultRunOptions.timeoutSecs,
        },
        actorStandby: actorStandby
            ? {
                  isEnabled: actorStandby.isEnabled,
                  build: actorStandby.build ?? null,
                  memoryMbytes: actorStandby.memoryMbytes ?? null,
                  idleTimeoutSecs: actorStandby.idleTimeoutSecs ?? null,
                  desiredRequestsPerActorRun: actorStandby.desiredRequestsPerActorRun ?? null,
                  maxRequestsPerActorRun: actorStandby.maxRequestsPerActorRun ?? null,
              }
            : null,
        versions: actor.versions.map((version) => ({
            versionNumber: version.versionNumber ?? null,
            sourceType: version.sourceType,
            buildTag: version.buildTag ?? null,
            envVars:
                version.envVars?.map((envVar) => ({ name: envVar.name ?? null, isSecret: envVar.isSecret ?? null })) ??
                null,
        })),
        taggedBuilds: actor.taggedBuilds
            ? Object.fromEntries(
                  Object.entries(actor.taggedBuilds).map(([tag, build]) => [
                      tag,
                      {
                          buildId: build.buildId ?? null,
                          buildNumber: build.buildNumber ?? null,
                          finishedAt: toIsoString(build.finishedAt) ?? null,
                      },
                  ]),
              )
            : null,
        createdAt: toIsoString(actor.createdAt) ?? null,
        modifiedAt: toIsoString(actor.modifiedAt) ?? null,
    };
}

/**
 * https://docs.apify.com/api/v2/act-get
 *  /v2/acts/{actorId}
 *
 * A separate tool rather than a section of fetch-actor-details, which unauthenticated sessions are served,
 * whose structured content the hosted server consumes, and which fails for an Actor without a default build.
 * Resolves apify/apify-mcp-server#1414.
 */
export const getActorSettings: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_SETTINGS_GET,
    title: 'Get Actor settings',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    inputSchema: z.toJSONSchema(getActorSettingsArgs) as ToolInputSchema,
    outputSchema: actorSettingsOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorSettingsArgs)),
    annotations: {
        title: 'Get Actor settings',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getActorSettingsArgs.parse(args);
        try {
            const { username, actor } = await resolveTargetActor(client, resolveActorNameInput(parsed.actor));
            if (!actor) {
                return respondUserError(`No Actor '${parsed.actor}' in your account (${username}).`);
            }
            const structuredContent = buildActorSettingsResult(actor);
            const versionCount = structuredContent.versions.length;
            const summary = `Settings of ${structuredContent.fullName}: ${versionCount} ${
                versionCount === 1 ? 'version' : 'versions'
            }, public: ${structuredContent.isPublic ? 'yes' : 'no'}.`;
            return respondOk([JSON.stringify(structuredContent), summary], { structuredContent });
        } catch (error) {
            if (error instanceof UserInputError) return respondUserError(error.message);
            // Scoped tokens are refused the users/me lookup the resolver makes; a token that cannot read the Actor
            // gets a 404 instead and is reported as not found.
            if (error instanceof ApifyApiError && error.statusCode === 403) {
                return respondUserError(
                    'The token is not allowed to read Actors in this account; scoped tokens cannot look up the account this tool needs. Use a token with full access.',
                    { category: FAILURE_CATEGORY.AUTH, httpStatus: 403 },
                );
            }
            throw error;
        }
    },
} as const);
