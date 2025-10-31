import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Prompt, Request, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import type { ActorDefaultRunOptions, ActorDefinition, ActorStoreList, PricingInfo } from 'apify-client';
import type z from 'zod';

import type { ACTOR_PRICING_MODEL } from './const.js';
import type { ActorsMcpServer } from './mcp/server.js';
import type { toolCategories } from './tools/index.js';
import type { ProgressTracker } from './utils/progress.js';

export interface ISchemaProperties {
    type: string;

    title: string;
    description: string;

    enum?: string[]; // Array of string options for the enum
    enumTitles?: string[]; // Array of string titles for the enum
    default?: unknown;
    prefill?: unknown;

    items?: ISchemaProperties;
    editor?: string;
    examples?: unknown[];

    properties?: Record<string, ISchemaProperties>;
    required?: string[];
}

export interface IActorInputSchema {
    $id?: string;
    title?: string;
    description?: string;

    type: string;

    properties: Record<string, ISchemaProperties>;

    required?: string[];
    schemaVersion?: number;
}

export type ActorDefinitionWithDesc = Omit<ActorDefinition, 'input'> & {
    id: string;
    actorFullName: string;
    description: string;
    defaultRunOptions: ActorDefaultRunOptions;
    input?: IActorInputSchema;
}

/**
 * Pruned Actor definition type.
 * The `id` property is set to Actor ID.
 */
export type ActorDefinitionPruned = Pick<ActorDefinitionWithDesc,
    'id' | 'actorFullName' | 'buildTag' | 'readme' | 'input' | 'description' | 'defaultRunOptions'> & {
        webServerMcpPath?: string; // Optional, used for Actorized MCP server tools
    }

/**
 * Base interface for all tools in the MCP server.
 * Extends the MCP SDK's Tool schema, which requires inputSchema to have type: "object".
 * Adds ajvValidate for runtime validation.
 */
export interface ToolBase extends z.infer<typeof ToolSchema> {
    /** AJV validation function for the input schema */
    ajvValidate: ValidateFunction;
}

/**
 * Type for MCP SDK's inputSchema constraint.
 * Extracted directly from the MCP SDK's ToolSchema to ensure alignment with the specification.
 * The MCP SDK requires inputSchema to have type: "object" (literal) at the top level.
 * Use this type when casting schemas that have type: string to the strict MCP format.
 */
export type McpInputSchema = z.infer<typeof ToolSchema>['inputSchema'];

/**
 * Interface for Actor-based tools - tools that wrap Apify Actors.
 * Type discriminator: 'actor'
 */
export interface ActorTool extends ToolBase {
    /** Type discriminator for actor tools */
    type: 'actor';
    /** Full name of the Apify Actor (username/name) */
    actorFullName: string;
    /** Optional memory limit in MB for the Actor execution */
    memoryMbytes?: number;
}

/**
 * Arguments passed to internal tool calls.
 * Contains both the tool arguments and server references.
 */
export type InternalToolArgs = {
    /** Arguments passed to the tool */
    args: Record<string, unknown>;
    /** Extra data given to request handlers.
     *
     * Can be used to send notifications from the server to the client.
     *
     * For more details see: https://github.com/modelcontextprotocol/typescript-sdk/blob/f822c1255edcf98c4e73b9bf17a9dd1b03f86716/src/shared/protocol.ts#L102
     */
    extra: RequestHandlerExtra<Request, Notification>;
    /** Reference to the Apify MCP server instance */
    apifyMcpServer: ActorsMcpServer;
    /** Reference to the MCP server instance */
    mcpServer: Server;
    /** Apify API token */
    apifyToken: string;
    /** List of Actor IDs that the user has rented */
    userRentedActorIds?: string[];
    /** Optional progress tracker for long running internal tools, like call-actor */
    progressTracker?: ProgressTracker | null;
}

/**
 * Helper tool - tools implemented directly in the MCP server.
 * Type discriminator: 'internal'
 */
export interface HelperTool extends ToolBase {
    /** Type discriminator for helper/internal tools */
    type: 'internal';
    /**
     * Executes the tool with the given arguments
     * @param toolArgs - Arguments and server references
     * @returns Promise resolving to the tool's output
     */
    call: (toolArgs: InternalToolArgs) => Promise<object>;
}

/**
 * Actor MCP tool - tools from Actorized MCP servers that this server proxies.
 * Type discriminator: 'actor-mcp'
 */
