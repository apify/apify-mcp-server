import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';

const getKeyValueStoreArgs = z.object({
    storeId: z.string()
        .min(1)
        .describe('Key-value store ID or username~store-name'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-get
 */
export const getKeyValueStore: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.KEY_VALUE_STORE_GET,
    description: `Get details about a key-value store by ID or username~store-name.
The results will include store metadata (ID, name, owner, access settings) and usage statistics.

USAGE:
- Use when you need to inspect a store to locate records or understand its properties.

USAGE EXAMPLES:
- user_input: Show info for key-value store username~my-store
- user_input: Get details for store adb123`,
    inputSchema: z.toJSONSchema(getKeyValueStoreArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getKeyValueStoreArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get key-value store',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getKeyValueStoreArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const store = await client.keyValueStore(parsed.storeId).get();
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(store)}\n\`\`\`` }] };
    },
} as const);
