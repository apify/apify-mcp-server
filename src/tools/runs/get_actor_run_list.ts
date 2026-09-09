import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { respondRaw, respondUserError } from '../../utils/mcp.js';
import { catchNotFound } from '../storage/storage_helpers.js';
import { actorRunListOutputSchema } from '../structured_output_schemas.js';

const getUserRunsListArgs = z.object({
    actorId: z
        .string()
        .min(1)
        .optional()
        .describe('Only list runs of this Actor; accepts an Actor ID or username/name.'),
    offset: z
        .number()
        .describe('Number of array elements that should be skipped at the start. The default value is 0.')
        .default(0),
    limit: z
        .number()
        .max(10)
        .describe('Maximum number of array elements to return. The default value (as well as the maximum) is 10.')
        .default(10),
    desc: z
        .boolean()
        .describe(
            'If true or 1 then the runs are sorted by the startedAt field in descending order. Default: sorted in ascending order.',
        )
        .default(false),
    status: z
        .enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED'])
        .optional()
        .describe('Return only runs with the provided status.'),
});

/**
 * https://docs.apify.com/api/v2/actor-runs-get (all runs of the user)
 * https://docs.apify.com/api/v2/act-runs-get (runs of one Actor, when `actorId` is given)
 */
export const getActorRunList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.ACTOR_RUN_LIST_GET,
    title: 'Get user runs list',
    description: `List Actor runs for the authenticated user with optional filtering and sorting.
The results will include run details (including defaultDatasetId and defaultKeyValueStoreId) and can be filtered by Actor and by status.
Pass actorId to list only the runs of one Actor, for example to find its latest run.
Valid statuses: READY (not allocated), RUNNING (executing), SUCCEEDED (finished), FAILED (failed), TIMING-OUT, TIMED-OUT, ABORTING, ABORTED.

USAGE:
- Use when you need to browse or filter recent Actor runs.

USAGE EXAMPLES:
- user_input: List my last 10 runs (newest first)
- user_input: Show only SUCCEEDED runs
- user_input: Show the latest run of apify/web-scraper`,
    inputSchema: z.toJSONSchema(getUserRunsListArgs) as ToolInputSchema,
    outputSchema: actorRunListOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getUserRunsListArgs)),
    annotations: {
        title: 'Get user runs list',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient } = toolArgs;
        const parsed = getUserRunsListArgs.parse(args);
        const listOptions = {
            limit: parsed.limit,
            offset: parsed.offset,
            desc: parsed.desc,
            status: parsed.status,
        };
        const runs = parsed.actorId
            ? await catchNotFound(apifyClient.actor(parsed.actorId).runs().list(listOptions))
            : await apifyClient.runs().list(listOptions);
        if (!runs) {
            return respondUserError(`Actor '${parsed.actorId}' not found.`);
        }
        return respondRaw({
            content: [{ type: 'text', text: JSON.stringify(runs) }],
            structuredContent: runs as unknown as Record<string, unknown>,
        });
    },
} as const);
