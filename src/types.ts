import type { ValidateFunction } from 'ajv';
import type { ActorDefinition } from 'apify-client';

export type Input = {
    actors: string[] | string;
    debugActor?: string;
    debugActorInput?: unknown;
};

export interface ActorDefinitionWithDesc extends ActorDefinition {
    description: string;
}

export interface Tool {
    name: string;
    description: string;
    inputSchema: object;
    ajvValidate: ValidateFunction;
}
