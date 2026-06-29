/**
 * Shared JSON schema definitions for structured output across tools.
 * These schemas define the format of structured data returned by various tools.
 */

/**
 * Schema for developer information
 */
const developerSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        username: { type: 'string', description: 'Developer username' },
        isOfficialApify: { type: 'boolean', description: 'Whether the actor is developed by Apify' },
        url: { type: 'string', description: 'Developer profile URL' },
    },
    required: ['username', 'isOfficialApify', 'url'],
};

/**
 * Schema for tiered pricing within an event
 */
const eventTieredPricingSchema = {
    type: 'array' as const, // Literal type required for MCP SDK type compatibility
    items: {
        type: 'object' as const, // Literal type required for MCP SDK type compatibility
        properties: {
            tier: { type: 'string' },
            priceUsd: { type: 'number' },
        },
    },
};

/**
 * Schema for pricing events (PAY_PER_EVENT model)
 */
const pricingEventsSchema = {
    type: 'array' as const, // Literal type required for MCP SDK type compatibility
    items: {
        type: 'object' as const, // Literal type required for MCP SDK type compatibility
        properties: {
            title: { type: 'string', description: 'Event title' },
            description: { type: 'string', description: 'Event description' },
            priceUsd: { type: 'number', description: 'Price in USD' },
            tieredPricing: eventTieredPricingSchema,
        },
    },
    description: 'Event-based pricing information',
};

/**
 * Schema for tiered pricing (general)
 */
const tieredPricingSchema = {
    type: 'array' as const, // Literal type required for MCP SDK type compatibility
    items: {
        type: 'object' as const, // Literal type required for MCP SDK type compatibility
        properties: {
            tier: { type: 'string', description: 'Tier name' },
            pricePerUnit: { type: 'number', description: 'Price per unit for this tier' },
        },
    },
    description: 'Tiered pricing information',
};

/**
 * Schema for pricing information
 */
export const pricingSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        model: {
            type: 'string',
            description: 'Pricing model (FREE, PRICE_PER_DATASET_ITEM, FLAT_PRICE_PER_MONTH, PAY_PER_EVENT)',
        },
        userTier: {
            type: 'string',
            enum: ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'],
            description:
                "The user's plan tier used to resolve pricing (always the user's tier, even if a different tier was used as fallback)",
        },
        pricePerUnit: { type: 'number', description: 'Price per unit (for non-free models)' },
        unitName: { type: 'string', description: 'Unit name for pricing' },
        trialMinutes: { type: 'number', description: 'Trial period in minutes' },
        tieredPricing: tieredPricingSchema,
        events: pricingEventsSchema,
        pricingNote: {
            type: 'string',
            description:
                'Note naming the resolved tier; only emitted in simplified mode ' +
                'when the actor has multiple tiers and they resolve consistently',
        },
        eventDescriptionsOmitted: {
            type: 'boolean',
            description: 'Whether event descriptions were omitted because the actor has many pricing events',
        },
        eventDescriptionsNote: {
            type: 'string',
            description:
                'Note explaining that event descriptions were omitted and full details are available via fetch-actor-details',
        },
    },
    // `userTier` is optional: `search-actors` returns it once at the response top level
    // (it is a session constant), so per-Actor pricing omits it. `fetch-actor-details`
    // returns a single Actor and keeps `userTier` in the pricing block.
    required: ['model'],
};

/**
 * Schema for Actor statistics
 */
export const statsSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        totalUsers: { type: 'number', description: 'Total users' },
        monthlyUsers: { type: 'number', description: 'Monthly active users' },
        successRate: { type: 'number', description: 'Success rate percentage' },
        bookmarks: { type: 'number', description: 'Number of bookmarks' },
    },
};

/**
 * Schema for Actor information (card)
 * Used in both search results and detailed Actor info
 */
