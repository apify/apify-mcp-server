/**
 * Two-phase tool loading: {@link getActors} fetches Actor metadata (async, mode-agnostic);
 * {@link loadToolsFromInput} runs both in sequence.
 */

import type { ApifyClient } from 'apify-client';

import log from '@apify/log';

import { defaults, HELPER_TOOLS, type HelperToolName } from '../const.js';
import type { PaymentProvider } from '../payments/types.js';
import { addActor } from '../tools/actors/add_actor.js';
import { reportProblem } from '../tools/dev/report_problem.js';
import { getActorsAsTools } from '../tools/index.js';
import {
    CATEGORY_NAME_SET,
    CATEGORY_NAMES,
    getCategoryTools,
    toolCategoriesEnabledByDefault,
    WIDGET_BY_BASE_TOOL,
} from '../tools/registry.js';
import { abortActorRun } from '../tools/runs/abort_actor_run.js';
import { getActorRun } from '../tools/runs/get_actor_run.js';
import { getDatasetItems } from '../tools/storage/get_dataset_items.js';
import { getKeyValueStoreRecord } from '../tools/storage/get_key_value_store_record.js';
import type { ActorStore, Input, ToolCategory, ToolEntry } from '../types.js';
import { SERVER_MODES, SERVER_MODE, TOOL_TYPE } from '../types.js';

/**
 * Tools auto-injected alongside any actor-running tool (call-actor / direct
 * actor tools / add-actor). Order matches the workflow: fetch run status →
 * fetch items → fetch KV record → abort.
 */
export const AUTO_INJECTED_TOOLS: readonly ToolEntry[] = [
    getActorRun,
    getDatasetItems,
    getKeyValueStoreRecord,
    abortActorRun,
] as const;

// All internal tool names across all modes. Selectors matching these are not treated as Actor IDs.
// Built eagerly at module load; inputs (SERVER_MODES, getCategoryTools, CATEGORY_NAMES,
// WIDGET_BY_BASE_TOOL) are module-level constants available at import time.
const ALL_INTERNAL_TOOL_NAMES: Set<string> = (() => {
    const names = new Set<string>();
    // Collect tool names from both modes to ensure complete classification
    for (const mode of SERVER_MODES) {
        const categories = getCategoryTools(mode);
        for (const name of CATEGORY_NAMES) {
            for (const tool of categories[name]) names.add(tool.name);
        }
    }
    // Widgets live only in WIDGET_BY_BASE_TOOL, not in any category
    for (const widget of WIDGET_BY_BASE_TOOL.values()) names.add(widget.name);
    return names;
})();

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
    const selectors =
        raw === undefined
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
 * **Mode-agnostic** — the result does NOT depend on `SERVER_MODE`. An Actor tool
 * is identified by name, and the same Actor entry is reused across modes; only
 * the *internal* tool variants around it differ by mode.
 *
 * Selectors classified as "actor names":
 *   - NOT the deprecated `'preview'` pseudo-category
 *   - NOT a category name (from `CATEGORY_NAME_SET`)
 *   - NOT the name of an internal tool in any mode (from `ALL_INTERNAL_TOOL_NAMES`)
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
            if (ALL_INTERNAL_TOOL_NAMES.has(sel)) continue;
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

/**
 * Fetch Actor tool entries for all Actor names in `input`.
 *
 * Pass `paymentProvider` for sessions authenticated via an external payment
 * provider (x402, Skyfire) so standby/MCP-server Actors are filtered out —
 * see `getActorsAsTools` for the full rationale.
 */
export async function getActors(
    input: Input,
    apifyClient: ApifyClient,
    options?: { actorStore?: ActorStore; paymentProvider?: PaymentProvider },
): Promise<ToolEntry[]> {
    const actorNames = resolveActorsToLoad(input);
    if (actorNames.length === 0) return [];
    const { tools } = await getActorsAsTools(actorNames, apifyClient, options);
    return tools;
}

