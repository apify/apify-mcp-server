import type { ValidateFunction } from 'ajv';
import type { ActorDefaultRunOptions, ActorDefinition } from 'apify-client';

export type Input = {
    actors: string[] | string;
    enableActorDiscovery?: boolean;
    maxActorMemoryBytes?: number;
    debugActor?: string;
    debugActorInput?: unknown;
};

export interface ActorDefinitionWithDesc extends ActorDefinition {
    description: string;
    defaultRunOptions: ActorDefaultRunOptions
}

export interface Tool {
    name: string;
    actorName: string;
    description: string;
    inputSchema: object;
    ajvValidate: ValidateFunction;
    memoryMbytes: number;
}

export interface SchemaProperties {
    title: string;
    description: string;
    enum: string[]; // Array of string options for the enum
    enumTitles?: string[]; // Array of string titles for the enum
    type: string; // Data type (e.g., "string")
    default: string;
    prefill: string;
}

//  ActorStoreList for actor-search tool
export interface ActorStats {
    totalRuns: number;
    totalUsers: number;
    totalUsers7Days: number;
    totalUsers30Days: number;
}

export interface PricingInfo {
    pricingModel?: string;
    pricePerUnitUsd?: number;
    trialMinutes?: number
}

export interface ActorStoreTruncated {
    name: string;
    username: string;
    title?: string;
    description?: string;
    stats: ActorStats;
    currentPricingInfo: PricingInfo;
    url: string;
    totalStars?: number | null;
}
