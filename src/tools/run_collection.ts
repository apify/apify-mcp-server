import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';

const getUserRunsListArgs = z.object({
    offset: z.number()
        .describe('Number of array elements that should be skipped at the start. The default value is 0.')
        .default(0),
    limit: z.number()
        .max(10)
        .describe('Maximum number of array elements to return. The default value (as well as the maximum) is 10.')
        .default(10),
    desc: z.boolean()
        .describe('If true or 1 then the runs are sorted by the startedAt field in descending order. Default: sorted in ascending order.')
        .default(false),
    status: z.enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED'])
        .optional()
        .describe('Return only runs with the provided status.'),
});

/**
 * https://docs.apify.com/api/v2/act-runs-get
 */
export const getUserRunsList: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.ACTOR_RUN_LIST_GET,
        actorFullName: HelperTools.ACTOR_RUN_LIST_GET,
        description: `Gets a paginated list of Actor runs with run details, datasetId, and keyValueStoreId.\n`
            + 'Filter by status: READY (not allocated), RUNNING (executing), SUCCEEDED (finished), FAILED (failed),\n'
            + 'TIMING-OUT (timing out), TIMED-OUT (timed out), ABORTING (being aborted), ABORTED (aborted).',
        inputSchema: zodToJsonSchema(getUserRunsListArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getUserRunsListArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getUserRunsListArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const runs = await client.runs().list({ limit: parsed.limit, offset: parsed.offset, desc: parsed.desc, status: parsed.status });
            return { content: [{ type: 'text', text: JSON.stringify(runs) }] };
        },
    } as InternalTool,
};
