/**
 * Shared logic for loading tools based on Input type.
 * This eliminates duplication between stdio.ts and processParamsGetTools.
 */

import type { ValidateFunction } from 'ajv';
import type { ApifyClient } from 'apify';

import log from '@apify/log';

import { defaults, HelperTools } from '../const.js';
import { callActor, getCallActorDescription } from '../tools/actor.js';
import { getActorOutput } from '../tools/common/get-actor-output.js';
import { addTool } from '../tools/common/helpers.js';
import { getActorRun } from '../tools/common/run.js';
import { getActorsAsTools, toolCategories, toolCategoriesEnabledByDefault } from '../tools/index.js';
import type { ActorStore, Input, InternalToolArgs, ToolCategory, ToolEntry, UiMode } from '../types.js';
import { getExpectedToolsByCategories } from './tool-categories-helpers.js';

// Lazily-computed cache of internal tools by name to avoid circular init issues.
let INTERNAL_TOOL_BY_NAME_CACHE: Map<string, ToolEntry> | null = null;
function getInternalToolByNameMap(): Map<string, ToolEntry> {
    if (!INTERNAL_TOOL_BY_NAME_CACHE) {
        const allInternal = getExpectedToolsByCategories(Object.keys(toolCategories) as ToolCategory[]);
        INTERNAL_TOOL_BY_NAME_CACHE = new Map<string, ToolEntry>(
            allInternal.map((entry) => [entry.name, entry]),
        );
    }
    return INTERNAL_TOOL_BY_NAME_CACHE;
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

    // Partition selectors into internal picks (by category or by name) and Actor names
    const internalSelections: ToolEntry[] = [];
    const actorSelectorsFromTools: string[] = [];
    if (selectorsProvided && !selectorsExplicitEmpty) {
        for (const selector of selectors as (string | ToolCategory)[]) {
            if (selector === 'preview') {
                // 'preview' category is deprecated. It contained `call-actor` which is now default
                log.warning('Tool category "preview" is deprecated');
                internalSelections.push(callActor);
                continue;
            }

            const categoryTools = toolCategories[selector as ToolCategory];

            if (categoryTools) {
                internalSelections.push(...categoryTools);
                continue;
            }
            const internalByName = getInternalToolByNameMap().get(String(selector));
            if (internalByName) {
                internalSelections.push(internalByName);
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
        result.push(...getExpectedToolsByCategories(toolCategoriesEnabledByDefault));
    }

    // In openai mode, add UI-specific tools
    if (uiMode === 'openai') {
        result.push(...(toolCategories.ui || []));
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
     */
    const hasCallActor = result.some((entry) => entry.name === HelperTools.ACTOR_CALL);
    const hasActorTools = result.some((entry) => entry.type === 'actor');
    const hasAddActorTool = result.some((entry) => entry.name === HelperTools.ACTOR_ADD);
    const hasGetActorRun = result.some((entry) => entry.name === HelperTools.ACTOR_RUNS_GET);
    const hasGetActorOutput = result.some((entry) => entry.name === HelperTools.ACTOR_OUTPUT_GET);

    const toolsToInject: ToolEntry[] = [];
    if (!hasGetActorRun && (hasCallActor || uiMode === 'openai')) {
        toolsToInject.push(getActorRun);
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
    const deduped = result.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));

    // Filter out openai-only tools when not in openai mode
    const filtered = uiMode === 'openai'
        ? deduped
        : deduped.filter((entry) => !entry.openaiOnly);

    // TODO: rework this solition as it was quickly hacked together for hotfix
    // Deep clone except ajvValidate and call functions

    // holds the original functions of the tools
    const toolFunctions = new Map<string, { ajvValidate?: ValidateFunction<unknown>; call?:(args: InternalToolArgs) => Promise<object> }>();
    for (const entry of filtered) {
        if (entry.type === 'internal') {
            toolFunctions.set(entry.name, { ajvValidate: entry.ajvValidate, call: entry.call });
        } else {
            toolFunctions.set(entry.name, { ajvValidate: entry.ajvValidate });
        }
    }

    const cloned = JSON.parse(JSON.stringify(filtered, (key, value) => {
        if (key === 'ajvValidate' || key === 'call') return undefined;
        return value;
    })) as ToolEntry[];

    // restore the original functions
    for (const entry of cloned) {
        const funcs = toolFunctions.get(entry.name);
        if (funcs) {
            if (funcs.ajvValidate) {
                entry.ajvValidate = funcs.ajvValidate;
            }
            if (entry.type === 'internal' && funcs.call) {
                entry.call = funcs.call;
            }
        }
    }

    for (const entry of cloned) {
        if (entry.name === HelperTools.ACTOR_CALL) {
            entry.description = getCallActorDescription(uiMode);
        }
    }
    return cloned;
}
