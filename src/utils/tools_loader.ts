/**
 * Shared logic for loading tools based on Input type.
 * This eliminates duplication between stdio.ts and processParamsGetTools.
 */

import type { ApifyClient } from 'apify';

import log from '@apify/log';

import { defaults, HelperTools } from '../const.js';
import { buildCategories, CATEGORY_NAMES, toolCategoriesEnabledByDefault } from '../tools/categories.js';
import { getActorOutput } from '../tools/common/get-actor-output.js';
import { addTool } from '../tools/common/helpers.js';
import { getActorsAsTools } from '../tools/index.js';
import type { ActorStore, Input, ToolCategory, ToolEntry, UiMode } from '../types.js';

/**
 * Set of all known internal tool names across ALL modes.
 * Used for classifying selectors: if a selector matches a known internal tool name,
 * it's not treated as an Actor ID — even if it's absent from the current mode's categories.
 */
let ALL_INTERNAL_TOOL_NAMES_CACHE: Set<string> | null = null;
function getAllInternalToolNames(): Set<string> {
    if (!ALL_INTERNAL_TOOL_NAMES_CACHE) {
        const allNames = new Set<string>();
        // Collect tool names from both modes to ensure complete classification
        for (const mode of [undefined, 'openai' as UiMode]) {
            const categories = buildCategories(mode);
            for (const name of CATEGORY_NAMES) {
                for (const tool of categories[name]) {
                    allNames.add(tool.name);
                }
            }
        }
        ALL_INTERNAL_TOOL_NAMES_CACHE = allNames;
    }
    return ALL_INTERNAL_TOOL_NAMES_CACHE;
}

/**
 * Load tools based on the provided Input object.
 * This function is used by both the stdio.ts and the processParamsGetTools function.
 *
 * @param input The processed Input object
 * @param apifyClient The Apify client instance
 * @param uiMode Optional UI mode.
 * @returns An array of tool entries
 */
