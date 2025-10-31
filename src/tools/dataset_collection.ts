import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalToolArgs, McpInputSchema, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';

const getUserDatasetsListArgs = z.object({
    offset: z.number()
        .describe('Number of array elements that should be skipped at the start. The default value is 0.')
        .default(0),
    limit: z.number()
        .max(20)
        .describe('Maximum number of array elements to return. The default value (as well as the maximum) is 20.')
        .default(10),
    desc: z.boolean()
        .describe('If true or 1 then the datasets are sorted by the createdAt field in descending order. Default: sorted in ascending order.')
        .default(false),
    unnamed: z.boolean()
        .describe('If true or 1 then all the datasets are returned. By default only named datasets are returned.')
        .default(false),
});

/**
 * https://docs.apify.com/api/v2/datasets-get
 */
export const getUserDatasetsList: ToolEntry = {
    type: 'internal',
    name: HelperTools.DATASET_LIST_GET,
    description: `List datasets (collections of Actor run data) for the authenticated user.
Actor runs automatically produce unnamed datasets (set unnamed=true to include them). Users can also create named datasets.

The results will include datasets with itemCount, access settings, and usage stats, sorted by createdAt (ascending by default).
Use limit (max 20), offset, and desc to paginate and sort.

USAGE:
- Use when you need to browse available datasets (named or unnamed) to locate data.

USAGE EXAMPLES:
- user_input: List my last 10 datasets (newest first)
- user_input: List unnamed datasets`,
    inputSchema: zodToJsonSchema(getUserDatasetsListArgs) as McpInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getUserDatasetsListArgs)),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getUserDatasetsListArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const datasets = await client.datasets().list({
            limit: parsed.limit,
            offset: parsed.offset,
            desc: parsed.desc,
            unnamed: parsed.unnamed,
        });
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(datasets)}\n\`\`\`` }] };
    },
} as const;
