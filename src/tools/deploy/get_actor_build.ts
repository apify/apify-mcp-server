import type { Build } from 'apify-client';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { WAIT_SECS_MAX } from '../actors/actor_run_response.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';
import { getActorBuildToolOutputSchema } from '../structured_output_schemas.js';
import { toBuildResult } from './build_helpers.js';

/** Default `waitSecs` for `get-actor-build`. Intentionally non-zero so polling callers wait briefly by default. */
const WAIT_SECS_DEFAULT = 30;

const getActorBuildArgs = z.object({
    buildId: z.string().min(1).describe('Build ID, as returned when a build is started'),
    waitSecs: z.number().int().min(0).max(WAIT_SECS_MAX).optional().default(WAIT_SECS_DEFAULT).describe(dedent`
            Maximum seconds to wait for the build to reach a terminal state (SUCCEEDED, FAILED, ABORTED, TIMED-OUT).
            0 returns immediately with the current status. Cap: ${WAIT_SECS_MAX}. Default: ${WAIT_SECS_DEFAULT}.
        `),
});

function buildNextStep(build: Build, loadedToolNames: readonly string[]): string {
    if (build.status === 'SUCCEEDED') {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)
            ? `Run the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to ${build.buildNumber}.`
            : 'The build is ready to run.';
    }
    if (TERMINAL_RUN_STATUSES.has(build.status)) {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_BUILD_LOG)
            ? `Read the build log with ${HELPER_TOOLS.ACTOR_BUILD_LOG} using buildId ${build.id}; pass lines 0 for the whole log.`
            : 'Read the build log for the error, fix the source, and build again.';
    }
    return `Call this tool again with waitSecs ${WAIT_SECS_MAX} to keep waiting.`;
}

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
- waitSecs (0–${WAIT_SECS_MAX}, default ${WAIT_SECS_DEFAULT}) waits up to that many seconds for terminal status before returning.

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
        const { args, apifyClient: client, apifyToken, loadedToolNames } = toolArgs;
        const parsed = getActorBuildArgs.parse(args);
        const build = await client.build(parsed.buildId).get({ waitForFinish: parsed.waitSecs });
        if (!build) {
            return respondUserError(`Build with ID '${parsed.buildId}' not found.`);
        }
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const structuredContent = { build: toBuildResult(build, linkContext) };
        const summary = `Build ${build.buildNumber} of Actor ${build.actId} is ${build.status}.`;
        const consoleLinkText = apifyConsoleLinkText(structuredContent.build.apifyConsoleUrl);
        return respondOk(
            [
                JSON.stringify(structuredContent),
                `${summary}\n${buildNextStep(build, loadedToolNames)}`,
                ...(consoleLinkText ? [consoleLinkText] : []),
            ],
            { structuredContent },
        );
    },
} as const);
