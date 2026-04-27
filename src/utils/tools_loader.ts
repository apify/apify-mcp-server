/**
 * Two-phase tool loading: {@link getActors} fetches Actor metadata (async, mode-agnostic);
 * {@link loadToolsFromInput} runs both in sequence.
 */

import type { ApifyClient } from 'apify-client';

import log from '@apify/log';

import { defaults, HelperTools } from '../const.js';
import { CATEGORY_NAME_SET, CATEGORY_NAMES, getCategoryTools, toolCategoriesEnabledByDefault } from '../tools/categories.js';
import { addTool } from '../tools/common/add_actor.js';
import { getActorOutput } from '../tools/common/get_actor_output.js';
import { getActorsAsTools } from '../tools/index.js';
import type { ActorStore, Input, ToolCategory, ToolEntry } from '../types.js';
import { SERVER_MODES, ServerMode } from '../types.js';

// All internal tool names across all modes. Selectors matching these are not treated as Actor IDs.
let ALL_INTERNAL_TOOL_NAMES_CACHE: Set<string> | null = null;
function getAllInternalToolNames(): Set<string> {
    if (!ALL_INTERNAL_TOOL_NAMES_CACHE) {
        const allNames = new Set<string>();
        // Collect tool names from both modes to ensure complete classification
        for (const mode of SERVER_MODES) {
            const categories = getCategoryTools(mode);
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

type NormalizedInput = {
    /**
     * Cleaned tool selectors (trimmed, non-empty). `undefined` when `input.tools`
     * was not provided at all. Use `selectors?.length === 0` to detect an
     * explicitly-empty list.
     */
    selectors: string[] | undefined;
    /** `true` when `input.enableAddingActors === true`. */
    addActorEnabled: boolean;
    /** `true` when `input.actors` was explicitly empty (`[]` or `''`). */
    actorsExplicitlyEmpty: boolean;
};

/**
 * Normalize the raw {@link Input} into cleaned selectors + two non-derivable flags.
 * Shared by both loader phases so semantics stay consistent.
 */
function normalizeInput(input: Input): NormalizedInput {
    const raw = input.tools;
    const selectors = raw === undefined
        ? undefined
        : (Array.isArray(raw) ? raw : [raw])
            .map(String)
            .map((s) => s.trim())
            .filter((s) => s !== '');
    return {
        selectors,
        addActorEnabled: input.enableAddingActors === true,
        actorsExplicitlyEmpty: input.actors === '' || (Array.isArray(input.actors) && input.actors.length === 0),
    };
}

/**
 * Resolve the list of Actor names (`username/name`) to fetch from the input.
 *
 * **Mode-agnostic** — the result does NOT depend on `ServerMode`. An Actor tool
 * is identified by name, and the same Actor entry is reused across modes; only
 * the *internal* tool variants around it differ by mode.
 *
 * Selectors classified as "actor names":
 *   - NOT the deprecated `'preview'` pseudo-category
 *   - NOT a category name (from `CATEGORY_NAME_SET`)
 *   - NOT the name of an internal tool in any mode (from `getAllInternalToolNames`)
 *
 * If no selectors / no explicit actors: the defaults apply (or empty when
 * add-actor mode is on).
 */
function resolveActorsToLoad(input: Input): string[] {
    const { selectors, addActorEnabled, actorsExplicitlyEmpty } = normalizeInput(input);

    // Selectors that aren't categories or internal tools in any mode → Actor names.
    const actorSelectorsFromTools: string[] = [];
    if (selectors !== undefined) {
        for (const sel of selectors) {
            if (sel === 'preview') continue;
            if (CATEGORY_NAME_SET.has(sel)) continue;
            if (getAllInternalToolNames().has(sel)) continue;
            actorSelectorsFromTools.push(sel);
        }
    }

    let actorsFromField: string[] | undefined;
    if (input.actors === undefined) {
        actorsFromField = undefined;
    } else if (Array.isArray(input.actors)) {
        actorsFromField = input.actors;
    } else {
        actorsFromField = [input.actors];
    }

    if (actorsFromField !== undefined) return actorsFromField;
    if (actorSelectorsFromTools.length > 0) return actorSelectorsFromTools;
    if (selectors === undefined) {
        // No selectors supplied: use defaults unless add-actor mode is enabled
        return addActorEnabled || actorsExplicitlyEmpty ? [] : defaults.actors;
    }
    // Selectors provided but none are actors => do not load defaults
    return [];
}

/** Fetch Actor tool entries for all Actor names in `input`. */
export async function getActors(
    input: Input,
    apifyClient: ApifyClient,
    actorStore?: ActorStore,
): Promise<ToolEntry[]> {
    const actorNames = resolveActorsToLoad(input);
    return actorNames.length > 0
        ? getActorsAsTools(actorNames, apifyClient, { actorStore })
        : [];
}

/** Build a restore {@link Input} from concrete tool names: internal names → `tools`, actor names → `actors`. */
export function toolNamesToInput(toolNames: string[]): Input {
    const internalToolNames: string[] = [];
    const actorToolNames: string[] = [];

    for (const toolName of toolNames) {
        if (getAllInternalToolNames().has(toolName)) {
            internalToolNames.push(toolName);
        } else {
            actorToolNames.push(toolName);
        }
    }

    const input: Input = {
        tools: internalToolNames,
    };

    if (actorToolNames.length > 0) {
        input.actors = actorToolNames;
    }

    return input;
}

/** Compose the final tool list from pre-fetched actor tools and the original input for the given mode. */
export function getToolsForServerMode(input: Input, actorTools: ToolEntry[], mode: ServerMode = ServerMode.DEFAULT): ToolEntry[] {
    // Build mode-resolved categories — tools are already the correct variant for this mode
    const categories = getCategoryTools(mode);

    const { selectors, addActorEnabled, actorsExplicitlyEmpty } = normalizeInput(input);
    const selectorsExplicitEmpty = selectors?.length === 0;
    const explicitlyNoToolsRequested = selectorsExplicitEmpty || actorsExplicitlyEmpty;

    // Build mode-specific tool-by-name map for individual tool selection
    const modeToolByName = new Map<string, ToolEntry>();
    for (const name of CATEGORY_NAMES) {
        for (const tool of categories[name]) {
            modeToolByName.set(tool.name, tool);
        }
    }

    // Walk selectors for internal picks (mode-specific). Actor-name classification
    // happened in `resolveActorsToLoad`; we don't need to partition again here.
    const internalSelections: ToolEntry[] = [];
    if (selectors !== undefined && selectors.length > 0) {
        for (const sel of selectors) {
            if (sel === 'preview') {
                // 'preview' category is deprecated. It contained `call-actor` which is now default.
                log.warning('Tool category "preview" is deprecated');
                const callActorTool = modeToolByName.get(HelperTools.ACTOR_CALL);
                if (callActorTool) internalSelections.push(callActorTool);
                continue;
            }

            const categoryTools = categories[sel as ToolCategory];
            if (categoryTools) {
                internalSelections.push(...categoryTools);
                continue;
            }
            const internalByName = modeToolByName.get(sel);
            if (internalByName) {
                internalSelections.push(internalByName);
                continue;
            }
            // Internal tool from another mode → skip silently (getActors already
            // routed it away from actor names).
            if (getAllInternalToolNames().has(sel)) {
                log.debug(`Skipping selector "${sel}" — it is an internal tool from another mode (current: "${mode}")`);
            }
            // Else: selector was an Actor name; it's already in `actorTools`.
        }
    }

    // Compose final tool list
    const result: ToolEntry[] = [];

    // Internal tools
    if (selectors !== undefined) {
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

    // In apps mode, unconditionally add UI-specific tools (regardless of selectors)
    if (mode === ServerMode.APPS && !explicitlyNoToolsRequested) {
        result.push(...categories.ui);
    }

    // Actor tools (pre-fetched, mode-agnostic)
    if (actorTools.length > 0) {
        result.push(...actorTools);
    }

    /**
     * Auto-inject get-actor-run and get-actor-output when call-actor or actor tools are present.
     * Insert them right after call-actor to follow the logical workflow order:
     * search → details → call → run status → output → docs → actor tools
     *
     * Uses mode-resolved variants from getCategoryTools() for get-actor-run.
     */
    const hasCallActor = result.some((entry) => entry.name === HelperTools.ACTOR_CALL);
    const hasActorTools = result.some((entry) => entry.type === 'actor');
    const hasAddActorTool = result.some((entry) => entry.name === HelperTools.ACTOR_ADD);
    const hasGetActorRun = result.some((entry) => entry.name === HelperTools.ACTOR_RUNS_GET);
    const hasGetActorOutput = result.some((entry) => entry.name === HelperTools.ACTOR_OUTPUT_GET);

    const toolsToInject: ToolEntry[] = [];
    if (!hasGetActorRun && (hasCallActor || (mode === ServerMode.APPS && !explicitlyNoToolsRequested))) {
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

    // De-duplicate by tool name for safety
    const seen = new Set<string>();
    return result.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));
}

/** Convenience wrapper: {@link getActors} + {@link getToolsForServerMode} in sequence. */
export async function loadToolsFromInput(
    input: Input,
    apifyClient: ApifyClient,
    mode: ServerMode = ServerMode.DEFAULT,
    actorStore?: ActorStore,
): Promise<ToolEntry[]> {
    const actorTools = await getActors(input, apifyClient, actorStore);
    return getToolsForServerMode(input, actorTools, mode);
}
