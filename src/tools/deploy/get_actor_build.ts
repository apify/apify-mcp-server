import type { Build } from 'apify-client';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';
import { getActorBuildToolOutputSchema } from '../structured_output_schemas.js';
import { toBuildResult } from './build_helpers.js';

const getActorBuildArgs = z.object({
    buildId: z.string().min(1).describe('Build ID, as returned when a build is started'),
});

function buildNextStep(build: Build, loadedToolNames: readonly string[]): string {
    if (build.status === 'SUCCEEDED') {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)
            ? `Run the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to ${build.buildNumber}.`
            : 'The build is ready to run.';
    }
    if (TERMINAL_RUN_STATUSES.has(build.status)) {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_RUNS_LOG)
            ? `Read the build log with ${HELPER_TOOLS.ACTOR_RUNS_LOG} using buildId ${build.id}; pass lines 0 for the whole log.`
            : 'Enable the runs tool category to read the build log, then fix the source and build again.';
    }
    return 'Call this tool again in about 10 seconds.';
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

USAGE:
- Use to check whether a build has finished and whether it succeeded.

USAGE EXAMPLES:
- user_input: Did build 7aB3xYz9Kq finish?
- user_input: What is the status of build 7aB3xYz9Kq?`,
    inputSchema: z.toJSONSchema(getActorBuildArgs) as ToolInputSchema,
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
        const build = await client.build(parsed.buildId).get();
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
