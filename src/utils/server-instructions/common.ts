/**
 * Shared server instructions — mode-independent content about Actors, discovery,
 * execution workflow, storage, and tool disambiguation.
 */

import { HelperTools, RAG_WEB_BROWSER } from '../../const.js';

type CommonInstructionsInput = {
    /** Mode-specific hint for which tool to use to obtain the Actor's input schema. */
    schemaToolHint: string;
    /** Mode-specific workflow rules inserted before the tool dependencies section. */
    workflowRules: string;
    /** Mode-specific tool disambiguation content appended to the disambiguation section. */
    toolDisambiguation: string;
};

/**
 * Returns the common server instructions shared across all modes.
 * Mode-specific content is injected via the input object at designated insertion points.
 */
export function getCommonInstructions(input: CommonInstructionsInput): string {
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
${input.workflowRules}## Tool dependencies and disambiguation

### Tool dependencies
- \`${HelperTools.ACTOR_CALL}\`:
  - ${input.schemaToolHint}
  - Then call with proper input to execute the Actor
  - For MCP server Actors, use format "actorName:toolName" to call specific tools
  - Supports async execution via the \`async\` parameter:
  - When \`async: false\` or not provided (default when UI mode is disabled): Waits for completion and returns results immediately.
  - When \`async: true\` (enforced when UI mode is enabled): Starts the run and returns immediately with runId. The widget automatically displays and polls for updates - no further action needed.

### Tool disambiguation
- **${HelperTools.ACTOR_OUTPUT_GET} vs ${HelperTools.DATASET_GET_ITEMS}:**
  Use \`${HelperTools.ACTOR_OUTPUT_GET}\` for Actor run outputs and \`${HelperTools.DATASET_GET_ITEMS}\` for direct dataset access.
- **${HelperTools.STORE_SEARCH} vs ${HelperTools.ACTOR_GET_DETAILS}:**
  \`${HelperTools.STORE_SEARCH}\` finds Actors; \`${HelperTools.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.${input.toolDisambiguation}
- **${HelperTools.STORE_SEARCH} vs ${RAG_WEB_BROWSER}:**
  \`${HelperTools.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
- **Dedicated Actor tools (e.g. ${RAG_WEB_BROWSER}) vs ${HelperTools.ACTOR_CALL}:**
  Prefer dedicated tools when available; use \`${HelperTools.ACTOR_CALL}\` only when no specialized tool exists in Apify store.
`;
}
