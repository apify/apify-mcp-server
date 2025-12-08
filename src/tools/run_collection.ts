import { z } from 'zod';


import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../types.js';
import { compileSchema } from '../utils/ajv.js';
import { buildMCPResponse } from '../utils/mcp.js';

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
    name: HelperTools.ACTOR_RUN_LIST_GET,
    description: `List Actor runs for the authenticated user with optional filtering and sorting.
The results will include run details (including datasetId and keyValueStoreId) and can be filtered by status.
Valid statuses: READY (not allocated), RUNNING (executing), SUCCEEDED (finished), FAILED (failed), TIMING-OUT, TIMED-OUT, ABORTING, ABORTED.

USAGE:
- Use when you need to browse or filter recent Actor runs.

USAGE EXAMPLES:
- user_input: List my last 10 runs (newest first)
- user_input: Show only SUCCEEDED runs`,
    inputSchema: z.toJSONSchema(getUserRunsListArgs) as ToolInputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getUserRunsListArgs)),
    annotations: {
        title: 'Get user runs list',
        readOnlyHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getUserRunsListArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const runs = await client.runs().list({ limit: parsed.limit, offset: parsed.offset, desc: parsed.desc, status: parsed.status });
        return buildMCPResponse({
            texts: [`\`\`\`json\n${JSON.stringify(runs)}\n\`\`\``],
        });
    },
} as const;
