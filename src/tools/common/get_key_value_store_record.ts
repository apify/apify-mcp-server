import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify_client.js';
import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';

const getKeyValueStoreRecordArgs = z.object({
    storeId: z.string()
        .min(1)
        .describe('Key-value store ID or username~store-name'),
    recordKey: z.string()
        .min(1)
        .describe('Key of the record to retrieve.'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-record-get
 */
export const getKeyValueStoreRecord: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.KEY_VALUE_STORE_RECORD_GET,
    description: `Get a value stored in a key-value store under a specific key.
The response preserves the original Content-Encoding; most clients handle decompression automatically.

USAGE:
- Use when you need to retrieve a specific record (JSON, text, or binary) from a store.

USAGE EXAMPLES:
- user_input: Get record INPUT from store abc123
- user_input: Get record data.json from store username~my-store`,
    inputSchema: z.toJSONSchema(getKeyValueStoreRecordArgs) as ToolInputSchema,
    /**
     * Allow additional properties for Skyfire mode to pass `skyfire-pay-id`.
     */
    ajvValidate: compileSchema({ ...z.toJSONSchema(getKeyValueStoreRecordArgs), additionalProperties: true }),
    requiresSkyfirePayId: true,
    annotations: {
        title: 'Get key-value store record',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken, apifyMcpServer } = toolArgs;
        const parsed = getKeyValueStoreRecordArgs.parse(args);

        const client = createApifyClientWithSkyfireSupport(apifyMcpServer, args, apifyToken);
        const record = await client.keyValueStore(parsed.storeId).getRecord(parsed.recordKey);
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(record)}\n\`\`\`` }] };
    },
} as const);
