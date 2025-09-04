import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';

const getKeyValueStoreArgs = z.object({
    storeId: z.string()
        .min(1)
        .describe('Key-value store ID or username~store-name'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-get
 */
export const getKeyValueStore: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.KEY_VALUE_STORE_GET,
        actorFullName: HelperTools.KEY_VALUE_STORE_GET,
        description: 'Gets an object that contains all the details about a specific key-value store. '
            + 'Returns store metadata including ID, name, owner, access settings, and usage statistics. '
            + 'Use store ID or username~store-name format to identify the store.',
        inputSchema: zodToJsonSchema(getKeyValueStoreArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getKeyValueStoreArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getKeyValueStoreArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const store = await client.keyValueStore(parsed.storeId).get();
            return { content: [{ type: 'text', text: JSON.stringify(store) }] };
        },
    } as InternalTool,
};

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
export const getKeyValueStoreKeys: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.KEY_VALUE_STORE_KEYS_GET,
        actorFullName: HelperTools.KEY_VALUE_STORE_KEYS_GET,
        description: 'Returns a list of objects describing keys of a given key-value store, '
            + 'as well as some information about the values (e.g. size). '
            + 'Supports pagination using exclusiveStartKey and limit parameters. '
            + 'Use store ID or username~store-name format to identify the store.',
        inputSchema: zodToJsonSchema(getKeyValueStoreKeysArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getKeyValueStoreKeysArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getKeyValueStoreKeysArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const keys = await client.keyValueStore(parsed.storeId).listKeys({
                exclusiveStartKey: parsed.exclusiveStartKey,
                limit: parsed.limit,
            });
            return { content: [{ type: 'text', text: JSON.stringify(keys) }] };
        },
    } as InternalTool,
};

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
export const getKeyValueStoreRecord: ToolEntry = {
    type: 'internal',
    tool: {
        name: HelperTools.KEY_VALUE_STORE_RECORD_GET,
        actorFullName: HelperTools.KEY_VALUE_STORE_RECORD_GET,
        description: 'Gets a value stored in the key-value store under a specific key. '
            + 'The response maintains the original Content-Encoding of the stored value. '
            + 'If the request does not specify the correct Accept-Encoding header, the record will be decompressed. '
            + 'Most HTTP clients handle decompression automatically.'
            + 'The record can be accessed with the URL: GET: https://api.apify.com/v2/key-value-stores/:storeId/records/:recordKey',
        inputSchema: zodToJsonSchema(getKeyValueStoreRecordArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getKeyValueStoreRecordArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getKeyValueStoreRecordArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const record = await client.keyValueStore(parsed.storeId).getRecord(parsed.recordKey);
            return { content: [{ type: 'text', text: JSON.stringify(record) }] };
        },
    } as InternalTool,
};
