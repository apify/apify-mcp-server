import type { AudioContent, EmbeddedResource, ImageContent, ResourceLink } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import { z } from 'zod';

import { getApifyAPIPublicBaseUrl } from '../../apify_client.js';
import {
    HELPER_TOOLS,
    KEY_VALUE_STORE_KEY_MAX_LENGTH,
    MAX_INLINE_BYTES,
    RESOURCE_ID_OR_NAME_MAX_LENGTH,
} from '../../const.js';
import { buildUrlOnOrigin } from '../../resources/api_resources.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { buildConsoleKeyValueStoreUrl, getConsoleLinkContext } from '../../utils/console_link.js';
import { computeValueBytes, stripQuoteWrappers } from '../../utils/generic.js';
import { respondRaw, respondUserError } from '../../utils/mcp.js';
import { keyValueStoreRecordOutputSchema } from '../structured_output_schemas.js';
import {
    buildConsoleLinkContent,
    buildStorageResponse,
    fetchRecordUnderCap,
    fetchStorageByIdOrName,
    normalizeRecordKey,
    parseBaseMimeType,
    resolveStorageId,
    storageIdArgDescription,
    storageNotFoundText,
} from './storage_helpers.js';

const getKeyValueStoreRecordArgs = z.object({
    keyValueStoreId: z
        .string()
        .min(1)
        .max(RESOURCE_ID_OR_NAME_MAX_LENGTH)
        .describe(storageIdArgDescription('keyValueStore')),
    recordKey: z.string().min(1).max(KEY_VALUE_STORE_KEY_MAX_LENGTH).describe('Key of the record to retrieve.'),
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
        Requires the exact key name.
        The response preserves the original Content-Encoding; most clients handle decompression automatically.
        A record over ${MAX_INLINE_BYTES} bytes is returned as a link to download it, not as its value.

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
        const found = await fetchStorageByIdOrName(keyValueStoreId, async (safeId) =>
            fetchRecordUnderCap(client, safeId, recordKey),
        );
        if (!found) {
            // The read is undefined for both missing-store and missing-key; disambiguate.
            const storeInfo = await fetchStorageByIdOrName(keyValueStoreId, async (safeId) =>
                client.keyValueStore(safeId).get(),
            );
            const text = storeInfo
                ? `Record '${recordKey}' not found in key-value store '${keyValueStoreId}'.`
                : storageNotFoundText('keyValueStore', keyValueStoreId);
            return respondUserError(text);
        }
        const { result: record, safeId } = found;
        if (!record.isOverLimit && record.isUnparsable) {
            return respondUserError(
                `Record '${recordKey}' is stored as ${record.contentType ?? 'an unknown type'}, but its body is not valid for that type, so its value cannot be returned.`,
            );
        }
        const store = client.keyValueStore(safeId);
        // Shared by the Console link and the public record link, so a name is read back once.
        let storeIdPromise: Promise<string> | undefined;
        const getStoreId = async () =>
            (storeIdPromise ??= resolveStorageId(safeId, async (id) => client.keyValueStore(id).get()));
        const linkContext = await getConsoleLinkContext(apifyToken, client);
        const apifyConsoleUrl = linkContext ? buildConsoleKeyValueStoreUrl(linkContext, await getStoreId()) : undefined;
        const { contentType } = record;
        const mimeType = parseBaseMimeType(contentType);
        const consoleLinkContent = buildConsoleLinkContent(apifyConsoleUrl);
        if (record.isOverLimit) {
            // The download stopped at the limit, whatever the type: a record that large would blow up the
            // context window, and holding it whole the server's memory. Return a link instead.
            const summary = `Record '${recordKey}'${contentType ? ` (contentType=${contentType})` : ''} is over the ${MAX_INLINE_BYTES}-byte limit, so a link to it is returned instead of its value.`;
            // The link is opened without a token, so it addresses the store by ID, not by `~name`.
            const uri = await client.keyValueStore(await getStoreId()).getRecordPublicUrl(recordKey);
            return respondRaw({
                structuredContent: {
                    keyValueStoreId,
                    key: recordKey,
                    value: `<${mimeType ?? 'application/octet-stream'}, over ${MAX_INLINE_BYTES} bytes>`,
                    ...(contentType && { contentType }),
                    summary,
                },
                content: [
                    {
                        type: 'resource_link',
                        uri,
                        name: recordKey,
                        ...(mimeType && { mimeType }),
                    } satisfies ResourceLink,
                    ...consoleLinkContent,
                ],
            });
        }
        // The body was parsed by Content-Type (JSON -> object, text/xml -> string, else -> Buffer);
        // branch on the resulting JS type, not on the MIME type.
        const { value } = record;
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
            const structuredContent = {
                keyValueStoreId,
                key: recordKey,
                value: `<binary ${mimeType ?? 'application/octet-stream'}, ${value.length} bytes>`,
                ...(contentType && { contentType }),
                summary,
            };
            const data = value.toString('base64');
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
            // `store.url` is on the egress origin; clients get the client-facing one.
            const uri = `${buildUrlOnOrigin(store.url, getApifyAPIPublicBaseUrl())}/records/${recordKey}`;
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
            structuredContent: {
                keyValueStoreId,
                key: recordKey,
                value: value === undefined ? '' : value,
                ...(contentType && { contentType }),
            },
            summary,
            apifyConsoleUrl,
        });
    },
} as const);
