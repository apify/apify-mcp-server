/**
 * Adapter for fetch-actor-details tool — delegates to the appropriate mode-specific variant.
 *
 * The original monolithic implementation has been split into:
 * - `default/fetch-actor-details.ts` — full text response with output schema fetch
 * - `openai/fetch-actor-details.ts` — simplified structured content with widget metadata
 * - `core/fetch-actor-details-common.ts` — shared schema, description, and tool metadata
 *
 * This adapter file maintains backward compatibility for existing imports.
 * PR #4 will wire variants directly into the category registry, making this adapter unnecessary.
 */
import type { HelperTool, InternalToolArgs, ToolEntry } from '../types.js';
import { defaultFetchActorDetails } from './default/fetch-actor-details.js';
import { openaiFetchActorDetails } from './openai/fetch-actor-details.js';

const defaultVariant = defaultFetchActorDetails as HelperTool;

/**
 * Adapter fetch-actor-details tool that dispatches to the correct mode-specific variant at runtime.
 */
export const fetchActorDetailsTool: ToolEntry = Object.freeze({
    ...defaultVariant,
    call: async (toolArgs: InternalToolArgs) => {
        const variant = (toolArgs.apifyMcpServer.options.uiMode === 'openai'
            ? openaiFetchActorDetails
            : defaultFetchActorDetails) as HelperTool;
        return variant.call(toolArgs);
    },
});
