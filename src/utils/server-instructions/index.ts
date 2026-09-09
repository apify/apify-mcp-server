/**
 * Server instructions — mode-aware text served to clients.
 *
 * Widget-related sections render only when the specific widget they name is actually in this
 * session's tools/list — never from apps mode alone, never from the base tool's presence alone.
 * Widget pairing with a base tool is optional (see `WIDGET_BY_BASE_TOOL` in `tools/registry.ts`):
 * a widget can be loaded standalone via explicit `?tools=`, so every clause here is gated on the
 * exact tool name it mentions.
 */

import { getApifyAPIBaseUrl } from '../../apify_client.js';
import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../../const.js';
import { actorNameToToolName } from '../../tools/actor_tool_naming.js';
import type { ToolDescriptionContext } from '../../types.js';
import { ALL_TOOLS_PRESENT, SERVER_MODE } from '../../types.js';

// hasTool checks registered tool names, not Actor full names — see call_actor.ts's RAG_WEB_BROWSER_TOOL.
const RAG_WEB_BROWSER_TOOL = actorNameToToolName(RAG_WEB_BROWSER);
const WEB_FETCH_TOOL = actorNameToToolName(WEB_FETCH);

const asCodeList = (names: string[]): string => names.map((n) => `\`${n}\``).join(' or ');

/**
 * Apps-mode widget workflow section. call-actor-widget/get-actor-run-widget are not auto-paired
 * with their base tool, so every name is gated on its own presence. Empty when there is nothing
 * actionable to say (e.g. call-actor-widget alone).
 */
function buildWidgetWorkflowSection({
    hasCall,
    hasRunsGet,
    hasCallWidget,
    hasRunsGetWidget,
}: Record<'hasCall' | 'hasRunsGet' | 'hasCallWidget' | 'hasRunsGetWidget', boolean>): string {
    const renderers: string[] = [];
    if (hasCallWidget) renderers.push(HELPER_TOOLS.ACTOR_CALL_WIDGET);
    if (hasRunsGetWidget) renderers.push(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    const dontCallAgain: string[] = [];
    if (hasRunsGet) dontCallAgain.push(HELPER_TOOLS.ACTOR_RUNS_GET);
    if (hasRunsGetWidget) dontCallAgain.push(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);
    if (renderers.length === 0) return '';

    const pollsItself =
        renderers.length > 1
            ? 'Both widgets render live progress and poll themselves'
            : 'It renders live progress and polls itself';
    const dupWarning =
        dontCallAgain.length > 0
            ? `- **After ${asCodeList(renderers)}, never call ${asCodeList(dontCallAgain)} for the same run.** ${pollsItself} — stop after the widget response and defer to it for run status.${hasRunsGetWidget ? ` Re-rendering the same run via \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` is a duplicate.` : ''}\n`
            : '';
    const pollOkLine =
        hasCall && hasRunsGet
            ? `- Polling \`${HELPER_TOOLS.ACTOR_RUNS_GET}\` after \`${HELPER_TOOLS.ACTOR_CALL}\` is fine — that tool renders no UI, so polling is expected when the run is non-terminal and you need the latest status.\n`
            : '';
    if (dupWarning === '' && pollOkLine === '') return '';

    return `
## Widget workflow (applies when tool responses include widget metadata)
Some clients render widget-backed Actor tools: the response includes a live UI that automatically polls run status. When a widget is rendered, follow-up status polling by the model is a forbidden duplicate.

${dupWarning}${pollOkLine}`;
}

