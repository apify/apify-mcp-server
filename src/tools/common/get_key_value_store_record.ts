import type { AudioContent, EmbeddedResource, ImageContent, ResourceLink } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { HelperTools, KV_RECORD_MAX_INLINE_BYTES } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { wrapJsonText } from '../../utils/encode_text.js';
import { stripQuoteWrappers } from '../../utils/generic.js';
import { buildStorageNotFound, normalizeRecordKey } from './storage_helpers.js';

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
        // The SDK already parsed the body by Content-Type (JSON -> object, text/xml -> string, else -> Buffer);
        // branch on the resulting JS type, not on the MIME type.
        const { value, contentType } = record;
        // Content-Type is case-insensitive; lowercase so the image/audio checks below don't miss `Image/PNG`.
        const mimeType = contentType?.split(';')[0].trim().toLowerCase();
        if (Buffer.isBuffer(value)) {
            if (value.length > KV_RECORD_MAX_INLINE_BYTES) {
                // base64-inlining a large binary would blow up the context window; return a link instead.
                const uri = await store.getRecordPublicUrl(recordKey);
                return {
                    content: [
                        {
                            type: 'resource_link',
                            uri,
                            name: recordKey,
                            size: value.length,
                            ...(mimeType && { mimeType }),
                        } satisfies ResourceLink,
                    ],
                };
            }
            const data = value.toString('base64');
            if (mimeType?.startsWith('image/')) {
                return { content: [{ type: 'image', data, mimeType } satisfies ImageContent] };
            }
            if (mimeType?.startsWith('audio/')) {
                return { content: [{ type: 'audio', data, mimeType } satisfies AudioContent] };
            }
            const uri = await store.getRecordPublicUrl(recordKey);
            return {
                content: [
                    {
                        type: 'resource',
                        resource: { uri, blob: data, ...(mimeType && { mimeType }) },
                    } satisfies EmbeddedResource,
                ],
            };
        }
        if (typeof value === 'string') {
            return { content: [{ type: 'text', text: value }] };
        }
        return { content: [{ type: 'text', text: wrapJsonText(value) }] };
    },
} as const);