export const actorInfoSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        title: { type: 'string', description: 'Actor title' },
        url: { type: 'string', description: 'Actor URL' },
        id: { type: 'string', description: 'Actor ID' },
        fullName: { type: 'string', description: 'Full Actor name (username/name)' },
        pictureUrl: { type: 'string', description: 'Actor picture URL' },
        developer: developerSchema,
        description: { type: 'string', description: 'Actor description' },
        categories: {
            type: 'array' as const, // Literal type required for MCP SDK type compatibility
            items: { type: 'string' },
            description: 'Actor categories',
        },
        pricing: pricingSchema,
        stats: statsSchema,
        rating: {
            type: 'object' as const, // Literal type required for MCP SDK type compatibility
            properties: {
                average: { type: 'number', description: 'Average rating' },
                count: { type: 'number', description: 'Number of ratings' },
            },
        },
        modifiedAt: { type: 'string', description: 'Last modification date' },
        isDeprecated: { type: 'boolean', description: 'Whether the Actor is deprecated' },
        // Mirrors `ActorStoreInputSchema` in src/types.ts; only `type` is preserved per
        // field by apify-core's `trimInputSchema`, so the per-field shape stays minimal.
        inputFields: {
            type: 'object' as const, // Literal type required for MCP SDK type compatibility
            description:
                'Compact JSON-Schema-shaped descriptor of the Actor input; only `type` is preserved per field.',
            properties: {
                type: { type: 'string', description: 'Always `"object"`.' },
                properties: {
                    type: 'object' as const, // Literal type required for MCP SDK type compatibility
                    description: 'Map of input field name to its type descriptor.',
                    additionalProperties: {
                        type: 'object' as const, // Literal type required for MCP SDK type compatibility
                        properties: {
                            type: { description: 'JSON Schema field type — string or array of strings.' },
                        },
                        required: ['type'],
                    },
                },
                required: {
                    type: 'array' as const, // Literal type required for MCP SDK type compatibility
                    items: { type: 'string' },
                    description: 'Names of required input fields.',
                },
            },
            required: ['type', 'properties'],
        },
        inputFieldsTruncated: {
            type: 'boolean',
            description:
                'Present and `true` when `inputFields` was truncated; fetch the full schema via `fetch-actor-details`.',
        },
        inputFieldsTotalCount: {
            type: 'number',
            description:
                'Total number of input fields before truncation; present only when `inputFields` was truncated.',
        },
    },
    required: ['url', 'id', 'fullName', 'developer', 'description', 'categories', 'isDeprecated'],
};

/**
 * Schema for Actor details output (fetch-actor-details tool)
 * All fields are optional since the tool supports selective output via the 'output' parameter
 *
 * NOTE on `readme`: This field contains the abridged README summary when the Actor has one,
 * falling back to the full README otherwise. The field is named `readme` (not `readmeSummary`)
 * to stay consistent with the widget UI contract. Most Actors should have a summary defined,
 * so the full README fallback is only expected in niche cases.
 */
export const actorDetailsOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        actorInfo: actorInfoSchema,
        readme: {
            type: 'string',
            description: 'Actor README summary when available, otherwise the full README documentation.',
        },
        inputSchema: { type: 'object' as const, description: 'Actor input schema.' }, // Literal type required for MCP SDK type compatibility
        outputSchema: { type: 'object' as const, description: 'Output schema inferred from successful runs.' },
        mcpTools: {
            type: 'string',
            description:
                'Markdown listing of MCP tools exposed by the Actor (only present when `output.mcpTools` is requested).',
        },
    },
};

/**
 * Schema for fetch-actor-details-widget output.
 * Widget-only; renders as an interactive UI element in apps mode.
 * `actorInfo` is the widget-shaped actor (from `formatActorForWidget`), kept as a loose
 * object because it doesn't align with `actorInfoSchema` (adds `currentPricingInfo` etc.).
 */
export const actorDetailsWidgetOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        actorDetails: {
            type: 'object' as const, // Literal type required for MCP SDK type compatibility
            properties: {
                actorInfo: {
                    type: 'object' as const,
                    description: 'Widget-formatted Actor info (tier-aware pricing, widget display fields).',
                },
                actorCard: { type: 'string', description: 'Rendered Actor card markdown for widget display.' },
                readme: { type: 'string', description: 'Formatted Actor README for widget display.' },
            },
            required: ['actorInfo', 'actorCard', 'readme'],
            additionalProperties: false,
        },
    },
    required: ['actorDetails'],
    additionalProperties: false,
};

/**
 * Schema for search results output (store-search tool)
 */
