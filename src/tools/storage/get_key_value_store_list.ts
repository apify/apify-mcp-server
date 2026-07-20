import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { storageListOutputSchema } from '../structured_output_schemas.js';
import { buildStorageListSummaryNextStep, buildStorageResponse } from './storage_helpers.js';

const getUserKeyValueStoresListArgs = z.object({
    offset: z
        .number()
        .describe('Number of array elements that should be skipped at the start. Default is 0.')
        .default(0),
    limit: z
        .number()
        .max(10)
        .describe('Maximum number of array elements to return. Default is 10. Maximum is 10.')
        .default(10),
    desc: z
        .boolean()
        .describe(
            'If true or 1 then the stores are sorted by the createdAt field in descending order. Default is false (ascending order).',
        )
        .default(false),
    unnamed: z
        .boolean()
        .describe('If true or 1 then all the stores are returned. Default is false (named key-value stores only).')
        .default(false),
});

/**
 * https://docs.apify.com/api/v2/key-value-stores-get
 */
export const getKeyValueStoreList: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
    title: 'Get user key-value stores list',
    description: dedent`
        List the key-value stores owned by the authenticated user — flexible storage for unstructured data or files.
        Returns summaries only, not their contents — use ${HELPER_TOOLS.KEY_VALUE_STORE_GET} to inspect one from the list.
        Actor runs automatically produce unnamed stores (set unnamed=true to include them); users can also create named stores.
        Sorted by createdAt (ascending by default); use limit, offset, and desc to paginate and sort.

        USAGE:
        - Use when you need to browse available key-value stores (named or unnamed).

        USAGE EXAMPLES:
        - user_input: List my last 10 key-value stores (newest first)
        - user_input: List unnamed key-value stores`,
    inputSchema: z.toJSONSchema(getUserKeyValueStoresListArgs) as ToolInputSchema,
    outputSchema: storageListOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getUserKeyValueStoresListArgs)),
    annotations: {
        title: 'Get user key-value stores list',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getUserKeyValueStoresListArgs.parse(args);
        const stores = await client.keyValueStores().list({
            limit: parsed.limit,
            offset: parsed.offset,
            desc: parsed.desc,
            unnamed: parsed.unnamed,
        });
        const { summary, nextStep } = buildStorageListSummaryNextStep({
            count: stores.items.length,
            total: stores.total,
            offset: stores.offset,
            noun: 'key-value stores',
            listToolName: HELPER_TOOLS.KEY_VALUE_STORE_LIST_GET,
            inspectHint: `Use ${HELPER_TOOLS.KEY_VALUE_STORE_GET} with a keyValueStoreId from the list to inspect a store.`,
        });
        return buildStorageResponse({
            structuredContent: stores as unknown as Record<string, unknown>,
            summary,
            nextStep,
        });
    },
} as const);
