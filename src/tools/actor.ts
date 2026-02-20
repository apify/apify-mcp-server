/**
 * Adapter for call-actor tool — delegates to the appropriate mode-specific variant.
 *
 * The original monolithic call-actor implementation has been split into:
 * - `default/call-actor.ts` — sync execution, references default tools
 * - `openai/call-actor.ts` — forced async, widget metadata, references internal tools
 * - `core/call-actor-common.ts` — shared pre-execution logic (arg parsing, MCP handling, validation)
 *
 * This adapter file maintains backward compatibility for existing imports.
 * PR #4 will wire variants directly into the category registry, making this adapter unnecessary.
 */
import type { HelperTool, InternalToolArgs, ToolEntry } from '../types.js';
import { defaultCallActor } from './default/call-actor.js';
import { openaiCallActor } from './openai/call-actor.js';

// Re-exports to maintain backward compatibility and support other modules
export { callActorGetDataset, type CallActorGetDatasetResult } from './core/actor-execution.js';
export { getActorsAsTools } from './core/actor-tools-factory.js';

const defaultVariant = defaultCallActor as HelperTool;

/**
 * Adapter call-actor tool that dispatches to the correct mode-specific variant at runtime.
 *
 * The tool definition (name, inputSchema, outputSchema, etc.) uses the default variant's metadata.
 * The `call` handler inspects `apifyMcpServer.options.uiMode` to delegate to the right implementation.
 *
 * @deprecated This adapter is no longer needed — buildCategories(uiMode) returns the correct
 * variant directly. Will be removed once all consumers are migrated.
 */
export const callActor: ToolEntry = Object.freeze({
    ...defaultVariant,
    call: async (toolArgs: InternalToolArgs) => {
        const variant = (toolArgs.apifyMcpServer.options.uiMode === 'openai'
            ? openaiCallActor
            : defaultCallActor) as HelperTool;
        return variant.call(toolArgs);
    },
});