export async function loadToolsFromInput(
    input: Input,
    apifyClient: ApifyClient,
    uiMode?: UiMode,
    actorStore?: ActorStore,
): Promise<ToolEntry[]> {
    // Build mode-resolved categories — tools are already the correct variant for this mode
    const categories = buildCategories(uiMode);

    // Helpers for readability
    const normalizeSelectors = (value: Input['tools']): (string | ToolCategory)[] | undefined => {
        if (value === undefined) return undefined;
        return (Array.isArray(value) ? value : [value])
            .map(String)
            .map((s) => s.trim())
            .filter((s) => s !== '');
    };

    const selectors = normalizeSelectors(input.tools);
    const selectorsProvided = selectors !== undefined;
    const selectorsExplicitEmpty = selectorsProvided && (selectors as string[]).length === 0;
    const addActorEnabled = input.enableAddingActors === true;
    const actorsExplicitlyEmpty = (Array.isArray(input.actors) && input.actors.length === 0) || input.actors === '';

    // Build mode-specific tool-by-name map for individual tool selection
    const modeToolByName = new Map<string, ToolEntry>();
    for (const name of CATEGORY_NAMES) {
        for (const tool of categories[name]) {
            modeToolByName.set(tool.name, tool);
        }
    }

    // Partition selectors into internal picks (by category or by name) and Actor names
    const internalSelections: ToolEntry[] = [];
    const actorSelectorsFromTools: string[] = [];
    if (selectorsProvided && !selectorsExplicitEmpty) {
        for (const selector of selectors as (string | ToolCategory)[]) {
            if (selector === 'preview') {
                // 'preview' category is deprecated. It contained `call-actor` which is now default
                log.warning('Tool category "preview" is deprecated');
                const callActorTool = modeToolByName.get(HelperTools.ACTOR_CALL);
                if (callActorTool) internalSelections.push(callActorTool);
                continue;
            }

            const categoryTools = categories[selector as ToolCategory];

            if (categoryTools) {
                internalSelections.push(...categoryTools);
                continue;
            }
            const internalByName = modeToolByName.get(String(selector));
            if (internalByName) {
                internalSelections.push(internalByName);
                continue;
            }
            // If this is a known internal tool name (from another mode), skip it silently
            // rather than treating it as an Actor ID
            if (getAllInternalToolNames().has(String(selector))) {
                continue;
            }
            // Treat unknown selectors as Actor IDs/full names.
            // Potential heuristic (future): if (String(selector).includes('/')) => definitely an Actor.
            actorSelectorsFromTools.push(String(selector));
        }
    }

    // Decide which Actors to load
    let actorsFromField: string[] | undefined;
    if (input.actors === undefined) {
        actorsFromField = undefined;
    } else if (Array.isArray(input.actors)) {
        actorsFromField = input.actors;
    } else {
        actorsFromField = [input.actors];
    }

    let actorNamesToLoad: string[] = [];
    if (actorsFromField !== undefined) {
        actorNamesToLoad = actorsFromField;
    } else if (actorSelectorsFromTools.length > 0) {
        actorNamesToLoad = actorSelectorsFromTools;
    } else if (!selectorsProvided) {
        // No selectors supplied: use defaults unless add-actor mode is enabled
        actorNamesToLoad = addActorEnabled ? [] : defaults.actors;
    } // else: selectors provided but none are actors => do not load defaults

    // Compose final tool list
    const result: ToolEntry[] = [];

    // Internal tools
    if (selectorsProvided) {
        result.push(...internalSelections);
        // If add-actor mode is enabled, ensure add-actor tool is available alongside selected tools.
        if (addActorEnabled && !selectorsExplicitEmpty && !actorsExplicitlyEmpty) {
            const hasAddActor = result.some((e) => e.name === addTool.name);
            if (!hasAddActor) result.push(addTool);
        }
    } else if (addActorEnabled && !actorsExplicitlyEmpty) {
        // No selectors: either expose only add-actor (when enabled), or default categories
        result.push(addTool);
    } else if (!actorsExplicitlyEmpty) {
        // Use mode-resolved default categories
        for (const cat of toolCategoriesEnabledByDefault) {
            result.push(...categories[cat]);
        }
    }

    // In openai mode, unconditionally add UI-specific tools (regardless of selectors)
    if (uiMode === 'openai') {
        result.push(...categories.ui);
    }

    // Actor tools (if any)
    if (actorNamesToLoad.length > 0) {
        const actorTools = await getActorsAsTools(actorNamesToLoad, apifyClient, { actorStore });
        result.push(...actorTools);
    }

    /**
     * Auto-inject get-actor-run and get-actor-output when call-actor or actor tools are present.
     * Insert them right after call-actor to follow the logical workflow order:
     * search → details → call → run status → output → docs → actor tools
     *
     * Uses mode-resolved variants from buildCategories() for get-actor-run.
     */
    const hasCallActor = result.some((entry) => entry.name === HelperTools.ACTOR_CALL);
    const hasActorTools = result.some((entry) => entry.type === 'actor');
    const hasAddActorTool = result.some((entry) => entry.name === HelperTools.ACTOR_ADD);
    const hasGetActorRun = result.some((entry) => entry.name === HelperTools.ACTOR_RUNS_GET);
    const hasGetActorOutput = result.some((entry) => entry.name === HelperTools.ACTOR_OUTPUT_GET);

    const toolsToInject: ToolEntry[] = [];
    if (!hasGetActorRun && (hasCallActor || uiMode === 'openai')) {
        // Use mode-resolved get-actor-run variant
        const modeGetActorRun = modeToolByName.get(HelperTools.ACTOR_RUNS_GET);
        if (modeGetActorRun) toolsToInject.push(modeGetActorRun);
    }
    if (!hasGetActorOutput && (hasCallActor || hasActorTools || hasAddActorTool)) {
        toolsToInject.push(getActorOutput);
    }

    if (toolsToInject.length > 0) {
        const callActorIndex = result.findIndex((entry) => entry.name === HelperTools.ACTOR_CALL);
        if (callActorIndex !== -1) {
            result.splice(callActorIndex + 1, 0, ...toolsToInject);
        } else {
            result.push(...toolsToInject);
        }
    }

    // TEMP: for now we disable this swapping logic as the add-actor tool was misbehaving in some clients
    // Handle client capabilities logic for 'actors' category to swap call-actor for add-actor
    // if client supports dynamic tools.
    // const selectorContainsCallActor = selectors?.some((s) => s === HelperTools.ACTOR_CALL);
    // if (doesMcpClientSupportDynamicTools(initializeRequestData) && hasCallActor && !selectorContainsCallActor) {
    //    // Remove call-actor
    //    result = result.filter((entry) => entry.tool.name !== HelperTools.ACTOR_CALL);
    //    // Replace with add-actor if not already present
    //    if (!hasAddActorTool) result.push(addTool);
    // }

    // De-duplicate by tool name for safety
    const seen = new Set<string>();
    return result.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));
}
