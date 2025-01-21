import type { ValidateFunction } from 'ajv';
import type { ActorDefaultRunOptions, ActorDefinition } from 'apify-client';

export type Input = {
    actors: string[] | string;
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
    enumTitles: string[]; // Array of string titles for the enum
    type: string; // Data type (e.g., "string")
    default: string;
    prefill: string;
}
