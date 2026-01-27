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
        model: { type: 'string', description: 'Pricing model (FREE, PRICE_PER_DATASET_ITEM, FLAT_PRICE_PER_MONTH, PAY_PER_EVENT)' },
        isFree: { type: 'boolean', description: 'Whether the Actor is free to use' },
        pricePerUnit: { type: 'number', description: 'Price per unit (for non-free models)' },
        unitName: { type: 'string', description: 'Unit name for pricing' },
        trialMinutes: { type: 'number', description: 'Trial period in minutes' },
        tieredPricing: tieredPricingSchema,
        events: pricingEventsSchema,
    },
    required: ['model', 'isFree'],
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
        rating: { type: 'number', description: 'Actor rating' },
        modifiedAt: { type: 'string', description: 'Last modification date' },
        isDeprecated: { type: 'boolean', description: 'Whether the Actor is deprecated' },
    },
    required: ['url', 'fullName', 'developer', 'description', 'categories', 'pricing'],
};

/**
 * Schema for Actor details output (fetch-actor-details tool)
 * All fields are optional since the tool supports selective output via the 'output' parameter
 */
export const actorDetailsOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        actorInfo: actorInfoSchema,
        readme: { type: 'string', description: 'Actor README documentation.' },
        inputSchema: { type: 'object' as const, description: 'Actor input schema.' }, // Literal type required for MCP SDK type compatibility
    },
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
        itemCount: { type: 'number', description: 'Total number of items in the dataset (sync mode only)' },
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
                itemCount: { type: 'number', description: 'Total number of items in dataset' },
                schema: { type: 'object' as const, description: 'Auto-generated JSON schema from dataset items' },
                previewItems: {
                    type: 'array' as const,
                    items: { type: 'object' as const },
                    description: 'Preview of first 5 dataset items',
                },
            },
            required: ['datasetId', 'itemCount', 'schema', 'previewItems'],
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
