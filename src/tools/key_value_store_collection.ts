import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ApifyClient } from '../apify-client.js';
import { HelperTools } from '../const.js';
import type { InternalTool, ToolEntry } from '../types.js';
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
    tool: {
        name: HelperTools.KEY_VALUE_STORE_LIST_GET,
        actorFullName: HelperTools.KEY_VALUE_STORE_LIST_GET,
        description: 'Lists key-value stores owned by the user. '
            + 'Actor runs automatically produce unnamed stores (use unnamed=true to include these). '
            + 'Users can also create named stores manually. '
            + 'Each store includes basic information about the store. '
            + 'Results are sorted by createdAt in ascending order (use desc=true for descending). '
            + 'Supports pagination with limit (max 1000) and offset parameters.',
        inputSchema: zodToJsonSchema(getUserKeyValueStoresListArgs),
        ajvValidate: ajv.compile(zodToJsonSchema(getUserKeyValueStoresListArgs)),
        call: async (toolArgs) => {
            const { args, apifyToken } = toolArgs;
            const parsed = getUserKeyValueStoresListArgs.parse(args);
            const client = new ApifyClient({ token: apifyToken });
            const stores = await client.keyValueStores().list({
                limit: parsed.limit,
                offset: parsed.offset,
                desc: parsed.desc,
                unnamed: parsed.unnamed,
            });
            return { content: [{ type: 'text', text: JSON.stringify(stores) }] };
        },
    } as InternalTool,
};
