/**
 * Adapter for search-actors tool — delegates to the appropriate mode-specific variant.
 *
 * The original monolithic implementation has been split into:
 * - `default/search-actors.ts` — text-based actor cards without widget metadata
 * - `openai/search-actors.ts` — widget-formatted actors with interactive widget metadata
 * - `core/search-actors-common.ts` — shared schema, description, and tool metadata
 *
 * This adapter file maintains backward compatibility for existing imports.
 * PR #4 will wire variants directly into the category registry, making this adapter unnecessary.
 */
import type { HelperTool, InternalToolArgs, ToolEntry } from '../types.js';
import { defaultSearchActors } from './default/search-actors.js';
import { openaiSearchActors } from './openai/search-actors.js';

const defaultVariant = defaultSearchActors as HelperTool;

/**
 * Adapter search-actors tool that dispatches to the correct mode-specific variant at runtime.
 */
export const searchActors: ToolEntry = Object.freeze({
    ...defaultVariant,
    call: async (toolArgs: InternalToolArgs) => {
        const variant = (toolArgs.apifyMcpServer.options.uiMode === 'openai'
            ? openaiSearchActors
            : defaultSearchActors) as HelperTool;
        return variant.call(toolArgs);
    },
});
