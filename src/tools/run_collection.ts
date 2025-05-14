import { Ajv } from 'ajv';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolWrap } from '../types.js';

const ajv = new Ajv({ coerceTypes: 'array', strict: false });

const GetUserRunsListArgs = z.object({
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
    status: z.enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING_OUT', 'TIMED_OUT', 'ABORTING', 'ABORTED'])
        .optional()
        .describe('Return only runs with the provided status.'),
});

export const getUserRunsList: ToolWrap = {
    type: 'internal',
    tool: {
        name: HelperTools.GET_ACTOR_RUN_LIST,
        actorFullName: HelperTools.GET_ACTOR_RUN_LIST,
        description: 'Gets a list of all Actor runs. '
            + 'The response is a list of run objects with information about a single Actor run and associated default datasetId and keyValueStoreId.'
            + 'The endpoint supports pagination using the limit and offset parameters'
            + 'Runs can be filtered by status with the following values:'
            + 'READY: initial - Started but not allocated to any worker yet'
            + 'RUNNING: transitional - Executing on a worker machine'
            + 'SUCCEEDED: terminal - Finished successfully'
            + 'FAILED: terminal - Run failed'
            + 'TIMING-OUT: transitional - Timing out now'
            + 'TIMED-OUT: terminal - Timed out'
            + 'ABORTING: transitional - Being aborted by the user'
            + 'ABORTED: terminal - Aborted by the user',
        inputSchema: zodToJsonSchema(GetUserRunsListArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(GetUserRunsListArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = GetUserRunsListArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const runs = await client.runs().list({ limit: parsed.limit, offset: parsed.offset, desc: parsed.desc, status: parsed.status });
            return { content: [{ type: 'text', text: JSON.stringify(runs) }] };
        },
    } as InternalTool,
};

// TODO https://docs.apify.com/api/v2/actor-run-get, https://docs.apify.com/api/v2/actor-run-abort-post,
