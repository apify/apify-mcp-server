/**
 * Server instructions — mode-aware text served to clients.
 *
 * Apps-only sections (widget workflow, widget tool disambiguation) are included
 * only when the resolved server mode is `'apps'`. Default-mode clients never
 * see widget tool names like `search-actors-widget` or `fetch-actor-details-widget`,
 * avoiding hallucinated calls to tools absent from `tools/list`.
 */

import { HelperTools, RAG_WEB_BROWSER } from '../../const.js';
import { ServerMode } from '../../types.js';

/**
 * Build server instructions for the given mode.
 *
 * Apps-only sections are omitted in default mode to prevent models from
 * attempting to call widget tools that are not registered.
 */
export function getServerInstructions(mode: ServerMode = ServerMode.DEFAULT): string {
    const isApps = mode === ServerMode.APPS;

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
${isApps ? `
## Widget workflow (applies when tool responses include widget metadata)
Some clients render widget-backed Actor tools: the response includes a live UI that automatically polls run status. When a widget is rendered, follow-up status polling by the model is a forbidden duplicate.

- **After \`${HelperTools.ACTOR_CALL_WIDGET}\` or \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\`, never call \`${HelperTools.ACTOR_RUNS_GET}\` or \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\` for the same run.** Both widgets render live progress and poll themselves — stop after the widget response and defer to it for run status. Re-rendering the same run via \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\` is a duplicate.
- Polling \`${HelperTools.ACTOR_RUNS_GET}\` after \`${HelperTools.ACTOR_CALL}\` (the silent async variant, no widget) is fine — that tool renders no UI, so polling is expected when you need the run status.
` : ''}
## Tool dependencies and disambiguation

### Tool dependencies
- \`${HelperTools.ACTOR_CALL}\`:
  - Use \`${HelperTools.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema.
  - Then call with proper input to execute the Actor.
  - For MCP server Actors, use format "actorName:toolName" to call specific tools.${isApps ? `
  - In this mode \`${HelperTools.ACTOR_CALL}\` always runs asynchronously — it starts the run and returns immediately with a runId. Use \`${HelperTools.ACTOR_RUNS_GET}\` to check status and \`${HelperTools.ACTOR_OUTPUT_GET}\` to fetch output once the run completes.` : `
  - Supports async execution via the \`async\` parameter:
    - \`async: false\` or unset: waits for completion and returns results immediately.
    - \`async: true\`: starts the run and returns immediately with a runId.`}

### Tool disambiguation
- **\`${HelperTools.ACTOR_OUTPUT_GET}\` vs \`${HelperTools.DATASET_GET_ITEMS}\`:**
  Use \`${HelperTools.ACTOR_OUTPUT_GET}\` for Actor run outputs and \`${HelperTools.DATASET_GET_ITEMS}\` for direct dataset access.
- **\`${HelperTools.STORE_SEARCH}\` vs \`${HelperTools.ACTOR_GET_DETAILS}\`:**
  \`${HelperTools.STORE_SEARCH}\` finds Actors; \`${HelperTools.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
${isApps ? `- **Data vs widget Actor tools (when the client supports widgets):**
  - \`${HelperTools.STORE_SEARCH}\` is a silent data lookup (Actor list for name resolution) with no UI; \`${HelperTools.STORE_SEARCH_WIDGET}\` renders an interactive UI element (widget) with Actor search results for the user to browse — use it only when the user explicitly asks to search or discover Actors.
  - \`${HelperTools.ACTOR_GET_DETAILS}\` is a silent data lookup (input schema, README, metadata) with no UI; \`${HelperTools.ACTOR_GET_DETAILS_WIDGET}\` renders an interactive UI element (widget) with Actor details — use it only when the user explicitly asks to see or browse the Actor.
  - \`${HelperTools.ACTOR_CALL}\` is a silent async start (returns runId, no UI); \`${HelperTools.ACTOR_CALL_WIDGET}\` renders an interactive UI element (widget) that tracks live Actor run progress — use it only when the user explicitly asks to see progress.
  - \`${HelperTools.ACTOR_RUNS_GET}\` is a silent data lookup (run status, dataset IDs, stats) with no UI; \`${HelperTools.ACTOR_RUNS_GET_WIDGET}\` renders an interactive UI element (widget) showing live run progress for the user — use it only when the user explicitly asks to see run progress.
  - When the next step is running an Actor, prefer silent lookups (\`${HelperTools.STORE_SEARCH}\`, \`${HelperTools.ACTOR_GET_DETAILS}\`) over widget-backed variants.
` : ''}- **\`${HelperTools.STORE_SEARCH}\` vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs \`${HelperTools.ACTOR_CALL}\`:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in the Apify store.
`;
}
