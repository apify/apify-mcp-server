import { HelperTools } from '../const.js';
import type { ActorsMcpServerOptions, HelperTool, ToolBase, ToolEntry } from '../types.js';

/**
 * Defines the logical order of tools for listing.
 * Tools are ordered to follow a typical workflow:
 * 1. Discovery - Search for actors and documentation
 * 2. Details - Get information about specific actors
 * 3. Execution - Call actors
 * 4. Monitoring - Check run status and logs
 * 5. Output - Get results
 * 6. Documentation - Fetch full documentation
 * 7. Storage - Advanced data access
 * 8. Development - Dev tools
 * 9. Actor tools - Dynamically loaded actors (sorted alphabetically)
 * 10. UI-only tools - Internal tools for UI mode
 */
const TOOL_ORDER: ReadonlyArray<string> = [
    // Discovery phase - search for actors and docs
    HelperTools.STORE_SEARCH,           // search-actors
    HelperTools.DOCS_SEARCH,            // search-apify-docs

    // Actor details - get information about specific actors
    HelperTools.ACTOR_GET_DETAILS,      // fetch-actor-details

    // Actor execution - call and add actors
    HelperTools.ACTOR_CALL,             // call-actor
    HelperTools.ACTOR_ADD,              // add-actor (experimental)

    // Run monitoring - check run status and logs
    HelperTools.ACTOR_RUNS_GET,         // get-actor-run
    HelperTools.ACTOR_RUN_LIST_GET,     // get-actor-run-list
    HelperTools.ACTOR_RUNS_LOG,         // get-actor-log
    HelperTools.ACTOR_RUNS_ABORT,       // abort-actor-run

    // Output retrieval - get results
    HelperTools.ACTOR_OUTPUT_GET,       // get-actor-output

    // Documentation - fetch full docs
    HelperTools.DOCS_FETCH,             // fetch-apify-docs

    // Storage access - advanced data retrieval
    HelperTools.DATASET_GET,            // get-dataset
    HelperTools.DATASET_GET_ITEMS,      // get-dataset-items
    HelperTools.DATASET_SCHEMA_GET,     // get-dataset-schema
    HelperTools.DATASET_LIST_GET,       // get-dataset-list
    HelperTools.KEY_VALUE_STORE_GET,    // get-key-value-store
    HelperTools.KEY_VALUE_STORE_KEYS_GET,    // get-key-value-store-keys
    HelperTools.KEY_VALUE_STORE_RECORD_GET,  // get-key-value-store-record
    HelperTools.KEY_VALUE_STORE_LIST_GET,    // get-key-value-store-list

    // Development tools
    HelperTools.GET_HTML_SKELETON,      // get-html-skeleton

    // UI-only/internal tools come last
    HelperTools.STORE_SEARCH_INTERNAL,  // search-actors-internal
    HelperTools.ACTOR_GET_DETAILS_INTERNAL,  // fetch-actor-details-internal
];

// Create a map for O(1) lookup of tool order
const TOOL_ORDER_MAP = new Map(TOOL_ORDER.map((name, index) => [name, index]));

/**
 * Gets the sort priority for a tool.
 * Internal tools with defined order get their position (0-based).
 * Actor tools (type: 'actor' or 'actor-mcp') get a high value to sort them after internal tools.
 * Unknown internal tools get sorted before actor tools but after known tools.
 */
function getToolSortPriority(tool: ToolEntry): number {
    const orderIndex = TOOL_ORDER_MAP.get(tool.name);
    if (orderIndex !== undefined) {
        return orderIndex;
    }

    // Actor tools and actor-mcp tools come after all internal tools
    if (tool.type === 'actor' || tool.type === 'actor-mcp') {
        return TOOL_ORDER.length + 1000; // High value to sort after internal tools
    }

    // Unknown internal tools come after known internal tools but before actor tools
    return TOOL_ORDER.length + 500;
}

/**
 * Sorts tools in a logical order for better discoverability and workflow guidance.
 *
 * The sorting follows this priority:
 * 1. Internal tools in workflow order (search -> details -> call -> monitor -> output -> docs -> storage -> dev)
 * 2. Actor tools (type: 'actor' or 'actor-mcp') sorted alphabetically by name
 * 3. Unknown internal tools sorted alphabetically
 *
 * @param tools - Array of tool entries to sort
 * @returns New sorted array (original array is not modified)
 */
export function sortToolsForListing<T extends ToolEntry>(tools: T[]): T[] {
    return [...tools].sort((a, b) => {
        const priorityA = getToolSortPriority(a);
        const priorityB = getToolSortPriority(b);

        // If priorities differ, sort by priority
        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        // Same priority means they're in the same group (e.g., both actor tools)
        // Sort alphabetically within the group
        return a.name.localeCompare(b.name);
    });
}

type ToolPublicFieldOptions = {
    uiMode?: ActorsMcpServerOptions['uiMode'];
    filterOpenAiMeta?: boolean;
};

/**
 * Strips OpenAI specific metadata from the tool metadata. U
 * @param meta - The tool metadata.
 * @returns The tool metadata with OpenAI specific metadata stripped.
 */
function stripOpenAiMeta(meta?: ToolBase['_meta']) {
    if (!meta) return meta;

    const filteredEntries = Object.entries(meta)
        .filter(([key]) => !key.startsWith('openai/'));

    if (filteredEntries.length === 0) return undefined;

    return Object.fromEntries(filteredEntries);
}

/**
 * Returns a public version of the tool containing only fields that should be exposed publicly.
 * Used for the tools list request.
 */
export function getToolPublicFieldOnly(tool: ToolBase, options: ToolPublicFieldOptions = {}) {
    const { uiMode, filterOpenAiMeta = false } = options;
    const meta = filterOpenAiMeta && uiMode !== 'openai'
        ? stripOpenAiMeta(tool._meta)
        : tool._meta;

    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        icons: tool.icons,
        execution: tool.execution,
        _meta: meta,
    };
}

/**
 * Creates a deep copy of a tool entry, preserving functions like ajvValidate and call
 * while cloning all other properties to avoid shared state mutations.
 */
export function cloneToolEntry(toolEntry: ToolEntry): ToolEntry {
    // Store the original functions
    const originalAjvValidate = toolEntry.ajvValidate;
    const originalCall = toolEntry.type === 'internal' ? toolEntry.call : undefined;

    // Create a deep copy using JSON serialization (excluding functions)
    const cloned = JSON.parse(JSON.stringify(toolEntry, (key, value) => {
        if (key === 'ajvValidate' || key === 'call') return undefined;
        return value;
    })) as ToolEntry;

    // Restore the original functions
    cloned.ajvValidate = originalAjvValidate;
    if (toolEntry.type === 'internal' && originalCall) {
        (cloned as HelperTool).call = originalCall;
    }

    return cloned;
}