export interface ActorMcpTool extends ToolBase {
    /** Type discriminator for actor MCP tools */
    type: 'actor-mcp';
    /** Origin MCP server tool name is needed for the tool call */
    originToolName: string;
    /** ID of the Actorized MCP server - for example, apify/actors-mcp-server */
    actorId: string;
    /**
     * ID of the Actorized MCP server the tool is associated with.
     * serverId is generated unique ID based on the serverUrl.
     */
    serverId: string;
    /** Connection URL of the Actorized MCP server */
    serverUrl: string;
}

/**
 * Discriminated union of all tool types.
 *
 * This is a discriminated union that ensures type safety:
 * - When type is 'internal', tool is guaranteed to be HelperTool
 * - When type is 'actor', tool is guaranteed to be ActorTool
 * - When type is 'actor-mcp', tool is guaranteed to be ActorMcpTool
 */
export type ToolEntry = HelperTool | ActorTool | ActorMcpTool;

/**
 * Price for a single event in a specific tier.
 */
export interface TieredEventPrice {
    tieredEventPriceUsd: number;
}

/**
 * Allowed pricing tiers for tiered event pricing.
 */
export type PricingTier = 'FREE' | 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'DIAMOND';

/**
 * Describes a single chargeable event for an Actor.
 * Supports either flat pricing (eventPriceUsd) or tiered pricing (eventTieredPricingUsd).
 */
export interface ActorChargeEvent {
    eventTitle: string;
    eventDescription: string;
    /** Flat price per event in USD (if not tiered) */
    eventPriceUsd?: number;
    /** Tiered pricing per event, by tier name (FREE, BRONZE, etc.) */
    eventTieredPricingUsd?: Partial<Record<PricingTier, TieredEventPrice>>;
}

/**
 * Pricing per event for an Actor, supporting both flat and tiered pricing.
 */
export interface PricingPerEvent {
    actorChargeEvents: Record<string, ActorChargeEvent>;
}

export type ExtendedPricingInfo = PricingInfo & {
    pricePerUnitUsd?: number;
    trialMinutes?: number;
    unitName?: string; // Name of the unit for the pricing model
    pricingPerEvent: PricingPerEvent;
    tieredPricing?: Partial<Record<PricingTier, { tieredPricePerUnitUsd: number }>>;
};

export type ToolCategory = keyof typeof toolCategories;
/**
 * Selector for tools input - can be a category key or a specific tool name.
 */
export type ToolSelector = ToolCategory | string;

export type Input = {
    /**
     * When `actors` is undefined that means the default Actors should be loaded.
     * If it as empty string or empty array then no Actors should be loaded.
     * Otherwise the specified Actors should be loaded.
     */
    actors?: string[] | string;
    /**
    * @deprecated Use `enableAddingActors` instead.
    */
    enableActorAutoLoading?: boolean | string;
    enableAddingActors?: boolean | string;
    maxActorMemoryBytes?: number;
    debugActor?: string;
    debugActorInput?: unknown;
    /**
     * Tool selectors to include (category keys or concrete tool names).
     * When `tools` is undefined that means the default tool categories should be loaded.
     * If it is an empty string or empty array then no internal tools should be loaded.
     * Otherwise the specified categories and/or concrete tool names should be loaded.
     */
    tools?: ToolSelector[] | string;
};

// Utility type to get a union of values from an object type
export type ActorPricingModel = (typeof ACTOR_PRICING_MODEL)[keyof typeof ACTOR_PRICING_MODEL];

/**
 * Type representing the Actor information needed in order to turn it into an MCP server tool.
 */
export interface ActorInfo {
    webServerMcpPath: string | null; // To determined if the Actor is an MCP server
    actorDefinitionPruned: ActorDefinitionPruned;
}

export type ExtendedActorStoreList = ActorStoreList & {
    categories?: string[];
    bookmarkCount?: number;
    actorReviewRating?: number;
};

export type ActorDefinitionStorage = {
    views: Record<
        string,
        {
            transformation: {
                fields?: string[];
            };
            display: {
                properties: Record<
                    string,
                    object
                >;
            };
        }
    >;
};

export interface ApifyDocsSearchResult {
    /** URL of the documentation page */
    url: string;
    /** Fragment identifier, e.g. "document-heading-1" so LLM knows what section to use when fetching whole document */
    fragment?: string;
    /** Piece of content that matches the search query from Algolia */
    content: string;
}

export type PromptBase = Prompt & {
    /**
     * AJV validation function for the prompt arguments.
     */
    ajvValidate: ValidateFunction;
    /**
     * Function to render the prompt with given arguments
     */
    render: (args: Record<string, string>) => string;
};

export type ActorInputSchemaProperties = Record<string, ISchemaProperties>;
export type DatasetItem = Record<number | string, unknown>;
/**
 * Apify token type.
 *
 * Can be null or undefined in case of Skyfire requests.
 */
export type ApifyToken = string | null | undefined;
