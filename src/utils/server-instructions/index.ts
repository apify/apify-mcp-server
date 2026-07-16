/**
 * Server instructions — mode-aware text served to clients.
 *
 * Apps-only sections (widget workflow, widget tool disambiguation) are included
 * only when the resolved server mode is `'apps'`. Default-mode clients never
 * see widget tool names like `search-actors-widget` or `fetch-actor-details-widget`,
 * avoiding hallucinated calls to tools absent from `tools/list`.
 */

import { getApifyAPIBaseUrl } from '../../apify_client.js';
import { HELPER_TOOLS, RAG_WEB_BROWSER } from '../../const.js';
import { SERVER_MODE } from '../../types.js';

/**
 * Build server instructions for the given mode.
 *
 * Apps-only sections are omitted in default mode to prevent models from
 * attempting to call widget tools that are not registered. The report-problem line is
 * emitted only when `reportProblemAvailable` is true — i.e. `report-problem` is actually
 * served — so clients that never receive the tool (Anthropic surfaces, telemetry off, or a
 * `tools=` selection that omits report-problem) are not told to call it.
 */
export function getServerInstructions(mode: SERVER_MODE = SERVER_MODE.DEFAULT, reportProblemAvailable = false): string {
    const isApps = mode === SERVER_MODE.APPS;
    // Derive the API base from config so examples match the gate/templates under an
    // APIFY_API_BASE_URL / staging override, instead of a hardcoded api.apify.com.
    const apiBaseUrl = getApifyAPIBaseUrl();

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

## Apify API resources
- Any Apify API GET endpoint can be read as an MCP resource. Pass the full \`${apiBaseUrl}/v2/...\` URL to \`resources/read\`; the server injects the session's Apify token and returns the response body. Reads require an Apify token — a session without one (e.g. payment-only x402/Skyfire) fails with a JSON-RPC error.
- Actor and tool results return storage IDs, not resource URLs — build the URL from the ID (e.g. a \`datasetId\` becomes \`${apiBaseUrl}/v2/datasets/{datasetId}/items\`) and read it via \`resources/read\`.
- Reads inline up to ~256 KB; a larger response is not downloaded — it returns a short notice with a download URL instead of the body, so page large datasets/lists with \`limit\` and \`offset\` to stay under the cap.
- Examples: \`${apiBaseUrl}/v2/datasets/{datasetId}/items?clean=true&format=json&limit=100\`, \`${apiBaseUrl}/v2/key-value-stores/{storeId}/records/{recordKey}\`. \`resources/templates/list\` enumerates the common shapes with their paging parameters.
${
    isApps
        ? `
## Widget workflow (applies when tool responses include widget metadata)
Some clients render widget-backed Actor tools: the response includes a live UI that automatically polls run status. When a widget is rendered, follow-up status polling by the model is a forbidden duplicate.

- **After \`${HELPER_TOOLS.ACTOR_CALL_WIDGET}\` or \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\`, never call \`${HELPER_TOOLS.ACTOR_RUNS_GET}\` or \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` for the same run.** Both widgets render live progress and poll themselves — stop after the widget response and defer to it for run status. Re-rendering the same run via \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` is a duplicate.
- Polling \`${HELPER_TOOLS.ACTOR_RUNS_GET}\` after \`${HELPER_TOOLS.ACTOR_CALL}\` is fine — that tool renders no UI, so polling is expected when the run is non-terminal and you need the latest status.
`
        : ''
}
## Tool dependencies and disambiguation

### Tool dependencies
- \`${HELPER_TOOLS.ACTOR_CALL}\`:
  - Use \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema.
  - Then call with proper input to execute the Actor.
  - For MCP server Actors, use format "actorName:toolName" to call specific tools.
  - Supports a \`waitSecs\` parameter (default 30, max 45):
    - \`waitSecs: 0\`: fire-and-forget — starts the run and returns immediately with a runId.
    - \`waitSecs > 0\`: waits up to that many seconds for the run to complete, then returns the result.

### Tool disambiguation
- **\`${HELPER_TOOLS.STORE_SEARCH}\` vs \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\`:**
  \`${HELPER_TOOLS.STORE_SEARCH}\` finds Actors; \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
${
    isApps
        ? `- **Data vs widget Actor tools (when the client supports widgets):**
  - \`${HELPER_TOOLS.STORE_SEARCH}\` is a silent data lookup (Actor list for name resolution) with no UI; \`${HELPER_TOOLS.STORE_SEARCH_WIDGET}\` renders an interactive UI element (widget) with Actor search results for the user to browse — use it only when the user explicitly asks to search or discover Actors.
  - \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` is a silent data lookup (input schema, README, metadata) with no UI; \`${HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET}\` renders an interactive UI element (widget) with Actor details — use it only when the user explicitly asks to see or browse the Actor.
  - \`${HELPER_TOOLS.ACTOR_CALL}\` runs the Actor and returns its result (no UI); \`${HELPER_TOOLS.ACTOR_CALL_WIDGET}\` renders an interactive UI element (widget) that tracks live Actor run progress — use it only when the user explicitly asks to see progress.
  - \`${HELPER_TOOLS.ACTOR_RUNS_GET}\` is a silent data lookup (run status, dataset IDs, stats) with no UI; \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` renders an interactive UI element (widget) showing live run progress for the user — use it only when the user explicitly asks to see run progress.
  - When the next step is running an Actor, prefer silent lookups (\`${HELPER_TOOLS.STORE_SEARCH}\`, \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\`) over widget-backed variants.
`
        : ''
}- **\`${HELPER_TOOLS.STORE_SEARCH}\` vs ${RAG_WEB_BROWSER}:**
  \`${HELPER_TOOLS.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs \`${HELPER_TOOLS.ACTOR_CALL}\`:**
  Prefer dedicated tools when available; use \`${HELPER_TOOLS.ACTOR_CALL}\` only when no specialized tool exists in the Apify store.
${
    reportProblemAvailable
        ? `
If a tool or Actor fails and you cannot resolve it, you can report it with \`${HELPER_TOOLS.PROBLEM_REPORT}\`.
`
        : ''
}`;
}