export const actorSearchOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        actors: {
            type: 'array' as const, // Literal type required for MCP SDK type compatibility
            items: actorInfoSchema,
            description: 'List of Actor cards matching the search query',
        },
        query: { type: 'string', description: 'The search query used' },
        count: { type: 'number', description: 'Number of Actors returned' },
        userTier: {
            type: 'string',
            enum: ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'],
            description: "The user's plan tier used to resolve the per-Actor pricing shown in the results",
        },
        instructions: {
            type: 'string',
            description: 'Additional instructions for the LLM to follow when processing the search results.',
        },
    },
    required: ['actors', 'query', 'count'],
};

/**
 * Schema for widget search results (search-actors-widget tool).
 * `actors` mirrors the non-widget `actorSearchOutputSchema` shape (StructuredActorCard),
 * `widgetActors` is the widget-formatted list (from `formatActorForWidget`), kept loose
 * for the same reason `actorDetailsWidgetOutputSchema.actorInfo` is loose.
 */
export const actorSearchWidgetOutputSchema = {
    type: 'object' as const,
    properties: {
        actors: {
            type: 'array' as const,
            items: actorInfoSchema,
            description: 'List of Actor cards matching the search query',
        },
        query: { type: 'string', description: 'The search query used' },
        count: { type: 'number', description: 'Number of Actors returned' },
        userTier: {
            type: 'string',
            enum: ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'],
            description: "The user's plan tier used to resolve the per-Actor pricing shown in the results",
        },
        widgetActors: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                description: 'Widget-formatted Actor (tier-aware pricing, widget display fields).',
            },
            description: 'Widget-formatted Actor list for UI rendering',
        },
    },
    required: ['actors', 'query', 'count', 'widgetActors'],
};

export const searchApifyDocsToolOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        results: {
            type: 'array' as const, // Literal type required for MCP SDK type compatibility
            items: {
                type: 'object' as const, // Literal type required for MCP SDK type compatibility
                properties: {
                    url: {
                        type: 'string',
                        description: 'URL of the documentation page, may include anchor (e.g., #section-name).',
                    },
                    content: {
                        type: 'string',
                        description: 'A limited piece of content that matches the search query.',
                    },
                },
                required: ['url'],
            },
        },
        instructions: {
            type: 'string',
            description: 'Additional instructions for the LLM to follow when processing the search results.',
        },
    },
    required: ['results'],
};

export const fetchApifyDocsToolOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        url: { type: 'string', description: 'The documentation URL that was fetched' },
        content: { type: 'string', description: 'The full markdown content of the documentation page' },
    },
    required: ['url', 'content'],
};

// Per-storage entry shapes. Factories (not shared constants) because `structuredClone` preserves
// object identity: if `default` and `additionalProperties` referenced the same object, cloning
// `actorRunOutputSchema` would keep them as the same object, and injecting `itemsSchema` into
// `default` via `buildEnrichedDirectActorOutputSchema` would silently leak it into aliases too.
const buildDatasetEntrySchema = () => ({
    type: 'object' as const,
    properties: {
        id: { type: 'string', description: 'Dataset ID' },
        apifyConsoleUrl: {
            type: 'string',
            description: 'Personalized Apify Console link to the dataset; present only for Console sessions',
        },
        name: { type: 'string' },
        title: { type: 'string' },
        itemCount: { type: 'number' },
        inflatedBytes: {
            type: 'number',
            description:
                'Approximate uncompressed byte size of the dataset. Use with itemCount to pick limit/fields before fetching.',
        },
        fields: {
            type: 'array' as const,
            items: { type: 'string' },
            description: 'Dataset field paths in dot notation (e.g. ["metadata.url"])',
        },
    },
    required: ['id'],
});

const buildKeyValueStoreEntrySchema = () => ({
    type: 'object' as const,
    properties: {
        id: { type: 'string', description: 'Key-value store ID' },
        apifyConsoleUrl: {
            type: 'string',
            description: 'Personalized Apify Console link to the store; present only for Console sessions',
        },
        name: { type: 'string' },
        title: { type: 'string' },
        keyCount: { type: 'number', description: 'Total number of keys (omitted when truncated)' },
        keys: {
            type: 'array' as const,
            items: { type: 'string' },
            description: 'Up to 50 key names',
        },
    },
    required: ['id'],
});

