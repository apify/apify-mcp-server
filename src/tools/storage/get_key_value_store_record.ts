import type { AudioContent, EmbeddedResource, ImageContent, ResourceLink } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { HELPER_TOOLS } from '../../const.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleKeyValueStoreUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { computeValueBytes, stripQuoteWrappers } from '../../utils/generic.js';
import { respondRaw, respondUserError } from '../../utils/mcp.js';
import { keyValueStoreRecordOutputSchema } from '../structured_output_schemas.js';
import {
    buildBinaryRecordDisposition,
    buildConsoleLinkContent,
    buildStorageResponse,
    normalizeRecordKey,
} from './storage_helpers.js';

const getKeyValueStoreRecordArgs = z.object({
    keyValueStoreId: z.string().min(1).describe('Key-value store ID or username~store-name.'),
    recordKey: z.string().min(1).describe('Key of the record to retrieve.'),
});

/**
 * https://docs.apify.com/api/v2/key-value-store-record-get
 */
export const getKeyValueStoreRecord: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.KEY_VALUE_STORE_RECORD_GET,
    title: 'Get key-value store record',
    description: dedent`
        Get the value stored under a specific key in a key-value store — a single record, not a listing of all keys.
        Use ${HELPER_TOOLS.KEY_VALUE_STORE_KEYS_GET} first if you don't know the key name.
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
        const { args, apifyClient: client, apifyToken } = toolArgs;
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
            return respondUserError(text);
        }
        const apifyConsoleUrl = buildConsoleKeyValueStoreUrl(
            await getConsoleLinkContext(apifyToken, client),
            keyValueStoreId,
        );
        // The SDK already parsed the body by Content-Type (JSON -> object, text/xml -> string, else -> Buffer);
        // branch on the resulting JS type, not on the MIME type.
        const { value, contentType } = record;
        const bytes = computeValueBytes(value);
        const details = [
            contentType ? `contentType=${contentType}` : undefined,
            bytes !== undefined ? `${bytes} bytes` : undefined,
        ].filter(Boolean);
        // Reading a record is terminal — no nextStep.
        const summary = `Read '${recordKey}'${details.length ? ` (${details.join(', ')})` : ''}.`;
        // Binary values can't go in structuredContent as-is (a Buffer serializes to useless
        // {"type":"Buffer",...}); the bytes ride in MCP content blocks. But the tool declares an
        // outputSchema, and the official SDK client rejects any result that has a schema but no
        // structuredContent — so emit a minimal schema-conforming descriptor alongside the block.
        // The Console link (Console UI token sessions) rides as a trailing text block.
        if (Buffer.isBuffer(value)) {
            // Normalizes the MIME type (so the image/audio checks below don't miss `Image/PNG`) and
            // decides inline-vs-link-out at the same MAX_INLINE_BYTES threshold the API-resource proxy uses.
            const disposition = buildBinaryRecordDisposition(contentType, value);
            const { mimeType } = disposition;
            const structuredContent = {
                keyValueStoreId,
                key: record.key,
                value: `<binary ${mimeType ?? 'application/octet-stream'}, ${value.length} bytes>`,
                ...(contentType && { contentType }),
                summary,
            };
            const consoleLinkContent = buildConsoleLinkContent(apifyConsoleUrl);
            if (disposition.kind === 'linkOut') {
                // base64-inlining a large binary would blow up the context window; return a link instead.
                const uri = await store.getRecordPublicUrl(recordKey);
                return respondRaw({
                    structuredContent,
                    content: [
                        {
                            type: 'resource_link',
                            uri,
                            name: recordKey,
                            size: disposition.bytes,
                            ...(mimeType && { mimeType }),
                        } satisfies ResourceLink,
                        ...consoleLinkContent,
                    ],
                });
            }
            const data = disposition.base64;
            if (mimeType?.startsWith('image/')) {
                return respondRaw({
                    structuredContent,
                    content: [{ type: 'image', data, mimeType } satisfies ImageContent, ...consoleLinkContent],
                });
            }
            if (mimeType?.startsWith('audio/')) {
                return respondRaw({
                    structuredContent,
                    content: [{ type: 'audio', data, mimeType } satisfies AudioContent, ...consoleLinkContent],
                });
            }
            // The blob is inlined, so the uri is just an identifier — build it from the store's API
            // URL instead of getRecordPublicUrl, which fetches store metadata to sign a link nobody follows.
            const uri = `${store.url}/records/${recordKey}`;
            return respondRaw({
                structuredContent,
                content: [
                    {
                        type: 'resource',
                        resource: { uri, blob: data, ...(mimeType && { mimeType }) },
                    } satisfies EmbeddedResource,
                    ...consoleLinkContent,
                ],
            });
        }
        // Text/JSON values serialize cleanly — return them as structuredContent per the storage-tool contract.
        // apify-client maps an empty record body to `undefined`, which drops the schema-required `value` on
        // serialization; emit empty text instead (an empty OUTPUT is legitimate).
        return buildStorageResponse({
            structuredContent: { keyValueStoreId, ...record, value: value === undefined ? '' : value },
            summary,
            apifyConsoleUrl,
        });
    },
} as const);
