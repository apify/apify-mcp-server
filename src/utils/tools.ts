import {
    type HelperTools,
    SKYFIRE_ENABLED_TOOLS,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../const.js';
import type { ActorsMcpServerOptions, HelperTool, ToolBase, ToolEntry } from '../types.js';

type ToolPublicFieldOptions = {
    uiMode?: ActorsMcpServerOptions['uiMode'];
    filterOpenAiMeta?: boolean;
};

/**
 * Strips OpenAI specific metadata from the tool metadata. U
 * @param meta - The tool metadata.
 * @returns The tool metadata with OpenAI specific metadata stripped.
 */
function stripOpenAiMeta(meta?: ToolBase['_meta']) {
    if (!meta) return meta;

    const filteredEntries = Object.entries(meta)
        .filter(([key]) => !key.startsWith('openai/'));

    if (filteredEntries.length === 0) return undefined;

    return Object.fromEntries(filteredEntries);
}

/**
 * Returns a public version of the tool containing only fields that should be exposed publicly.
 * Used for the tools list request.
 */
export function getToolPublicFieldOnly(tool: ToolBase, options: ToolPublicFieldOptions = {}) {
    const { uiMode, filterOpenAiMeta = false } = options;
    const meta = filterOpenAiMeta && uiMode !== 'openai'
        ? stripOpenAiMeta(tool._meta)
        : tool._meta;

    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        icons: tool.icons,
        execution: tool.execution,
        _meta: meta,
    };
}

/**
 * Creates a deep copy of a tool entry, preserving functions like ajvValidate and call
 * while cloning all other properties to avoid shared state mutations.
 */
export function cloneToolEntry(toolEntry: ToolEntry): ToolEntry {
    // Store the original functions
    const originalAjvValidate = toolEntry.ajvValidate;
    const originalCall = toolEntry.type === 'internal' ? toolEntry.call : undefined;

    // Create a deep copy using JSON serialization (excluding functions)
    const cloned = JSON.parse(JSON.stringify(toolEntry, (key, value) => {
        if (key === 'ajvValidate' || key === 'call') return undefined;
        return value;
    })) as ToolEntry;

    // Restore the original functions
    cloned.ajvValidate = originalAjvValidate;
    if (toolEntry.type === 'internal' && originalCall) {
        (cloned as HelperTool).call = originalCall;
    }

    return cloned;
}

/** Returns true if the tool is eligible for Skyfire augmentation. */
function isSkyfireEligible(tool: ToolEntry): boolean {
    return tool.type === 'actor'
        || (tool.type === 'internal' && SKYFIRE_ENABLED_TOOLS.has(tool.name as HelperTools));
}

/**
 * Applies Skyfire augmentation to a tool entry.
 * Clones the tool and, if eligible, appends Skyfire instructions to the description
 * and adds a `skyfire-pay-id` property to the input schema.
 *
 * Returns the (possibly augmented) clone if the tool is eligible,
 * or the original tool reference if it is not eligible.
 * Augmentation is idempotent — calling this on an already-augmented clone is safe.
 */
export function applySkyfireAugmentation(tool: ToolEntry): ToolEntry {
    if (!isSkyfireEligible(tool)) return tool;

    const cloned = cloneToolEntry(tool);

    // Append Skyfire instructions to description (idempotent)
    if (cloned.description && !cloned.description.includes(SKYFIRE_TOOL_INSTRUCTIONS)) {
        cloned.description += `\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`;
    }

    // Add skyfire-pay-id property to inputSchema (idempotent)
    if (cloned.inputSchema && 'properties' in cloned.inputSchema) {
        const props = cloned.inputSchema.properties as Record<string, unknown>;
        if (!props['skyfire-pay-id']) {
            props['skyfire-pay-id'] = {
                type: 'string',
                description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
            };
        }
    }

    return cloned;
}
