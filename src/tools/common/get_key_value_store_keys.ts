import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';

const getKeyValueStoreKeysArgs = z.object({
    storeId: z.string()
        .min(1)
        .describe('Key-value store ID or username~store-name'),
    exclusiveStartKey: z.string()
        .optional()
        .describe('All keys up to this one (including) are skipped from the result.'),
    limit: z.number()
        .max(10)
        .optional()
        .describe('Number of keys to be returned. Maximum value is 1000.'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-keys-get
 */
export const getKeyValueStoreKeys: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.KEY_VALUE_STORE_KEYS_GET,
    description: `List keys in a key-value store with optional pagination.
The results will include keys and basic info about stored values (e.g., size).
Use exclusiveStartKey and limit to paginate.

USAGE:
- Use when you need to discover what records exist in a store.

USAGE EXAMPLES:
- user_input: List first 100 keys in store username~my-store
- user_input: Continue listing keys in store a123 from key data.json`,
    inputSchema: z.toJSONSchema(getKeyValueStoreKeysArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getKeyValueStoreKeysArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get key-value store keys',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getKeyValueStoreKeysArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const keys = await client.keyValueStore(parsed.storeId).listKeys({
            exclusiveStartKey: parsed.exclusiveStartKey,
            limit: parsed.limit,
        });
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(keys)}\n\`\`\`` }] };
    },
} as const);
