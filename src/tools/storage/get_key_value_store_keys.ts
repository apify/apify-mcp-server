import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS, HTTP_NOT_FOUND } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleKeyValueStoreUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { getHttpStatusCode } from '../../utils/logging.js';
import { respondUserError } from '../../utils/mcp.js';
import { keyValueStoreKeysOutputSchema } from '../structured_output_schemas.js';
import { buildKvsKeysSummaryNextStep, buildStorageResponse } from './storage_helpers.js';

const getKeyValueStoreKeysArgs = z.object({
    keyValueStoreId: z.string().min(1).describe('Key-value store ID or username~store-name'),
    exclusiveStartKey: z
        .string()
        .optional()
        .describe('All keys up to this one (including) are skipped from the result.'),
    limit: z.number().max(10).optional().describe('Number of keys to be returned. Maximum value is 10.'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-keys-get
 */
export const getKeyValueStoreKeys: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET,
    title: 'Get key-value store keys',
    description: dedent`
        List keys in a key-value store with optional pagination.
        The results will include keys and basic info about stored values (e.g., size).
        Use exclusiveStartKey and limit to paginate.

        USAGE:
        - Use when you need to discover what records exist in a store.

        USAGE EXAMPLES:
        - user_input: List first 10 keys in store username~my-store
        - user_input: Continue listing keys in store a123 from key data.json`,
    inputSchema: z.toJSONSchema(getKeyValueStoreKeysArgs) as ToolInputSchema,
    outputSchema: keyValueStoreKeysOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getKeyValueStoreKeysArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get key-value store keys',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client, apifyToken } = toolArgs;
        const parsed = getKeyValueStoreKeysArgs.parse(args);
        const keyValueStoreId = stripQuoteWrappers(parsed.keyValueStoreId);
        // `listKeys()` throws ApifyApiError on a missing store (the SDK only soft-catches
        // 404 on `.get()` / `.getRecord()`), so translate 404 into a soft-fail.
        const keys = await client
            .keyValueStore(keyValueStoreId)
            .listKeys({ exclusiveStartKey: parsed.exclusiveStartKey, limit: parsed.limit })
            .catch((err: unknown) => {
                if (getHttpStatusCode(err) === HTTP_NOT_FOUND) {
                    return null;
                }
                throw err;
            });
        if (!keys) {
            return respondUserError(`Key-value store '${keyValueStoreId}' not found.`);
        }
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const { summary, nextStep } = buildKvsKeysSummaryNextStep({
            keyValueStoreId,
            count: keys.items.length,
            isTruncated: keys.isTruncated,
            nextExclusiveStartKey: keys.nextExclusiveStartKey,
            firstKey: keys.items[0]?.key,
        });
        return buildStorageResponse({
            structuredContent: { keyValueStoreId, ...keys },
            summary,
            nextStep,
            toon: true,
            apifyConsoleUrl: buildConsoleKeyValueStoreUrl(linkContext, keyValueStoreId),
        });
    },
} as const);