/** Build a restore {@link Input} from concrete tool names: internal names → `tools`, actor names → `actors`. */
export function toolNamesToInput(toolNames: string[]): Input {
    const internalToolNames: string[] = [];
    const actorToolNames: string[] = [];

    for (const toolName of toolNames) {
        if (ALL_INTERNAL_TOOL_NAMES.has(toolName)) {
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
export function getToolsForServerMode(
    input: Input,
    actorTools: ToolEntry[],
    mode: SERVER_MODE = SERVER_MODE.DEFAULT,
): ToolEntry[] {
    // Build mode-resolved categories — tools are already the correct variant for this mode
    const categories = getCategoryTools(mode);

    const { selectors, addActorEnabled, actorsExplicitlyEmpty } = normalizeInput(input);
    const selectorsExplicitEmpty = selectors?.length === 0;

    // Build mode-specific tool-by-name map for individual tool selection
    const toolsByName = new Map<string, ToolEntry>();
    for (const name of CATEGORY_NAMES) {
        for (const tool of categories[name]) {
            toolsByName.set(tool.name, tool);
        }
    }
    // Widgets are apps-only and not in any category; include it for direct selection
    if (mode === SERVER_MODE.APPS) {
        for (const widget of WIDGET_BY_BASE_TOOL.values()) {
            toolsByName.set(widget.name, widget);
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
                const callActorTool = toolsByName.get(HELPER_TOOLS.ACTOR_CALL);
                if (callActorTool) internalSelections.push(callActorTool);
                continue;
            }

            const categoryTools = categories[sel as ToolCategory];
            if (categoryTools) {
                internalSelections.push(...categoryTools);
                continue;
            }
            const internalByName = toolsByName.get(sel);
            if (internalByName) {
                internalSelections.push(internalByName);
                continue;
            }
            // Internal tool from another mode → skip silently (getActors already
            // routed it away from actor names).
            if (ALL_INTERNAL_TOOL_NAMES.has(sel)) {
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
            const hasAddActor = result.some((e) => e.name === addActor.name);
            if (!hasAddActor) result.push(addActor);
        }
    } else if (addActorEnabled && !actorsExplicitlyEmpty) {
        // No selectors: either expose only add-actor (when enabled), or default categories
        result.push(addActor);
    } else if (!actorsExplicitlyEmpty) {
        // Use mode-resolved default categories
        for (const cat of toolCategoriesEnabledByDefault) {
            result.push(...categories[cat]);
        }
        // report-problem is default-served but lives in the `dev` category (not a default category),
        // so inject it here for the default (no-selectors) case. Server-side servability gating
        // (telemetry on + client allowed + client known) still applies downstream in
        // composeToolsForClient; this only puts it in the default candidate set.
        result.push(reportProblem);
    }

    // Actor tools (pre-fetched, mode-agnostic)
    if (actorTools.length > 0) {
        result.push(...actorTools);
    }

    /**
     * Auto-inject run-status and storage tools when call-actor, actor tools, or add-actor are present.
     * Insert them right after call-actor (or appended at the end when call-actor is absent) so the
     * default tool list reads in workflow order: call → get-actor-run → get-dataset-items →
     * get-key-value-store-record → abort-actor-run. If the user explicitly selected these tools
     * via category before `actors`, the de-dup pass below preserves their selector order.
     */
    const hasCallActor = result.some((entry) => entry.name === HELPER_TOOLS.ACTOR_CALL);
    const hasActorTools = result.some((entry) => entry.type === TOOL_TYPE.ACTOR);
    const hasAddActorTool = result.some((entry) => entry.name === HELPER_TOOLS.ACTOR_ADD);
    // `get-actor-run`'s nextStep templates point at `get-dataset-items` / `get-key-value-store-record`,
    // and the apps-mode widget calls `get-dataset-items` to fetch its preview. A runs-only session
    // (e.g. `tools: ['runs']`) would otherwise land on an unrecommendable tool / empty widget.
    const hasGetActorRun = result.some((entry) => entry.name === HELPER_TOOLS.ACTOR_RUNS_GET);

    // Inject run-workflow helpers whenever any actor-running entrypoint is present; de-dup pass below drops repeats.
    const toolsToInject: ToolEntry[] = [];
    if (hasCallActor || hasActorTools || hasAddActorTool || hasGetActorRun) {
        toolsToInject.push(...AUTO_INJECTED_TOOLS);
    }

    if (toolsToInject.length > 0) {
        const callActorIndex = result.findIndex((entry) => entry.name === HELPER_TOOLS.ACTOR_CALL);
        if (callActorIndex !== -1) {
            result.splice(callActorIndex + 1, 0, ...toolsToInject);
        } else {
            result.push(...toolsToInject);
        }
    }

    // Apps mode: append a widget tool for each base tool already in the result.
    // Runs after the get-actor-run auto-inject, so an auto-injected base still
    // brings its widget sibling.
    if (mode === SERVER_MODE.APPS) {
        for (const entry of [...result]) {
            const widget = WIDGET_BY_BASE_TOOL.get(entry.name as HelperToolName);
            // Push unconditionally; any duplicates are stripped by the de-dup pass below.
            if (widget) result.push(widget);
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
    mode: SERVER_MODE = SERVER_MODE.DEFAULT,
    actorStore?: ActorStore,
): Promise<ToolEntry[]> {
    const actorTools = await getActors(input, apifyClient, { actorStore });
    return getToolsForServerMode(input, actorTools, mode);
}
