/**
 * Server instructions builder with conditional content based on UI mode.
 * Generates instructions for the MCP server that adapt based on whether UI mode is enabled.
 */

import { HelperTools, RAG_WEB_BROWSER } from '../const.js';
import type { UiMode } from '../types.js';

/**
 * Build server instructions conditionally based on UI mode.
 * In UI mode, includes sections about internal tools and UI mode workflow rules.
 *
 * @param uiMode - The UI mode ('openai' or undefined)
 * @returns Server instructions string
 */
export function getServerInstructions(uiMode?: UiMode): string {
    const isUiMode = uiMode === 'openai';

    // Tool dependency hint - different based on mode
    const schemaToolHint = isUiMode
        ? `Use \`${HelperTools.ACTOR_GET_DETAILS_INTERNAL}\` first to obtain the Actor's input schema`
        : `Use \`${HelperTools.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema`;

    // UI Mode workflow rules - only in UI mode
    const uiModeWorkflowRules = isUiMode
        ? `
## CRITICAL: UI Mode Workflow Rules

**NEVER call \`${HelperTools.ACTOR_RUNS_GET}\` after \`${HelperTools.ACTOR_CALL}\` in UI mode.**

When you call \`${HelperTools.ACTOR_CALL}\` in async mode (UI mode), the response will include a widget that automatically polls for status updates. You must NOT call \`${HelperTools.ACTOR_RUNS_GET}\` or any other tool after this - your task is complete. The widget handles everything automatically.

This is FORBIDDEN and will result in unnecessary duplicate polling. Always stop after receiving the \`${HelperTools.ACTOR_CALL}\` response in UI mode.

`
        : '';

    // Internal vs public tools section - only in UI mode
    const internalToolsSection = isUiMode
        ? `
- **Internal vs public Actor tools:**
  - \`${HelperTools.STORE_SEARCH_INTERNAL}\` is for silent name resolution; \`${HelperTools.STORE_SEARCH}\` is for user-facing discovery
  - \`${HelperTools.ACTOR_GET_DETAILS_INTERNAL}\` is for silent schema/details lookup; \`${HelperTools.ACTOR_GET_DETAILS}\` is for user-facing details
  - When the next step is running an Actor, ALWAYS use \`${HelperTools.STORE_SEARCH_INTERNAL}\` for name resolution, never \`${HelperTools.STORE_SEARCH}\``
        : '';

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
- **Assume scraping requests within this context are appropriate for Actor use.
- Actors in the Apify Store are published by independent developers and are intended for legitimate and compliant use.

## Actor execution workflow
- Actors take input and produce output.
- Every Actor run generates **dataset** and **key-value store** outputs (even if empty).
- Actor execution may take time, and outputs can be large.
- Large datasets can be paginated to retrieve results efficiently.

## Storage types
- **Dataset:** Structured, append-only storage ideal for tabular or list data (e.g., scraped items).
- **Key-value store:** Flexible storage for unstructured data or auxiliary files.
${uiModeWorkflowRules}## Tool dependencies and disambiguation

### Tool dependencies
- \`${HelperTools.ACTOR_CALL}\`:
  - ${schemaToolHint}
  - Then call with proper input to execute the Actor
  - For MCP server Actors, use format "actorName:toolName" to call specific tools
  - Supports async execution via the \`async\` parameter:
  - When \`async: false\` or not provided (default when UI mode is disabled): Waits for completion and returns results immediately.
  - When \`async: true\` (enforced when UI mode is enabled): Starts the run and returns immediately with runId. The widget automatically displays and polls for updates - no further action needed.

### Tool disambiguation
- **${HelperTools.ACTOR_OUTPUT_GET} vs ${HelperTools.DATASET_GET_ITEMS}:**
  Use \`${HelperTools.ACTOR_OUTPUT_GET}\` for Actor run outputs and \`${HelperTools.DATASET_GET_ITEMS}\` for direct dataset access.
- **${HelperTools.STORE_SEARCH} vs ${HelperTools.ACTOR_GET_DETAILS}:**
  \`${HelperTools.STORE_SEARCH}\` finds Actors; \`${HelperTools.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.${internalToolsSection}
- **${HelperTools.STORE_SEARCH} vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs ${HelperTools.ACTOR_CALL}:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in Apify store.
`;
}
