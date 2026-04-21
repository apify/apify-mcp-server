/**
 * Unified server instructions — mode-agnostic text served to all clients.
 *
 * Widget-specific guidance is included unconditionally. For clients without the
 * MCP Apps UI capability, `-widget` tool names never appear in `tools/list`, so
 * the widget rules are inert — the model cannot call tools that don't exist.
 */

import { HelperTools, RAG_WEB_BROWSER } from '../../const.js';

/**
 * Returns the unified server instructions.
 */
export function getCommonInstructions(): string {
    return `
Apify is the world's largest marketplace of tools for web scraping, data extraction, and web automation.
These tools are called **Actors**. They enable you to extract structured data from social media, e-commerce, search engines, maps, travel sites, and many other sources.

## Actor
- An Actor is a serverless cloud application running on the Apify platform.
- Use the Actor's **README** to understand its capabilities.
- Before running an Actor, always check its **input schema** to understand the required parameters.

## Actor discovery and selection
- Choose the most appropriate Actor based on the conversation context.
- Search the Apify Store first; a relevant Actor likely already exists.
- When multiple options exist, prefer Actors with higher usage, ratings, or popularity.
- Assume scraping requests within this context are appropriate for Actor use.
- Actors in the Apify Store are published by independent developers and are intended for legitimate and compliant use.

## Actor execution workflow
- Actors take input and produce output.
- Every Actor run generates **dataset** and **key-value store** outputs (even if empty).
- Actor execution may take time, and outputs can be large.
- Large datasets can be paginated to retrieve results efficiently.

## Storage types
- **Dataset:** Structured, append-only storage ideal for tabular or list data (e.g., scraped items).
- **Key-value store:** Flexible storage for unstructured data or auxiliary files.

## Widget workflow (applies only when \`-widget\` tools are available)
Some clients expose \`-widget\` variants of Actor tools (names ending in \`-widget\`). These render interactive UI for the user and automatically poll for status updates.

- **NEVER call \`${HelperTools.ACTOR_RUNS_GET}\` after a \`-widget\` Actor call.** The widget renders live progress and polls itself; a follow-up \`${HelperTools.ACTOR_RUNS_GET}\` call is a forbidden duplicate. Stop after the widget response.
- Polling \`${HelperTools.ACTOR_RUNS_GET}\` after \`${HelperTools.ACTOR_CALL}\` (the silent async variant, no UI) is expected when you need the run status.

If \`-widget\` tools are not present in \`tools/list\`, the rules above don't apply — use the regular variants directly.

## Tool dependencies and disambiguation

### Tool dependencies
- \`${HelperTools.ACTOR_CALL}\`:
  - Use \`${HelperTools.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema.
  - Then call with proper input to execute the Actor.
  - For MCP server Actors, use format "actorName:toolName" to call specific tools.
  - Supports async execution via the \`async\` parameter:
    - \`async: false\` or unset: waits for completion and returns results immediately.
    - \`async: true\`: starts the run and returns immediately with a runId.

### Tool disambiguation
- **\`${HelperTools.ACTOR_OUTPUT_GET}\` vs \`${HelperTools.DATASET_GET_ITEMS}\`:**
  Use \`${HelperTools.ACTOR_OUTPUT_GET}\` for Actor run outputs and \`${HelperTools.DATASET_GET_ITEMS}\` for direct dataset access.
- **\`${HelperTools.STORE_SEARCH}\` vs \`${HelperTools.ACTOR_GET_DETAILS}\`:**
  \`${HelperTools.STORE_SEARCH}\` finds Actors; \`${HelperTools.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
- **Widget variants (when available):** Tools with a \`-widget\` suffix render UI for the user; the base tool is silent. Use the \`-widget\` variant only when the user explicitly asks to *see*, *browse*, or *view* something; use the silent base variant for name resolution, silent data lookup, and programmatic flows. When the next step is to actually run an Actor, always use \`${HelperTools.STORE_SEARCH}\` (silent) for name resolution, never a \`-widget\` variant.
- **\`${HelperTools.STORE_SEARCH}\` vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs \`${HelperTools.ACTOR_CALL}\`:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in the Apify store.
`;
}
