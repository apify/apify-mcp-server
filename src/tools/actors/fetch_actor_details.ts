import type { ToolEntry } from '../../types.js';
import { buildFetchActorDetailsResult, fetchActorDetailsMetadata } from './fetch_actor_details_common.js';

/**
 * Default mode fetch-actor-details tool.
 * Returns full text response with output schema fetch.
 */
export const fetchActorDetails: ToolEntry = Object.freeze({
    ...fetchActorDetailsMetadata,
    call: async (toolArgs) => buildFetchActorDetailsResult(toolArgs),
} as const);
