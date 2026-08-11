import { HELPER_TOOLS } from '../../const.js';
import { actorNameToToolName } from '../actor_tool_naming.js';

/**
 * Whether the session can run the given Actor: a general-purpose call tool is loaded
 * (`call-actor` or its widget variant, which also executes Actors), or the Actor is
 * exposed as its own dedicated tool.
 *
 * `loadedToolNames` holds the live tool registry keys, and dedicated Actor tools are
 * registered under `actorNameToToolName(actorFullName)` — the same computation used here.
 */
export function canRunActor(actorFullName: string, loadedToolNames: readonly string[]): boolean {
    return (
        loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL) ||
        loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL_WIDGET) ||
        loadedToolNames.includes(actorNameToToolName(actorFullName))
    );
}

// Both constants stay flush-left: they are interpolated into `dedent` blocks, where indented
// lines would be re-indented by the surrounding template.

/** Appended to search results when at least one found Actor cannot be run in this session. */
export const SEARCH_RESULTS_RUN_GUIDANCE = `This connector can run only Actors already exposed as dedicated tools. Other Actors
found here are informational and cannot be run in this configuration. To use another
Actor, open its Apify page or configure it separately.`;

/** Appended to Actor details when that Actor cannot be run in this session. */
export const ACTOR_DETAILS_RUN_GUIDANCE = `This Actor is not exposed as a tool and cannot be run in this configuration. Open its
Apify page or configure it separately to use it.`;
