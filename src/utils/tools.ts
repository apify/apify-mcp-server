import type { CallDiagnostics, HelperTool, ToolBase, ToolEntry, ToolInputSchema } from '../types.js';
import { SERVER_MODE, TOOL_TYPE } from '../types.js';
import { fixZodSchemaRequired } from './ajv.js';

/**
 * Returns the canonical full name for a tool.
 * For actor tools this is actorFullName (e.g. "apify/rag-web-browser"),
 * for all others it's the tool name.
 */
export function getToolFullName(tool: ToolEntry): string {
    switch (tool.type) {
        case TOOL_TYPE.ACTOR:
            return tool.actorFullName;
        case TOOL_TYPE.INTERNAL:
        case TOOL_TYPE.ACTOR_MCP:
            return tool.name;
        default:
            return (tool satisfies never as ToolEntry).name;
    }
}

/**
 * Extract stable Actor ID for telemetry.
 * Available for actor and actor-mcp tools; undefined for internal tools.
 */
export function extractActorId(tool: ToolEntry): string | undefined {
    if (tool.type === TOOL_TYPE.ACTOR || tool.type === TOOL_TYPE.ACTOR_MCP) return tool.actorId;
    return undefined;
}

/**
 * Build actor identification fields for failure telemetry.
 */
export function buildActorFields(
    actorName?: string,
    actorId?: string,
): Pick<CallDiagnostics, 'actor_name' | 'actor_id'> {
    return {
        ...(actorName ? { actor_name: actorName } : {}),
        ...(actorId ? { actor_id: actorId } : {}),
    };
}

/**
 * Extract actor name for telemetry from the tool entry or call-actor args.
 * For actor tools, read from the tool entry. For call-actor, parse from the `actor` arg.
 * Returns undefined for other internal tools or when the arg is missing/invalid.
 */
export function extractActorName(tool: ToolEntry, args?: Record<string, unknown>): string | undefined {
    if (tool.type === TOOL_TYPE.ACTOR) return tool.actorFullName;
    if (tool.type === TOOL_TYPE.ACTOR_MCP) return tool.actorId;

    // For call-actor, the actor name is in `args.actor`.
    // The format can be "username/name" or "username/name:toolName" (MCP server Actors).
    // Strip the optional `:toolName` suffix to get the base actor name.
    const actorArg = args?.actor;
    if (typeof actorArg !== 'string') return undefined;
    return actorArg.split(':')[0]?.trim() || undefined;
}

type ToolPublicFieldOptions = {
    mode?: SERVER_MODE;
    filterWidgetMeta?: boolean;
};

/**
 * Strips widget-specific metadata (openai/* and ui keys) from tool metadata.
 * Used to hide widget metadata in non-apps modes.
 */
function stripWidgetMeta(meta?: ToolBase['_meta']) {
    if (!meta) return meta;

    const filteredEntries = Object.entries(meta).filter(
        ([key]) => !key.startsWith('openai/') && key !== 'ui' && key !== 'ui/resourceUri',
    );

    if (filteredEntries.length === 0) return undefined;

    return Object.fromEntries(filteredEntries);
}

/**
 * Zod 4's z.toJSONSchema() lists properties with `.default()` in `required`.
 * Clients treat that as mandatory arguments; strip them before tools/list.
 */
function fixZodInputSchemaRequired(inputSchema: ToolBase['inputSchema']): ToolBase['inputSchema'] {
    if (!inputSchema || typeof inputSchema !== 'object') return inputSchema;
    return fixZodSchemaRequired({ ...inputSchema } as Record<string, unknown>) as ToolInputSchema;
}

/**
 * Returns a public version of the tool containing only fields that should be exposed publicly.
 * Used for the tools list request.
 */
export function getToolPublicFieldOnly(tool: ToolBase, options: ToolPublicFieldOptions = {}) {
    const { mode, filterWidgetMeta = false } = options;
    const meta = filterWidgetMeta && mode !== SERVER_MODE.APPS ? stripWidgetMeta(tool._meta) : tool._meta;

    return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: fixZodInputSchemaRequired(tool.inputSchema),
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
    const originalCall = toolEntry.type === TOOL_TYPE.INTERNAL ? toolEntry.call : undefined;

    // Create a deep copy using JSON serialization (excluding functions)
    const cloned = JSON.parse(
        JSON.stringify(toolEntry, (key, value) => {
            if (key === 'ajvValidate' || key === 'call') return undefined;
            return value;
        }),
    ) as ToolEntry;

    // Restore the original functions
    cloned.ajvValidate = originalAjvValidate;
    if (toolEntry.type === TOOL_TYPE.INTERNAL && originalCall) {
        (cloned as HelperTool).call = originalCall;
    }

    return cloned;
}
