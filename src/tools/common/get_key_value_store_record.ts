import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { computeValueBytes, stripQuoteWrappers } from '../../utils/generic.js';
import { keyValueStoreRecordOutputSchema } from '../structured_output_schemas.js';
import { buildStorageNotFound, buildStorageResponse, normalizeRecordKey } from './storage_helpers.js';

const getKeyValueStoreRecordArgs = z.object({
    keyValueStoreId: z.string().min(1).describe('Key-value store ID or username~store-name'),
    recordKey: z.string().min(1).describe('Key of the record to retrieve.'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-record-get
 */
export const getKeyValueStoreRecord: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.KEY_VALUE_STORE_RECORD_GET,
    description: dedent`
        Get a value stored in a key-value store under a specific key.
        The response preserves the original Content-Encoding; most clients handle decompression automatically.

        USAGE:
        - Use when you need to retrieve a specific record (JSON, text, or binary) from a store.

        USAGE EXAMPLES:
        - user_input: Get record INPUT from store abc123
        - user_input: Get record data.json from store username~my-store`,
    inputSchema: z.toJSONSchema(getKeyValueStoreRecordArgs) as ToolInputSchema,
    outputSchema: keyValueStoreRecordOutputSchema,
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
        const keyValueStoreId = stripQuoteWrappers(parsed.keyValueStoreId);
        const recordKey = normalizeRecordKey(parsed.recordKey);
        const store = client.keyValueStore(keyValueStoreId);
        const record = await store.getRecord(recordKey);
        if (record === undefined) {
            // getRecord returns undefined for both missing-store and missing-key; disambiguate.
            const storeInfo = await store.get();
            const text = storeInfo
                ? `Record '${recordKey}' not found in key-value store '${keyValueStoreId}'.`
                : `Key-value store '${keyValueStoreId}' not found.`;
            return buildStorageNotFound(text);
        }
        const bytes = computeValueBytes(record.value);
        const details = [
            record.contentType ? `contentType=${record.contentType}` : undefined,
            bytes !== undefined ? `${bytes} bytes` : undefined,
        ].filter(Boolean);
        const summary = `Read '${recordKey}'${details.length ? ` (${details.join(', ')})` : ''}.`;
        // Reading a record is terminal — no nextStep.
        return buildStorageResponse({ structuredContent: { keyValueStoreId, ...record }, summary });
    },
} as const);
