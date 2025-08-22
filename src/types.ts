import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Notification, Prompt, Request } from '@modelcontextprotocol/sdk/types.js';
import type { ValidateFunction } from 'ajv';
import type { ActorDefaultRunOptions, ActorDefinition, ActorStoreList, PricingInfo } from 'apify-client';
import { z } from 'zod';

import type { ACTOR_PRICING_MODEL } from './const.js';
import type { ActorsMcpServer } from './mcp/server.js';
import type { toolCategories } from './tools/index.js';
import type { ProgressTracker } from './utils/progress.js';

export const serverConfigSchemaCli = z.object({
    actors: z
        .string()
        .optional()
        .describe('Comma-separated list of Actor full names to add to the server'),
    enableAddingActors: z
        .boolean()
        .default(true)
        .describe('Enable dynamically adding Actors as tools based on user requests'),
    tools: z
        .string()
        .optional()
        .describe('Comma-separated list of specific tool categories to enable (docs,runs,storage,preview)'),
    /** @deprecated */
    enableActorAutoLoading: z
        .boolean()
        .default(true)
        .describe('Deprecated: use enable-adding-actors instead.'),
});

export const serverConfigSchemaSmithery = serverConfigSchemaCli.extend({
    apifyToken: z
        .string()
        .describe('Apify token, learn more: https://docs.apify.com/platform/integrations/api#api-token'),
});

export type ServerConfigCli = z.infer<typeof serverConfigSchemaCli>;

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
 * Contains common properties shared by all tool types.
 */
export interface ToolBase {
    /** Unique name/identifier for the tool */
    name: string;
    /** Description of what the tool does */
    description: string;
    /** JSON schema defining the tool's input parameters */
    inputSchema: object;
    /** AJV validation function for the input schema */
    ajvValidate: ValidateFunction;
}

/**
 * Interface for Actor-based tools - tools that wrap Apify Actors.
 * Extends ToolBase with Actor-specific properties.
 */
export interface ActorTool extends ToolBase {
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
 * Interface for internal tools - tools implemented directly in the MCP server.
 * Extends ToolBase with a call function implementation.
 */
export interface HelperTool extends ToolBase {
    /**
     * Executes the tool with the given arguments
     * @param toolArgs - Arguments and server references
     * @returns Promise resolving to the tool's output
     */
    call: (toolArgs: InternalToolArgs) => Promise<object>;
}

/**
* Actorized MCP server tool where this MCP server acts as a proxy.
* Extends ToolBase with a tool-associated MCP server.
*/
export interface ActorMcpTool extends ToolBase {
    // Origin MCP server tool name is needed for the tool call
    originToolName: string;
    // ID of the Actorized MCP server - for example, apify/actors-mcp-server
    actorId: string;
    /**
     * ID of the Actorized MCP server the tool is associated with.
     * serverId is generated unique ID based on the serverUrl.
     */
    serverId: string;
    // Connection URL of the Actorized MCP server
    serverUrl: string;
}

/**
 * Type discriminator for tools - indicates whether a tool is internal or Actor-based.
 */
export type ToolType = 'internal' | 'actor' | 'actor-mcp';

/**
 * Wrapper interface that combines a tool with its type discriminator.
 * Used to store and manage tools of different types uniformly.
 */
export interface ToolEntry {
    /** Type of the tool (internal or actor) */
    type: ToolType;
    /** The tool instance */
    tool: ActorTool | HelperTool | ActorMcpTool;
}

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

/**
 * Interface for internal tools - tools implemented directly in the MCP server.
 * Extends ToolBase with a call function implementation.
 */
export interface InternalTool extends ToolBase {
    /**
     * Executes the tool with the given arguments
     * @param toolArgs - Arguments and server references
     * @returns Promise resolving to the tool's output
     */
    call: (toolArgs: InternalToolArgs) => Promise<object>;
}

export type ToolCategory = keyof typeof toolCategories;

export type Input = {
    actors: string[] | string;
    /**
    * @deprecated Use `enableAddingActors` instead.
    */
    enableActorAutoLoading?: boolean | string;
    enableAddingActors?: boolean | string;
    maxActorMemoryBytes?: number;
    debugActor?: string;
    debugActorInput?: unknown;
    /** Tool categories to include */
    tools?: ToolCategory[] | string;
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
