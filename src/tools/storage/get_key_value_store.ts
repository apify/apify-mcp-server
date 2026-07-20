import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleKeyValueStoreUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { respondUserError } from '../../utils/mcp.js';
import { keyValueStoreOutputSchema } from '../structured_output_schemas.js';
import { buildStorageResponse } from './storage_helpers.js';

const getKeyValueStoreArgs = z.object({
    keyValueStoreId: z.string().min(1).describe('Key-value store ID or username~store-name.'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-get
 */
export const getKeyValueStore: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.KEY_VALUE_STORE_GET,
    title: 'Get key-value store',
    description: dedent`
        Get metadata for a key-value store — a flexible store for unstructured data or files.
        Returns store details and usage stats, not its records — use ${HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET} to list what it holds.

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
        const { args, apifyClient: client, apifyToken } = toolArgs;
        const parsed = getKeyValueStoreArgs.parse(args);
        const keyValueStoreId = stripQuoteWrappers(parsed.keyValueStoreId);
        const kvStore = await client.keyValueStore(keyValueStoreId).get();
        if (!kvStore) {
            return respondUserError(`Key-value store '${keyValueStoreId}' not found.`);
        }
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const bytes = (kvStore.stats as { storageBytes?: number } | undefined)?.storageBytes;
        const summary = `Key-value store '${kvStore.name ?? keyValueStoreId}'${bytes !== undefined ? ` holds ${bytes} bytes` : ''}.`;
        const nextStep = `Use ${HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET} with keyValueStoreId=${keyValueStoreId} to list keys.`;
        return buildStorageResponse({
            structuredContent: kvStore as unknown as Record<string, unknown>,
            summary,
            nextStep,
            apifyConsoleUrl: buildConsoleKeyValueStoreUrl(linkContext, kvStore.id),
        });
    },
} as const);