/** Schema for get-actor-run tool output. */
export const actorRunOutputSchema = {
    type: 'object' as const,
    properties: {
        runId: { type: 'string', description: 'Actor run ID' },
        apifyConsoleUrl: {
            type: 'string',
            description: 'Personalized Apify Console link to the run; present only for Console sessions',
        },
        actorId: { type: 'string', description: 'Stable Apify Actor ID from the run record' },
        actorName: { type: 'string', description: '"username/actor-name"' },
        status: {
            type: 'string',
            description:
                'Run status: READY | RUNNING | TIMING-OUT | TIMED-OUT | ABORTING | ABORTED | SUCCEEDED | FAILED',
        },
        statusMessage: { type: 'string', description: 'Pass-through from Apify run.statusMessage' },
        exitCode: {
            type: 'number',
            description: 'Actor process exit code; populated for terminal states (especially FAILED)',
        },
        startedAt: { type: 'string', description: 'ISO timestamp when the run started' },
        finishedAt: { type: 'string', description: 'ISO timestamp when the run finished (terminal states only)' },
        stats: {
            type: 'object' as const,
            description: 'Run statistics',
            properties: {
                runTimeSecs: { type: 'number' },
                computeUnits: { type: 'number' },
                memMaxBytes: { type: 'number' },
            },
        },
        storages: {
            type: 'object' as const,
            // Alias-map shape mirrors ActorRunStorageIds from the Apify client.
            // `datasets.default` / `keyValueStores.default` are the primary entries;
            // named Actor storages (e.g. datasets.results) occupy additional alias keys.
            description: 'Dataset and key-value store metadata, keyed by alias. "default" is always the primary entry.',
            properties: {
                datasets: {
                    type: 'object' as const,
                    description: 'Map of dataset alias → metadata. Key "default" is always the run\'s primary dataset.',
                    properties: {
                        default: buildDatasetEntrySchema(),
                    },
                    additionalProperties: buildDatasetEntrySchema(),
                },
                keyValueStores: {
                    type: 'object' as const,
                    description:
                        'Map of key-value store alias → metadata. Key "default" is always the run\'s primary store.',
                    properties: {
                        default: buildKeyValueStoreEntrySchema(),
                    },
                    additionalProperties: buildKeyValueStoreEntrySchema(),
                },
            },
        },
        summary: { type: 'string', description: 'Past-tense summary of the run state' },
        nextStep: { type: 'string', description: 'One primary follow-up action with identifiers interpolated' },
    },
    required: ['runId', 'actorId', 'status', 'storages', 'summary', 'nextStep'],
};

/**
 * Returns a per-tool clone of {@link actorRunOutputSchema} with `storages.datasets.default.itemsSchema`
 * declared as a JSON Schema describing each dataset row, inferred from historical successful runs.
 *
 * Used for direct actor tools (e.g. `apify--rag-web-browser`) where the target Actor is known
 * at `tools/list` time, so the LLM can plan field projection before calling the tool. The same
 * shape is injected into `structuredContent.storages.datasets.default.itemsSchema` by the direct
 * actor executors so the declared schema matches the runtime response.
 *
 * `call-actor` and `get-actor-run` cannot use this because their target Actor is dynamic.
 *
 * @param itemProperties - JSON Schema properties for dataset item fields
 *   (e.g. `{ url: { type: 'string' }, price: { type: 'number' } }`).
 */
export function buildEnrichedDirectActorOutputSchema(itemProperties: Record<string, unknown>) {
    const itemsSchema = {
        type: 'object' as const,
        description:
            'JSON Schema for rows in the dataset at `storages.datasets.default.id` — describes row ' +
            'shape only; the rows themselves are NOT returned inline in this response. Inferred from this ' +
            "Actor's historical successful runs. To fetch actual rows, call `get-dataset-items` with the " +
            'dataset id and a `fields` projection drawn from this schema.',
        properties: itemProperties,
    };
    const clone = structuredClone(actorRunOutputSchema);
    const datasetDefaultProps = clone.properties.storages.properties.datasets.properties.default.properties as Record<
        string,
        unknown
    >;
    datasetDefaultProps.itemsSchema = itemsSchema;
    return clone;
}

