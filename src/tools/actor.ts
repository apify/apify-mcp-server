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
import type { HelperTool, InternalToolArgs, ToolEntry, UiMode } from '../types.js';
import { defaultCallActor } from './default/call-actor.js';
import { openaiCallActor } from './openai/call-actor.js';

// Re-exports to maintain backward compatibility and support other modules
export { callActorGetDataset, type CallActorGetDatasetResult } from './core/actor-execution.js';
export { getActorsAsTools } from './core/actor-tools-factory.js';

/**
 * Returns the call-actor description for the given UI mode.
 * Maintained for backward compatibility with tools-loader.ts which mutates the description at load time.
 * PR #4 will remove this in favor of direct variant registration.
 */
export function getCallActorDescription(uiMode?: UiMode): string {
    const variant = uiMode === 'openai' ? openaiCallActor : defaultCallActor;
    return variant.description ?? '';
}

const defaultVariant = defaultCallActor as HelperTool;

/**
 * Adapter call-actor tool that dispatches to the correct mode-specific variant at runtime.
 *
 * The tool definition (name, inputSchema, outputSchema, etc.) uses the default variant's metadata.
 * The `call` handler inspects `apifyMcpServer.options.uiMode` to delegate to the right implementation.
 *
 * Note: The description may be overridden by tools-loader.ts at load time for openai mode.
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
