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
            description: "The user's plan tier used to resolve pricing (always the user's tier, even if a different tier was used as fallback)",
        },
        pricePerUnit: { type: 'number', description: 'Price per unit (for non-free models)' },
        unitName: { type: 'string', description: 'Unit name for pricing' },
        trialMinutes: { type: 'number', description: 'Trial period in minutes' },
        tieredPricing: tieredPricingSchema,
        events: pricingEventsSchema,
        pricingNote: {
            type: 'string',
            description: 'Note naming the resolved tier; only emitted in simplified mode '
                + 'when the actor has multiple tiers and they resolve consistently',
        },
        eventDescriptionsOmitted: {
            type: 'boolean',
            description: 'Whether event descriptions were omitted because the actor has many pricing events',
        },
        eventDescriptionsNote: {
            type: 'string',
            description: 'Note explaining that event descriptions were omitted and full details are available via fetch-actor-details',
        },
    },
    required: ['model', 'userTier'],
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
        readme: { type: 'string', description: 'Actor README summary when available, otherwise the full README documentation.' },
        inputSchema: { type: 'object' as const, description: 'Actor input schema.' }, // Literal type required for MCP SDK type compatibility
        outputSchema: { type: 'object' as const, description: 'Output schema inferred from successful runs.' },
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
                actorInfo: { type: 'object' as const, description: 'Widget-formatted Actor info (tier-aware pricing, widget display fields).' },
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
        instructions: { type: 'string', description: 'Additional instructions for the LLM to follow when processing the search results.' },
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
        widgetActors: {
            type: 'array' as const,
            items: { type: 'object' as const, description: 'Widget-formatted Actor (tier-aware pricing, widget display fields).' },
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
                    url: { type: 'string', description: 'URL of the documentation page, may include anchor (e.g., #section-name).' },
                    content: { type: 'string', description: 'A limited piece of content that matches the search query.' },
                },
                required: ['url'],
            },
        },
        instructions: { type: 'string', description: 'Additional instructions for the LLM to follow when processing the search results.' },
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

/**
 * Schema for call-actor and direct actor tool outputs.
 * Contains Actor run metadata and dataset items (sync mode only).
 * In async mode, only runId is present.
 */
export const callActorOutputSchema = {
    type: 'object' as const,
    properties: {
        runId: { type: 'string', description: 'Actor run ID' },
        actorName: { type: 'string', description: 'Name of the Actor (only in async mode)' },
        status: { type: 'string', description: 'Run status (only in async mode) - READY, RUNNING, SUCCEEDED, FAILED, ABORTING, ABORTED, TIMED-OUT' },
        startedAt: { type: 'string', description: 'ISO timestamp when the run started (only in async mode)' },
        input: { type: 'object' as const, description: 'Input parameters passed to the Actor (only in async mode)' },
        datasetId: { type: 'string', description: 'Dataset ID containing the full results (sync mode only)' },
        totalItemCount: { type: 'number', description: 'Total number of items in the dataset (sync mode only)' },
        items: {
            type: 'array' as const,
            items: { type: 'object' as const },
            description: 'Dataset items from the Actor run (sync mode only, may be truncated due to size limits)',
        },
        instructions: { type: 'string', description: 'Instructions for the LLM on how to process or retrieve additional data' },
    },
    required: ['runId'],
};

/**
 * Schema for get-actor-run tool output.
 * Contains full run information including status, timestamps, stats, and dataset preview.
 */
export const getActorRunOutputSchema = {
    type: 'object' as const,
    properties: {
        runId: { type: 'string', description: 'Actor run ID' },
        actorName: { type: 'string', description: 'Name of the Actor' },
        status: { type: 'string', description: 'Run status (READY, RUNNING, SUCCEEDED, FAILED, ABORTING, ABORTED, TIMED-OUT)' },
        startedAt: { type: 'string', description: 'ISO timestamp when the run started' },
        finishedAt: { type: 'string', description: 'ISO timestamp when the run finished (only for completed runs)' },
        stats: {
            type: 'object' as const,
            description: 'Run statistics (compute units, memory, duration, etc.)',
        },
        dataset: {
            type: 'object' as const,
            description: 'Dataset information (only for completed runs with results)',
            properties: {
                datasetId: { type: 'string', description: 'Default dataset ID' },
                totalItemCount: { type: 'number', description: 'Total number of items in dataset' },
                previewItemCount: { type: 'number', description: 'Number of preview items returned' },
                schema: { type: 'object' as const, description: 'Auto-generated JSON schema from dataset items' },
                previewItems: {
                    type: 'array' as const,
                    items: { type: 'object' as const },
                    description: 'Preview of first 5 dataset items',
                },
            },
            required: ['datasetId', 'totalItemCount', 'previewItemCount', 'schema', 'previewItems'],
        },
    },
    required: ['runId', 'status', 'startedAt'],
};

/**
 * Schema for dataset items retrieval tools (get-actor-output, get-dataset-items).
 * Contains dataset items with pagination and count information.
 */
export const datasetItemsOutputSchema = {
    type: 'object' as const,
    properties: {
        datasetId: { type: 'string', description: 'Dataset ID' },
        items: { type: 'array' as const,
            items: { type: 'object' as const },
            description: 'Dataset items' },
        itemCount: { type: 'number', description: 'Number of items returned' },
        totalItemCount: { type: 'number', description: 'Total items in dataset' },
        offset: { type: 'number', description: 'Offset used for pagination' },
        limit: { type: 'number', description: 'Limit used for pagination' },
    },
    required: ['datasetId', 'items', 'itemCount'],
};

/**
 * Creates an enriched version of callActorOutputSchema where the `items` field
 * contains actual property definitions inferred from Actor run history.
 *
 * @param itemProperties - JSON Schema properties object describing dataset item fields
 *   (e.g., `{ url: { type: 'string' }, price: { type: 'number' } }`)
 * @returns A copy of callActorOutputSchema with enriched items schema
 */
export function buildEnrichedCallActorOutputSchema(
    itemProperties: Record<string, unknown>,
): typeof callActorOutputSchema {
    return {
        ...callActorOutputSchema,
        properties: {
            ...callActorOutputSchema.properties,
            items: {
                type: 'array' as const,
                items: {
                    type: 'object' as const,
                    properties: itemProperties,
                } as unknown as { type: 'object' },
                description: callActorOutputSchema.properties.items.description,
            },
        },
    };
}