/** Past-tense state summary; emitted by every storage tool. */
export const summaryProperty = {
    type: 'string' as const,
    description: 'Summary of the result',
};
/** One primary follow-up action; emitted by every non-terminal storage tool. */
export const nextStepProperty = {
    type: 'string' as const,
    description: 'One follow-up action with tool name',
};

/**
 * Builds the Apify `PaginatedList` envelope schema (offset-based pagination) shared by the
 * run and storage list tools. `itemsSchema` describes one array element; mirrors `PaginatedList`
 * from apify-client (api.apify.com `*-get` collection endpoints).
 */
function paginatedListOutputSchema(itemsSchema: object, itemsDescription: string) {
    return {
        type: 'object' as const,
        properties: {
            total: { type: 'number', description: 'Total number of items across all pages.' },
            count: { type: 'number', description: 'Number of items returned in this page.' },
            offset: { type: 'number', description: 'Number of items skipped from the start.' },
            limit: { type: 'number', description: 'Maximum number of items requested.' },
            desc: { type: 'boolean', description: 'Whether items are sorted in descending order.' },
            items: { type: 'array' as const, items: itemsSchema, description: itemsDescription },
        },
        required: ['total', 'offset', 'limit', 'count', 'items'],
    };
}

/** Schema for one run in get-actor-run-list (apify-client `ActorRunListItem`). */
const actorRunListItemSchema = {
    type: 'object' as const,
    properties: {
        id: { type: 'string', description: 'Run ID.' },
        actId: { type: 'string', description: 'ID of the Actor that produced the run.' },
        actorTaskId: { type: 'string', description: 'ID of the Actor task, when the run was started from one.' },
        status: {
            type: 'string',
            description:
                'Run status: READY | RUNNING | SUCCEEDED | FAILED | TIMING-OUT | TIMED-OUT | ABORTING | ABORTED.',
        },
        startedAt: { type: ['string', 'null'], description: 'ISO timestamp when the run started.' },
        finishedAt: {
            type: ['string', 'null'],
            description: 'ISO timestamp when the run finished; null while still running.',
        },
        buildId: { type: 'string', description: 'ID of the Actor build used for the run.' },
        buildNumber: { type: 'string', description: 'Build number used for the run.' },
        defaultDatasetId: { type: 'string', description: "ID of the run's default dataset." },
        defaultKeyValueStoreId: { type: 'string', description: "ID of the run's default key-value store." },
        defaultRequestQueueId: { type: 'string', description: "ID of the run's default request queue." },
        usageTotalUsd: { type: 'number', description: 'Total run cost in USD.' },
    },
    required: ['id', 'actId', 'status', 'defaultDatasetId', 'defaultKeyValueStoreId'],
};

/** Schema for get-actor-run-list output (paginated list of runs). */
export const actorRunListOutputSchema = paginatedListOutputSchema(actorRunListItemSchema, 'Actor runs.');

/**
 * Schema for dataset items retrieval tools (get-dataset-items).
 * Contains dataset items with pagination and count information.
 */
export const datasetItemsOutputSchema = {
    type: 'object' as const,
    properties: {
        datasetId: { type: 'string', description: 'Dataset ID' },
        apifyConsoleUrl: {
            type: 'string',
            description: 'Personalized Apify Console link to the dataset; present only for Console sessions',
        },
        items: { type: 'array' as const, items: { type: 'object' as const }, description: 'Dataset items' },
        itemCount: { type: 'number', description: 'Number of items returned' },
        totalItemCount: { type: 'number', description: 'Total items in dataset' },
        offset: { type: 'number', description: 'Offset used for pagination' },
        limit: { type: 'number', description: 'Limit used for pagination' },
        summary: summaryProperty,
        nextStep: nextStepProperty,
    },
    // offset/limit/totalItemCount and summary/nextStep are always emitted by the tool.
    required: ['datasetId', 'items', 'itemCount', 'totalItemCount', 'offset', 'limit', 'summary', 'nextStep'],
};

/**
 * Schema for dataset metadata (get-dataset). Documents the fields the LLM acts on; the raw API
 * response carries more keys (stats, access settings), allowed as additional properties.
 * The raw `schema` key is stripped by the tool — get-dataset-schema owns schema output (#882).
 */
