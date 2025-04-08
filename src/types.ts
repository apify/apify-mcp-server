import type { ValidateFunction } from 'ajv';
import type { ActorDefaultRunOptions, ActorDefinition } from 'apify-client';

export type Input = {
    actors: string[] | string;
    enableAddingActors?: boolean;
    enableActorAutoLoading?: boolean;
    maxActorMemoryBytes?: number;
    debugActor?: string;
    debugActorInput?: unknown;
};

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

export type ActorDefinitionPruned = Pick<ActorDefinitionWithDesc,
    'id' | 'actorFullName' | 'buildTag' | 'readme' | 'input' | 'description' | 'defaultRunOptions'>

export interface Tool {
    name: string;
    actorFullName: string;
    description: string;
    inputSchema: object;
    ajvValidate: ValidateFunction;
    memoryMbytes?: number;
}

//  ActorStoreList for actor-search tool
export interface ActorStats {
    totalRuns: number;
    totalUsers30Days: number;
    publicActorRunStats30Days: unknown;
}

export interface PricingInfo {
    pricingModel?: string;
    pricePerUnitUsd?: number;
    trialMinutes?: number
}

export interface ActorStorePruned {
    id: string;
    name: string;
    username: string;
    actorFullName?: string;
    title?: string;
    description?: string;
    stats: ActorStats;
    currentPricingInfo: PricingInfo;
    url: string;
    totalStars?: number | null;
}