/** Every cross-tool mention gates on `ctx.hasTool(...)`, so a session missing a tool is never told to call it. */
export function getServerInstructions(
    mode: SERVER_MODE = SERVER_MODE.DEFAULT,
    { hasTool }: ToolDescriptionContext = ALL_TOOLS_PRESENT,
): string {
    const isApps = mode === SERVER_MODE.APPS;
    // Derive the API base from config so examples match the gate/templates under an
    // APIFY_API_BASE_URL / staging override, instead of a hardcoded api.apify.com.
    const apiBaseUrl = getApifyAPIBaseUrl();

    const hasSearch = hasTool(HELPER_TOOLS.STORE_SEARCH);
    const hasDetails = hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS);
    const hasCall = hasTool(HELPER_TOOLS.ACTOR_CALL);
    const hasRunsGet = hasTool(HELPER_TOOLS.ACTOR_RUNS_GET);
    const hasCallWidget = hasTool(HELPER_TOOLS.ACTOR_CALL_WIDGET);
    const hasRunsGetWidget = hasTool(HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET);

    const widgetWorkflowSection = isApps
        ? buildWidgetWorkflowSection({ hasCall, hasRunsGet, hasCallWidget, hasRunsGetWidget })
        : '';

    const toolDependencies = hasCall
        ? `### Tool dependencies
- \`${HELPER_TOOLS.ACTOR_CALL}\`:
  - ${hasDetails ? `Use \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` first to obtain the Actor's input schema.` : `Check the Actor's input schema first.`}
  - Then call with proper input to execute the Actor.
  - For MCP server Actors, use format "actorName:toolName" to call specific tools.
  - Supports a \`waitSecs\` parameter (default 30, max 45):
    - \`waitSecs: 0\`: fire-and-forget — starts the run and returns immediately with a runId.
    - \`waitSecs > 0\`: waits up to that many seconds for the run to complete, then returns its current status and storage IDs (never the output rows — fetch those with \`${HELPER_TOOLS.DATASET_GET_ITEMS}\`).
`
        : '';

    // Compares both when loaded; names whichever one is loaded alone otherwise.
    const searchVsDetailsDisambiguation =
        hasSearch && hasDetails
            ? `### Tool disambiguation
- **\`${HELPER_TOOLS.STORE_SEARCH}\` vs \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\`:**
  \`${HELPER_TOOLS.STORE_SEARCH}\` finds Actors; \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
`
            : hasSearch
              ? `### Tool disambiguation
- \`${HELPER_TOOLS.STORE_SEARCH}\` finds Actors by keyword.
`
              : hasDetails
                ? `### Tool disambiguation
- \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` retrieves detailed info, README, and schema for a specific Actor.
`
                : '';

    // search-actors/fetch-actor-details auto-pair with their widget, so require both before
    // comparing them. call-actor/get-actor-run don't auto-pair, so their bullets render from the
    // widget alone, standalone-worded.
    const hasSearchPair = hasSearch && hasTool(HELPER_TOOLS.STORE_SEARCH_WIDGET);
    const hasDetailsPair = hasDetails && hasTool(HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET);
    const widgetBullets = [
        hasSearchPair
            ? `  - \`${HELPER_TOOLS.STORE_SEARCH}\` is a silent data lookup (Actor list for name resolution) with no UI; \`${HELPER_TOOLS.STORE_SEARCH_WIDGET}\` renders an interactive UI element (widget) with Actor search results for the user to browse — use it only when the user explicitly asks to search or discover Actors.\n`
            : '',
        hasDetailsPair
            ? `  - \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\` is a silent data lookup (input schema, README, metadata) with no UI; \`${HELPER_TOOLS.ACTOR_GET_DETAILS_WIDGET}\` renders an interactive UI element (widget) with Actor details — use it only when the user explicitly asks to see or browse the Actor.\n`
            : '',
        hasCallWidget
            ? hasCall
                ? `  - \`${HELPER_TOOLS.ACTOR_CALL}\` runs the Actor and returns its run status and storage IDs (no UI); \`${HELPER_TOOLS.ACTOR_CALL_WIDGET}\` renders an interactive UI element (widget) that tracks live Actor run progress — use it only when the user explicitly asks to see progress.\n`
                : `  - \`${HELPER_TOOLS.ACTOR_CALL_WIDGET}\` renders an interactive UI element (widget) that starts an Actor run and tracks its live progress — use it only when the user explicitly asks to see progress.\n`
            : '',
        hasRunsGetWidget
            ? hasRunsGet
                ? `  - \`${HELPER_TOOLS.ACTOR_RUNS_GET}\` is a silent data lookup (run status, dataset IDs, stats) with no UI; \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` renders an interactive UI element (widget) showing live run progress for the user — use it only when the user explicitly asks to see run progress.\n`
                : `  - \`${HELPER_TOOLS.ACTOR_RUNS_GET_WIDGET}\` renders an interactive UI element (widget) showing live run progress for the user — use it only when the user explicitly asks to see run progress.\n`
            : '',
        hasSearchPair && hasDetailsPair
            ? `  - When the next step is running an Actor, prefer silent lookups (\`${HELPER_TOOLS.STORE_SEARCH}\`, \`${HELPER_TOOLS.ACTOR_GET_DETAILS}\`) over widget-backed variants.\n`
            : '',
    ].join('');
    const widgetToolDisambiguation =
        isApps && widgetBullets !== ''
            ? `- **Data vs widget Actor tools (when the client supports widgets):**\n${widgetBullets}`
            : '';

    const searchVsRagWebBrowser =
        hasSearch && hasTool(RAG_WEB_BROWSER_TOOL)
            ? `- **\`${HELPER_TOOLS.STORE_SEARCH}\` vs ${RAG_WEB_BROWSER}:**
  \`${HELPER_TOOLS.STORE_SEARCH}\` finds robust and reliable Actors for specific websites; ${RAG_WEB_BROWSER} is a general and versatile web scraping tool.
`
            : '';

    const webFetchVsRagWebBrowser =
        hasTool(WEB_FETCH_TOOL) && hasTool(RAG_WEB_BROWSER_TOOL)
            ? `- **${WEB_FETCH} vs ${RAG_WEB_BROWSER}:**
  ${WEB_FETCH} fetches one specific URL and returns its full content verbatim; ${RAG_WEB_BROWSER} searches the web by query and returns content from the top results.
`
            : '';

    const dedicatedToolsVsCallActor = hasCall
        ? `- **Dedicated Actor tools${hasTool(RAG_WEB_BROWSER_TOOL) ? ` (e.g. ${RAG_WEB_BROWSER})` : ''} vs \`${HELPER_TOOLS.ACTOR_CALL}\`:**
  Prefer dedicated tools when available; use \`${HELPER_TOOLS.ACTOR_CALL}\` only when no specialized tool exists in the Apify store.
`
        : '';

    /** Renders only if a subsection survives gating, to avoid a bare heading; `###` subsections get a blank line before them, bullets stay contiguous. */
    const renderedBlocks = [
        toolDependencies,
        searchVsDetailsDisambiguation,
        widgetToolDisambiguation,
        searchVsRagWebBrowser,
        webFetchVsRagWebBrowser,
        dedicatedToolsVsCallActor,
    ].filter((block) => block !== '');

    const dependenciesAndDisambiguation =
        renderedBlocks.length === 0
            ? ''
            : `
## Tool dependencies and disambiguation

${renderedBlocks.map((block, index) => (index > 0 && block.startsWith('###') ? `\n${block}` : block)).join('')}`;

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

