import log from '@apify/log';

import type { HelperTools } from '../const.js';
import {
    SKYFIRE_ENABLED_TOOLS,
    SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
    SKYFIRE_TOOL_INSTRUCTIONS,
} from '../const.js';
import { defaultTools, toolCategories } from '../tools/index.js';
import type { ToolEntry } from '../types.js';
import { cloneToolEntry } from '../utils/tools.js';

type GetToolsAndActorsToLoadParams = {
    toolNames: string[];
    loadedToolNames: string[];
};

type UpsertToolsParams = {
    toolsRegistry: Map<string, ToolEntry>;
    tools: ToolEntry[];
    skyfireMode?: boolean;
};

type RemoveToolsByNameParams = {
    toolsRegistry: Map<string, ToolEntry>;
    toolNames: string[];
};

/**
 * Returns an array of loaded MCP tool names.
 */
export function listToolNames(toolsRegistry: Map<string, ToolEntry>): string[] {
    return Array.from(toolsRegistry.keys());
}

/**
 * Returns the list of loaded internal helper tool names.
 */
export function listInternalToolNames(toolsRegistry: Map<string, ToolEntry>): string[] {
    return Array.from(toolsRegistry.values())
        .filter((tool) => tool.type === 'internal')
        .map((tool) => tool.name);
}

/**
 * Returns the list of loaded Actor tool IDs.
 */
export function listActorToolNames(toolsRegistry: Map<string, ToolEntry>): string[] {
    return Array.from(toolsRegistry.values())
        .filter((tool) => tool.type === 'actor')
        .map((tool) => tool.actorFullName);
}

/**
 * Returns unique Actor IDs that are registered as MCP servers.
 */
export function listActorMcpServerToolIds(toolsRegistry: Map<string, ToolEntry>): string[] {
    const ids = Array.from(toolsRegistry.values())
        .filter((tool: ToolEntry) => tool.type === 'actor-mcp')
        .map((tool) => tool.actorId);
    // Ensure uniqueness
    return Array.from(new Set(ids));
}

/**
 * Returns all tool identifiers that can be used in load/restore flows.
 */
export function listAllToolNames(toolsRegistry: Map<string, ToolEntry>): string[] {
    return [
        ...listInternalToolNames(toolsRegistry),
        ...listActorToolNames(toolsRegistry),
        ...listActorMcpServerToolIds(toolsRegistry),
    ];
}

/**
 * Splits requested tool names into internal tools and Actors to load.
 */
export function getToolsAndActorsToLoad({
    toolNames,
    loadedToolNames,
}: GetToolsAndActorsToLoadParams): { toolsToLoad: ToolEntry[]; actorsToLoad: string[] } {
    const actorsToLoad: string[] = [];
    const toolsToLoad: ToolEntry[] = [];
    const internalToolMap = new Map([
        ...defaultTools,
        ...Object.values(toolCategories).flat(),
    ].map((tool) => [tool.name, tool]));

    for (const tool of toolNames) {
        // Skip if the tool is already loaded
        if (loadedToolNames.includes(tool)) continue;
        // Load internal tool
        if (internalToolMap.has(tool)) {
            toolsToLoad.push(internalToolMap.get(tool) as ToolEntry);
        // Load Actor
        } else {
            actorsToLoad.push(tool);
        }
    }

    return { toolsToLoad, actorsToLoad };
}

/**
 * Upserts tools into registry with optional Skyfire mode mutation.
 */
export function upsertTools({
    toolsRegistry,
    tools,
    skyfireMode,
}: UpsertToolsParams): ToolEntry[] {
    if (skyfireMode) {
        for (const wrap of tools) {
            // Clone the tool before modifying it to avoid affecting shared objects
            const clonedWrap = cloneToolEntry(wrap);
            let modified = false;

            // Handle Skyfire mode modifications
            if (wrap.type === 'actor'
                || (wrap.type === 'internal' && SKYFIRE_ENABLED_TOOLS.has(wrap.name as HelperTools))) {
                // Add Skyfire instructions to description if not already present
                if (clonedWrap.description && !clonedWrap.description.includes(SKYFIRE_TOOL_INSTRUCTIONS)) {
                    clonedWrap.description += `\n\n${SKYFIRE_TOOL_INSTRUCTIONS}`;
                }
                // Add skyfire-pay-id property if not present
                if (clonedWrap.inputSchema && 'properties' in clonedWrap.inputSchema) {
                    const props = clonedWrap.inputSchema.properties as Record<string, unknown>;
                    if (!props['skyfire-pay-id']) {
                        props['skyfire-pay-id'] = {
                            type: 'string',
                            description: SKYFIRE_PAY_ID_PROPERTY_DESCRIPTION,
                        };
                    }
                }
                modified = true;
            }

            // Store the cloned and modified tool only if modifications were made
            toolsRegistry.set(clonedWrap.name, modified ? clonedWrap : wrap);
        }
        return tools;
    }

    // No skyfire mode - store tools as-is
    for (const tool of tools) {
        toolsRegistry.set(tool.name, tool);
    }

    return tools;
}

/**
 * Removes tools by name from registry and returns removed names.
 */
export function removeToolsByName({
    toolsRegistry,
    toolNames,
}: RemoveToolsByNameParams): string[] {
    const removedTools: string[] = [];
    for (const toolName of toolNames) {
        if (toolsRegistry.has(toolName)) {
            toolsRegistry.delete(toolName);
            log.debug('Deleted tool', { toolName });
            removedTools.push(toolName);
        }
    }
    return removedTools;
}
