import type { Build } from 'apify-client';
import { z } from 'zod';

import type { ApifyClient } from '../../apify_client.js';
import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { getConsoleLinkContext } from '../../utils/console_link.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { TERMINAL_RUN_STATUSES } from '../../utils/progress.js';
import { apifyConsoleLinkText } from '../storage/storage_helpers.js';
import { getActorBuildToolOutputSchema } from '../structured_output_schemas.js';
import { toBuildResult } from './build_helpers.js';

const getActorBuildArgs = z.object({
    buildId: z.string().min(1).describe('Build ID, as returned when a build is started'),
    lines: z
        .number()
        .int()
        .min(0)
        .max(50)
        .default(20)
        .describe('Number of trailing log lines to include; 0 returns no log'),
});

/**
 * https://docs.apify.com/api/v2/actor-build-log-get
 *  /v2/actor-builds/{buildId}/log
 */
async function fetchLogTail(client: ApifyClient, buildId: string, lines: number): Promise<string[]> {
    const log = await client.build(buildId).log().get();
    if (!log) return [];
    // Logs from the API end with a newline; drop it so the tail slice counts only content lines.
    return log.replace(/\n$/, '').split('\n').slice(-lines);
}

function buildNextStep(build: Build, loadedToolNames: readonly string[]): string {
    if (build.status === 'SUCCEEDED') {
        return loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)
            ? `Run the Actor with ${HELPER_TOOLS.ACTOR_CALL} and set callOptions.build to ${build.buildNumber}.`
            : 'The build is ready to run.';
    }
    if (TERMINAL_RUN_STATUSES.has(build.status)) {
        return 'Read the log tail for the error, fix the source, and build again.';
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
    description: `Get the status of an Actor build and the last lines of its build log.
Read-only. Returns the build (id, actorId, buildNumber, status, startedAt, finishedAt), the log tail,
and a summary with one next step.

USAGE:
- Use to check whether a build has finished.
- Use when a build FAILED to read the error from the log tail before fixing the source.

USAGE EXAMPLES:
- user_input: Did build 7aB3xYz9Kq finish?
- user_input: Why did build 7aB3xYz9Kq fail?`,
    // `fixZodSchemaRequired` strips `lines` from `required` because it has a default.
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
        const build = await client.build(parsed.buildId).get();
        if (!build) {
            return respondUserError(`Build with ID '${parsed.buildId}' not found.`);
        }
        const logTail = parsed.lines > 0 ? await fetchLogTail(client, parsed.buildId, parsed.lines) : [];
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const structuredContent = { build: toBuildResult(build, linkContext), logTail };
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