## Actor tasks
- An Actor task is a saved, reusable configuration of an Actor. It stores the Actor input and run options such as the build, memory, and timeout.
- Tasks are useful for repeated or scheduled jobs, because the user does not have to configure the Actor again for every run.
- Creating or updating a task does not make it public.
- Publishing a task creates a public landing page for one specific use case. The page shows what the task does, the selected input values, and the expected output. Published tasks appear in the Actor's Examples tab, where users, search engines, and AI agents can discover them, which can help people understand the Actor and increase its runs.
- Publish only tasks that represent a useful, reliable, and specific use case. Not every saved task needs to be public.

## Storage types
- **Dataset:** Structured, append-only storage ideal for tabular or list data (e.g., scraped items).
- **Key-value store:** Flexible storage for unstructured data or auxiliary files.

## Apify API resources
- Any Apify API GET endpoint can be read as an MCP resource. Pass the full \`${apiBaseUrl}/v2/...\` URL to \`resources/read\`; the server injects the session's Apify token and returns the response body. Reads require an Apify token — a session without one (e.g. payment-only x402/Skyfire) fails with a JSON-RPC error.
- Actor and tool results return storage IDs, not resource URLs — build the URL from the ID (e.g. a \`datasetId\` becomes \`${apiBaseUrl}/v2/datasets/{datasetId}/items\`) and read it via \`resources/read\`.
- Reads inline up to ~256 KB; a larger response is not downloaded — it returns a short notice with a download URL instead of the body, so page large datasets/lists with \`limit\` and \`offset\` to stay under the cap.
- Examples: \`${apiBaseUrl}/v2/datasets/{datasetId}/items?clean=true&format=json&limit=100\`, \`${apiBaseUrl}/v2/key-value-stores/{storeId}/records/{recordKey}\`. \`resources/templates/list\` enumerates the common shapes with their paging parameters.
${widgetWorkflowSection}${dependenciesAndDisambiguation}${
        hasTool(HELPER_TOOLS.PROBLEM_REPORT)
            ? `
If a tool or Actor fails and you cannot resolve it, you can report it with \`${HELPER_TOOLS.PROBLEM_REPORT}\`.
`
            : ''
    }`;
}
