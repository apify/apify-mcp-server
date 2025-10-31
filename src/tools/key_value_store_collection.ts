import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalToolArgs, McpInputSchema, ToolEntry } from '../types.js';
import { ajv } from '../utils/ajv.js';

const getUserKeyValueStoresListArgs = z.object({
    offset: z.number()
        .describe('Number of array elements that should be skipped at the start. The default is 0.')
        .default(0),
    limit: z.number()
        .max(10)
        .describe('Maximum number of array elements to return. The default value (and maximum) is 10.')
        .default(10),
    desc: z.boolean()
        .describe('If true or 1 then the stores are sorted by the createdAt field in descending order. Default: sorted in ascending order.')
        .default(false),
    unnamed: z.boolean()
        .describe('If true or 1 then all the stores are returned. By default, only named key-value stores are returned.')
        .default(false),
});

/**
 * https://docs.apify.com/api/v2/key-value-stores-get
 */
export const getUserKeyValueStoresList: ToolEntry = {
    type: 'internal',
    name: HelperTools.KEY_VALUE_STORE_LIST_GET,
    description: `List key-value stores owned by the authenticated user.
Actor runs automatically produce unnamed stores (set unnamed=true to include them). Users can also create named stores.

The results will include basic info for each store, sorted by createdAt (ascending by default).
Use limit, offset, and desc to paginate and sort.

USAGE:
- Use when you need to browse available key-value stores (named or unnamed).

USAGE EXAMPLES:
- user_input: List my last 10 key-value stores (newest first)
- user_input: List unnamed key-value stores`,
    inputSchema: zodToJsonSchema(getUserKeyValueStoresListArgs) as McpInputSchema,
    ajvValidate: ajv.compile(zodToJsonSchema(getUserKeyValueStoresListArgs)),
    call: async (toolArgs: InternalToolArgs) => {
        const { args, apifyToken } = toolArgs;
        const parsed = getUserKeyValueStoresListArgs.parse(args);
        const client = new ApifyClient({ token: apifyToken });
        const stores = await client.keyValueStores().list({
            limit: parsed.limit,
            offset: parsed.offset,
            desc: parsed.desc,
            unnamed: parsed.unnamed,
        });
        return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(stores)}\n\`\`\`` }] };
    },
} as const;
