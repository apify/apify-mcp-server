/**
 * Apps (MCP Apps UI) mode server instructions — includes widget workflow rules and
 * internal vs public tool disambiguation.
 */

import { HelperTools } from '../../const.js';
import { getCommonInstructions } from './common.js';

const WORKFLOW_RULES = `
## CRITICAL: Apps Mode Workflow Rules

**NEVER call \`${HelperTools.ACTOR_RUNS_GET}\` after \`${HelperTools.ACTOR_CALL}\` in apps mode.**

When you call \`${HelperTools.ACTOR_CALL}\` in async mode (apps mode), the response will include a widget that automatically polls for status updates. You must NOT call \`${HelperTools.ACTOR_RUNS_GET}\` or any other tool after this - your task is complete. The widget handles everything automatically.

This is FORBIDDEN and will result in unnecessary duplicate polling. Always stop after receiving the \`${HelperTools.ACTOR_CALL}\` response in apps mode.

`;

const TOOL_DISAMBIGUATION = `
- **Internal vs public Actor tools:**
  - \`${HelperTools.STORE_SEARCH_INTERNAL}\` is for silent name resolution; \`${HelperTools.STORE_SEARCH}\` is for user-facing discovery
  - \`${HelperTools.ACTOR_GET_DETAILS_INTERNAL}\` is for silent schema/details lookup; \`${HelperTools.ACTOR_GET_DETAILS}\` is for user-facing details
  - When the next step is running an Actor, ALWAYS use \`${HelperTools.STORE_SEARCH_INTERNAL}\` for name resolution, never \`${HelperTools.STORE_SEARCH}\``;

/** Returns server instructions for apps (MCP Apps UI) mode. */
export function getAppsInstructions(): string {
    return getCommonInstructions({
        schemaToolHint: `Use \`${HelperTools.ACTOR_GET_DETAILS_INTERNAL}\` first to obtain the Actor's input schema`,
        workflowRules: WORKFLOW_RULES,
        toolDisambiguation: TOOL_DISAMBIGUATION,
    });
}
