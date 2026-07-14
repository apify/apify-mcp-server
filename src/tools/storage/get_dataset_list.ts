import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { storageListOutputSchema } from '../structured_output_schemas.js';
import { buildStorageListSummaryNextStep, buildStorageResponse } from './storage_helpers.js';

const getUserDatasetsListArgs = z.object({
    offset: z
        .number()
        .describe('Number of array elements that should be skipped at the start. Default is 0.')
        .default(0),
    limit: z
        .number()
        .max(20)
        .describe('Maximum number of array elements to return. Default is 10. Maximum is 20.')
        .default(10),
    desc: z
        .boolean()
        .describe(
            'If true or 1 then the datasets are sorted by the createdAt field in descending order. Default is false (ascending order).',
        )
        .default(false),
    unnamed: z
        .boolean()
        .describe('If true or 1 then all the datasets are returned. Default is false (named datasets only).')
        .default(false),
});

/**
 * https://docs.apify.com/api/v2/datasets-get
 */
export const getDatasetList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.DATASET_LIST_GET,
    title: 'Get user datasets list',
    description: dedent`
        List the datasets owned by the authenticated user — collections of structured data produced by Actor runs.
        Returns summaries only, not their contents — use ${HELPER_TOOLS.DATASET_GET} to inspect one from the list.
        Actor runs automatically produce unnamed datasets (set unnamed=true to include them); users can also create named datasets.
        Each dataset's stats.inflatedBytes is its approximate uncompressed byte size — use it with itemCount to gauge size before fetching.
        Sorted by createdAt (ascending by default); use limit (max 20), offset, and desc to paginate and sort.

        USAGE:
        - Use when you need to browse available datasets (named or unnamed) to locate data.

        USAGE EXAMPLES:
        - user_input: List my last 10 datasets (newest first)
        - user_input: List unnamed datasets`,
    inputSchema: z.toJSONSchema(getUserDatasetsListArgs) as ToolInputSchema,
    outputSchema: storageListOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getUserDatasetsListArgs)),
    annotations: {
        title: 'Get user datasets list',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getUserDatasetsListArgs.parse(args);
        const datasets = await client.datasets().list({
            limit: parsed.limit,
            offset: parsed.offset,
            desc: parsed.desc,
            unnamed: parsed.unnamed,
        });
        const { summary, nextStep } = buildStorageListSummaryNextStep({
            count: datasets.items.length,
            total: datasets.total,
            offset: datasets.offset,
            noun: 'datasets',
            listToolName: HELPER_TOOLS.DATASET_LIST_GET,
            inspectHint: `Use ${HELPER_TOOLS.DATASET_GET} with a datasetId from the list to inspect a dataset.`,
        });
        return buildStorageResponse({
            structuredContent: datasets as unknown as Record<string, unknown>,
            summary,
            nextStep,
        });
    },
} as const);
