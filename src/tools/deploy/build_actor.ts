import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolDescriptionContext, ToolEntry, ToolInputSchema } from '../../types.js';
import { ALL_TOOLS_PRESENT, TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';
import { buildActorToolOutputSchema } from '../structured_output_schemas.js';
import { buildNextStepForBuild, startBuild, toBuildResult } from './build_helpers.js';

const buildActorArgs = z.object({
    actor: z.string().min(1).describe('Actor ID or username/name'),
    // Format is not enforced by a regex: AJV here drops `pattern`, and the lookup against the Actor's
    // versions below rejects anything that is not an existing MAJOR.MINOR version with a soft fail.
    versionNumber: z
        .string()
        .optional()
        .describe('Version to build in MAJOR.MINOR form; defaults to the only version when the Actor has exactly one'),
    tag: z.string().optional().describe('Build tag to assign, for example latest'),
    useCache: z.boolean().default(true).describe('Reuse the Docker layer cache from the previous build'),
    waitSecs: z
        .number()
        .int()
        .min(0)
        .max(WAIT_SECS_MAX)
        .default(WAIT_SECS_MAX)
        .describe('How long to wait for the build to finish before returning its current status'),
});

function buildDescription({ hasTool }: ToolDescriptionContext): string {
    return `Build an Actor version on the Apify platform and wait a bounded time for the build to finish.
Returns the build (id, actorId, buildNumber, status, startedAt, finishedAt) and a summary with one next step.
Use after the Actor's source changed so runs pick up the new code.${
        hasTool(HELPER_TOOLS.ACTOR_BUILD_GET)
            ? ` If the build is still running when the wait ends, check it with ${HELPER_TOOLS.ACTOR_BUILD_GET}.`
            : ''
    }

USAGE:
- Use to rebuild an Actor after changing its source.
- Use to build a specific version and tag it, for example as latest.

USAGE EXAMPLES:
- user_input: Rebuild my-actor
- user_input: Build version 0.2 of john/my-actor and tag it latest`;
}

/**
 * https://docs.apify.com/api/v2/act-builds-post
 *  /v2/acts/{actorId}/builds
 */
export const buildActor: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_BUILD,
    title: 'Build Actor',
    description: buildDescription(ALL_TOOLS_PRESENT),
    buildDescription,
    // `fixZodSchemaRequired` strips `useCache` and `waitSecs` from `required` because they have defaults.
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(buildActorArgs)) as ToolInputSchema,
    outputSchema: buildActorToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(buildActorArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Build Actor',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
        const parsed = buildActorArgs.parse(args);
        const actor = await client.actor(parsed.actor).get();
        if (!actor) {
            return respondUserError(`Actor '${parsed.actor}' not found.`);
        }
        const versionNumbers = actor.versions.flatMap((version) => version.versionNumber ?? []);
        if (versionNumbers.length === 0) {
            return respondUserError(`Actor '${parsed.actor}' has no versions to build.`);
        }
        if (parsed.versionNumber !== undefined && !versionNumbers.includes(parsed.versionNumber)) {
            return respondUserError(
                `Actor '${parsed.actor}' has no version ${parsed.versionNumber}; available versions: ${versionNumbers.join(', ')}.`,
            );
        }
        if (parsed.versionNumber === undefined && versionNumbers.length !== 1) {
            return respondUserError(`Specify versionNumber; this Actor has versions: ${versionNumbers.join(', ')}.`);
        }
        const versionNumber = parsed.versionNumber ?? versionNumbers[0];
        const build = await startBuild(client, actor.id, versionNumber, {
            tag: parsed.tag,
            useCache: parsed.useCache,
            waitSecs: parsed.waitSecs,
        });
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const structuredContent = { build: toBuildResult(build, linkContext) };
        const summary = `Started build ${build.buildNumber} of Actor ${build.actId} (version ${versionNumber}); status ${build.status}.`;
        const consoleLinkText = apifyConsoleLinkText(structuredContent.build.apifyConsoleUrl);
        return respondOk(
            [
                JSON.stringify(structuredContent),
                `${summary}\n${buildNextStepForBuild(build, parsed.tag, loadedToolNames)}`,
                ...(consoleLinkText ? [consoleLinkText] : []),
            ],
            { structuredContent },
        );
    },
} as const);
