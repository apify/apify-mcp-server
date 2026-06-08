import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { keyValueStoreOutputSchema } from '../structured_output_schemas.js';
import { buildStorageNotFound, buildStorageResponse } from './storage_helpers.js';

const getKeyValueStoreArgs = z.object({
    keyValueStoreId: z.string().min(1).describe('Key-value store ID or username~store-name'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-get
 */
export const getKeyValueStore: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HelperTools.KEY_VALUE_STORE_GET,
    description: dedent`
        Get details about a key-value store by ID or username~store-name.
        The results will include store metadata (ID, name, owner, access settings) and usage statistics.

        USAGE:
        - Use when you need to inspect a store to locate records or understand its properties.

        USAGE EXAMPLES:
        - user_input: Show info for key-value store username~my-store
        - user_input: Get details for store adb123`,
    inputSchema: z.toJSONSchema(getKeyValueStoreArgs) as ToolInputSchema,
    outputSchema: keyValueStoreOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(getKeyValueStoreArgs)),
    paymentRequired: true,
    annotations: {
        title: 'Get key-value store',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyClient: client } = toolArgs;
        const parsed = getKeyValueStoreArgs.parse(args);
        const keyValueStoreId = stripQuoteWrappers(parsed.keyValueStoreId);
        const kvStore = await client.keyValueStore(keyValueStoreId).get();
        if (!kvStore) {
            return buildStorageNotFound(`Key-value store '${keyValueStoreId}' not found.`);
        }
        const bytes = (kvStore.stats as { storageBytes?: number } | undefined)?.storageBytes;
        const summary = `Key-value store '${kvStore.name ?? keyValueStoreId}'${bytes !== undefined ? ` holds ${bytes} bytes` : ''}.`;
        const nextStep = `Use ${HelperTools.KEY_VALUE_STORE_KEYS_GET} with keyValueStoreId=${keyValueStoreId} to list keys.`;
        return buildStorageResponse({
            structuredContent: kvStore as unknown as Record<string, unknown>,
            summary,
            nextStep,
        });
    },
} as const);
