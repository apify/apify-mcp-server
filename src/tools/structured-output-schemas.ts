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
 */
export const actorDetailsOutputSchema = {
    type: 'object' as const, // Literal type required for MCP SDK type compatibility
    properties: {
        actorInfo: actorInfoSchema,
        readme: { type: 'string', description: 'Actor README documentation.' },
        inputSchema: { type: 'object' as const, description: 'Actor input schema.' }, // Literal type required for MCP SDK type compatibility
    },
    required: ['actorInfo', 'readme', 'inputSchema'],
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
                    url: { type: 'string', description: 'URL of the documentation page.' },
                    fragment: { type: 'string', description: 'Fragment identifier within the document, if available.' },
                    content: { type: 'string', description: 'A limited piece of content that matches the search query.' },
                },
                required: ['url', 'content'],
            },
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
