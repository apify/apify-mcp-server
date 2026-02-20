import { z } from 'zod';

import { createApifyClientWithSkyfireSupport } from '../../apify-client.js';
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
