/**
 * Unified server instructions — mode-agnostic text served to all clients.
 *
 * Widget-specific guidance is included unconditionally. Clients without the MCP
 * Apps UI capability receive the same text, but the per-tool response payloads
 * they see do not include widget metadata, so the rules are benign.
 *
 * Note: the `-widget` suffix split (separating widget-backed tools from silent
 * variants by name) is planned in follow-up PRs. Until then, widget rendering
 * happens on the base tool names (`call-actor`, `search-actors`,
 * `fetch-actor-details`) in apps mode.
 */

import { HelperTools, RAG_WEB_BROWSER } from '../../const.js';

/**
 * Build unified server instructions. Mode-agnostic.
 */
export function getServerInstructions(): string {
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

## Widget workflow (applies when tool responses include widget metadata)
Some clients render widget-backed Actor tools: the response includes a live UI that automatically polls run status. When a widget is rendered, follow-up status polling by the model is a forbidden duplicate.

- **Never call \`${HelperTools.ACTOR_RUNS_GET}\` after a widget-backed \`${HelperTools.ACTOR_CALL}\` response.** The widget renders live progress and polls itself — stop after the widget response and defer to it for run status.
- When \`${HelperTools.ACTOR_CALL}\` runs without a widget (the tool response is plain text / structured data only), polling \`${HelperTools.ACTOR_RUNS_GET}\` for status is expected.
- Follow-up PRs will split widget-backed tools into a dedicated \`-widget\`-suffixed namespace; until then, widget rendering happens on the base tool names when the client supports it.

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
- **Widget-backed variants (when the client supports them):** Some \`${HelperTools.STORE_SEARCH}\` / \`${HelperTools.ACTOR_GET_DETAILS}\` responses render an interactive widget for the user. Prefer the widget-backed variant when the user explicitly asks to *see*, *browse*, or *view* something; prefer silent lookups (\`${HelperTools.STORE_SEARCH_INTERNAL}\`, \`${HelperTools.ACTOR_GET_DETAILS_INTERNAL}\`) when the next step is to actually run an Actor or perform a programmatic flow. A \`-widget\` suffix split is planned in a follow-up PR; until then, widget rendering is selected by the server based on client capabilities.
- **\`${HelperTools.STORE_SEARCH}\` vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs \`${HelperTools.ACTOR_CALL}\`:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in the Apify store.
`;
}
