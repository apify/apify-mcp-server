import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondAborted, respondUserError } from '../../utils/mcp.js';
import { TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { ABORT, raceAbort, WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { getActorBuildToolOutputSchema } from '../structured_output_schemas.js';
import {
    BUILD_WAIT_SECS_DEFAULT,
    buildNextStepForBuild,
    buildWaitSecsField,
    respondWithBuild,
    toBuildResult,
    waitForBuild,
} from './build_helpers.js';

const getActorBuildArgs = z.object({
    buildId: z.string().min(1).describe('Build ID, as returned when a build is started'),
    waitSecs: buildWaitSecsField('0 returns immediately with the current status.'),
});

/**
 * https://docs.apify.com/api/v2/actor-build-get
 *  /v2/actor-builds/{buildId}
 */
export const getActorBuild: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_BUILD_GET,
    title: 'Get Actor build',
    description: `Get the status of an Actor build.
Read-only. Returns the build (id, actorId, buildNumber, status, startedAt, finishedAt)
and a summary with one next step.
- waitSecs (0–${WAIT_SECS_MAX}, default ${BUILD_WAIT_SECS_DEFAULT}) waits up to that many seconds for terminal status before returning.

USAGE:
- Use to check whether a build has finished and whether it succeeded.
- Pass waitSecs > 0 to block until terminal (or until the cap elapses).

USAGE EXAMPLES:
- user_input: Did build 7aB3xYz9Kq finish?
- user_input: Wait for build 7aB3xYz9Kq to finish`,
    // `fixZodSchemaRequired` strips fields with a real `default` from `required` so MCP clients
    // that read `tools/list` see `waitSecs` as optional (matching its runtime behavior).
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(getActorBuildArgs)) as ToolInputSchema,
    outputSchema: getActorBuildToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorBuildArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get Actor build',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken, loadedToolNames, signal, progressTracker } = toolArgs;
        const parsed = getActorBuildArgs.parse(args);
        // Fetched before any wait, like get-actor-run, so a finished build returns at once and an
        // unfinished one seeds the progress notifications. Races are against the request signal so a
        // cancelled call returns promptly; per MCP spec, receivers SHOULD NOT respond to a cancelled request.
        const current = await raceAbort(client.build(parsed.buildId).get(), signal);
        if (current === ABORT) return respondAborted();
        if (!current) {
            return respondUserError(`Build with ID '${parsed.buildId}' not found.`);
        }
        const build =
            parsed.waitSecs > 0 && !TERMINAL_RUN_STATUSES.has(current.status)
                ? await waitForBuild(client, current, { waitSecs: parsed.waitSecs, signal, progressTracker })
                : current;
        if (build === ABORT) return respondAborted();
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const structuredContent = { build: toBuildResult(build, linkContext) };
        const summary = `Build ${build.buildNumber} of Actor ${build.actId} is ${build.status}.`;
        const nextStep = buildNextStepForBuild(build, {
            loadedToolNames,
            nonTerminalNextStep: `Call this tool again with waitSecs ${WAIT_SECS_MAX} to keep waiting.`,
        });
        return respondWithBuild({ structuredContent, summary, nextStep });
    },
} as const);