export const datasetMetadataOutputSchema = {
    type: 'object' as const,
    properties: {
        id: { type: 'string', description: 'Dataset ID' },
        name: { type: ['string', 'null'], description: 'Dataset name (null for unnamed datasets)' },
        itemCount: { type: 'number', description: 'Number of items in the dataset' },
        fields: {
            type: 'array' as const,
            items: { type: 'string' },
            description: 'Field paths in dot notation (e.g. ["metadata.url"])',
        },
        summary: summaryProperty,
        nextStep: nextStepProperty,
    },
    required: ['id', 'summary', 'nextStep'],
};

/**
 * Schema for dataset schema inference (get-dataset-schema).
 */
export const datasetSchemaOutputSchema = {
    type: 'object' as const,
    properties: {
        datasetId: { type: 'string', description: 'Dataset ID' },
        schema: { type: 'object' as const, description: 'Inferred JSON schema describing dataset item structure' },
        summary: summaryProperty,
        nextStep: nextStepProperty,
    },
    required: ['datasetId', 'schema', 'summary', 'nextStep'],
};

/**
 * Schema for storage collection listings (get-dataset-list, get-key-value-store-list).
 * Mirrors the Apify paginated-list response shape plus the narrative fields. `items` is an opaque
 * object since item shape varies by storage type; per-item fields pass through from the API.
 */
export const storageListOutputSchema = {
    type: 'object' as const,
    properties: {
        total: { type: 'number', description: 'Total number of items available for the user' },
        count: { type: 'number', description: 'Number of items returned in this page' },
        offset: { type: 'number', description: 'Offset used for pagination' },
        limit: { type: 'number', description: 'Limit used for pagination' },
        items: {
            type: 'array' as const,
            items: { type: 'object' as const },
            description: 'Storage metadata objects',
        },
        summary: summaryProperty,
        nextStep: nextStepProperty,
    },
    required: ['items', 'total', 'count', 'offset', 'limit', 'summary', 'nextStep'],
};

/**
 * Schema for key-value store metadata (get-key-value-store). The raw API response carries more
 * keys (stats, access settings), allowed as additional properties.
 */
export const keyValueStoreOutputSchema = {
    type: 'object' as const,
    properties: {
        id: { type: 'string', description: 'Key-value store ID' },
        name: { type: ['string', 'null'], description: 'Store name (null for unnamed stores)' },
        summary: summaryProperty,
        nextStep: nextStepProperty,
    },
    required: ['id', 'summary', 'nextStep'],
};

/**
 * Schema for key listing (get-key-value-store-keys).
 */
export const keyValueStoreKeysOutputSchema = {
    type: 'object' as const,
    properties: {
        keyValueStoreId: { type: 'string', description: 'Key-value store ID' },
        items: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    key: { type: 'string', description: 'Record key' },
                    size: { type: 'number', description: 'Value size in bytes' },
                },
                required: ['key', 'size'],
            },
            description: 'Keys with value sizes',
        },
        count: { type: 'number', description: 'Number of keys returned' },
        isTruncated: { type: 'boolean', description: 'Whether more keys are available' },
        nextExclusiveStartKey: {
            type: ['string', 'null'],
            description: 'Pass as exclusiveStartKey to fetch the next page of keys; null when not truncated',
        },
        summary: summaryProperty,
        nextStep: nextStepProperty,
    },
    required: ['keyValueStoreId', 'items', 'count', 'isTruncated', 'nextExclusiveStartKey', 'summary', 'nextStep'],
};

/**
 * Schema for a single record (get-key-value-store-record). Terminal: no nextStep.
 */
export const keyValueStoreRecordOutputSchema = {
    type: 'object' as const,
    properties: {
        keyValueStoreId: { type: 'string', description: 'Key-value store ID' },
        key: { type: 'string', description: 'Record key' },
        value: { description: 'The stored value (JSON, text, or binary)' },
        contentType: { type: 'string', description: 'MIME type of the stored value' },
        summary: summaryProperty,
    },
    required: ['keyValueStoreId', 'key', 'value', 'summary'],
};
