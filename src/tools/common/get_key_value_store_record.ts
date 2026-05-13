import { z } from 'zod';

import { HelperTools, TOOL_STATUS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildMCPResponse } from '../../utils/mcp.js';

const getKeyValueStoreRecordArgs = z.object({
    keyValueStoreId: z.string()
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
    ajvValidate: compileSchema(z.toJSONSchema(getKeyValueStoreRecordArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get key-value store record',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getKeyValueStoreRecordArgs.parse(args);
        const store = client.keyValueStore(parsed.keyValueStoreId);
        const record = await store.getRecord(parsed.recordKey);
        if (record === undefined) {
            // getRecord returns undefined for both missing-store and missing-key; disambiguate.
            const storeInfo = await store.get();
            const text = storeInfo
                ? `Record '${parsed.recordKey}' not found in key-value store '${parsed.keyValueStoreId}'.`
                : `Key-value store '${parsed.keyValueStoreId}' not found.`;
            return buildMCPResponse({
                texts: [text],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL },
            });
        }
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(record)}\n\`\`\`` }] };
    },
} as const);
