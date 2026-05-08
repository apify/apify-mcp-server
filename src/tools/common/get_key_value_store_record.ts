import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildInvalidInputResponse } from '../../utils/mcp.js';
import { resolveRunDefaultStorage } from './run_storage.js';

const getKeyValueStoreRecordArgs = z.object({
    runId: z.string()
        .min(1)
        .optional()
        .describe('Actor run ID. Server resolves the run\'s default key-value store. Provide exactly one of runId or storeId.'),
    storeId: z.string()
        .min(1)
        .optional()
        .describe('Key-value store ID or username~store-name. Provide exactly one of runId or storeId.'),
    recordKey: z.string()
        .min(1)
        .describe('Key of the record to retrieve.'),
}).refine(
    (data) => (data.runId !== undefined) !== (data.storeId !== undefined),
    { message: 'Provide exactly one of runId or storeId.' },
);

// `.refine()` is not encoded in z.toJSONSchema(); add `oneOf` so AJV and MCP clients enforce the XOR.
const getKeyValueStoreRecordJSONSchema = {
    ...z.toJSONSchema(getKeyValueStoreRecordArgs),
    oneOf: [{ required: ['runId'] }, { required: ['storeId'] }],
};

/**
 * https://docs.apify.com/api/v2/key-value-store-record-get
 */
export const getKeyValueStoreRecord: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.KEY_VALUE_STORE_RECORD_GET,
    description: `Get a value stored in a key-value store under a specific key.
Provide exactly one of runId or storeId; runId resolves to the run's default key-value store.
The response preserves the original Content-Encoding; most clients handle decompression automatically.

USAGE:
- Use when you need to retrieve a specific record (JSON, text, or binary) from a store or an Actor run's key-value store.

USAGE EXAMPLES:
- user_input: Get the INPUT record from run y2h7sK3Wc
- user_input: Get record INPUT from store abc123
- user_input: Get record data.json from store username~my-store`,
    inputSchema: getKeyValueStoreRecordJSONSchema as ToolInputSchema,
    ajvValidate: compileSchema(getKeyValueStoreRecordJSONSchema),
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
        const parseResult = getKeyValueStoreRecordArgs.safeParse(args);
        if (!parseResult.success) {
            const reason = parseResult.error.issues.map((i) => i.message).join('; ');
            return buildInvalidInputResponse(HelperTools.KEY_VALUE_STORE_RECORD_GET, reason);
        }
        const parsed = parseResult.data;

        let storeId: string;
        if (parsed.runId) {
            const resolved = await resolveRunDefaultStorage(client, parsed.runId, 'keyValueStore');
            if ('error' in resolved) return resolved.error;
            storeId = resolved.id;
        } else {
            // Refine guarantees storeId is set when runId is not.
            storeId = parsed.storeId as string;
        }

        const record = await client.keyValueStore(storeId).getRecord(parsed.recordKey);
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(record)}\n\`\`\`` }] };
    },
} as const);
