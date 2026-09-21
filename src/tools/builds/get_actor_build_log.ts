import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema, fixZodSchemaRequired } from '../../utils/ajv.js';
import { respondOk, respondUserError } from '../../utils/mcp.js';
import { getActorBuildLogToolOutputSchema } from '../structured_output_schemas.js';

const getActorBuildLogArgs = z.object({
    buildId: z.string().min(1).describe('Build ID, as returned when a build is started'),
    lines: z
        .number()
        .int()
        .min(0)
        .max(50)
        .describe('Output the last NUM lines, instead of the last 10. Pass 0 to return the entire log.')
        .default(10),
});

/**
 * https://docs.apify.com/api/v2/actor-build-log-get
 *  /v2/actor-builds/{buildId}/log
 */
export const getActorBuildLog: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_BUILD_LOG,
    title: 'Get Actor build log',
    description: `Retrieve recent log lines for a specific Actor build.
The results will include the last N lines of the build log output (plain text).

USAGE:
- Use when a build failed and you need the build log to find the error.
- Use when you need to inspect the build output while a build is running.

USAGE EXAMPLES:
- user_input: Show last 20 lines of the log for build 7aB3xYz9Kq
- user_input: Why did build 7aB3xYz9Kq fail?`,
    // `fixZodSchemaRequired` strips fields with a real `default` from `required` so MCP clients
    // that read `tools/list` see `lines` as optional (matching its runtime behavior).
    inputSchema: fixZodSchemaRequired(z.toJSONSchema(getActorBuildLogArgs)) as ToolInputSchema,
    outputSchema: getActorBuildLogToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getActorBuildLogArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get Actor build log',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getActorBuildLogArgs.parse(args);
        const v = await client.build(parsed.buildId).log().get();
        // The log endpoint 404s only when the build itself is missing; an existing build with no
        // output yet returns an empty string. So `undefined` here means "not found"; do not
        // coalesce it back to ''.
        if (v === undefined) {
            return respondUserError(`Build with ID '${parsed.buildId}' not found.`);
        }
        // Logs from the API end with a newline; drop it so the tail slice counts only content lines.
        const lines = v.replace(/\n$/, '').split('\n');
        const text = lines.slice(-parsed.lines).join('\n');
        return respondOk(text, { structuredContent: { log: text } });
    },
} as const);
