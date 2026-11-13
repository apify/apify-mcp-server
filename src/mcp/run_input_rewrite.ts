/**
 * Accepts Actor run input on the web-fetch and rag-web-browser Server Actor tools. Before 0.21 these tools ran the
 * Actor and took its run input (`{url, formats, …}`, `{query, maxResults, …}`); now they send a server request
 * (`{method, path, query}`). Clients with a cached pre-0.21 tool list still send run input.
 *
 * Also serves the removed default `apify--rag-web-browser` to clients that still call it (`loadReplacedDefaultTool`).
 *
 * To switch off the input rewrite, empty `SERVER_PATHS_FOR_RUN_INPUT`; to stop serving the removed tool, empty
 * `REPLACED_DEFAULT_ACTORS`. To remove once the "Rewrote pre-0.21 tool arguments" and "Served the replaced default
 * tool" logs stop, delete this file and its calls in `tool_call_engine.ts`.
 */
import log from '@apify/log';

import type { REQUEST_ORIGIN } from '../apify_client.js';
import { ApifyClient } from '../apify_client.js';
import { HELPER_TOOLS, RAG_WEB_BROWSER, WEB_FETCH } from '../const.js';
import { ACTOR_LOAD_ERROR_KIND } from '../errors.js';
import { actorNameToToolName, legacyToolNameToNew } from '../tools/actor_tool_naming.js';
import { getActorToolPolicy } from '../tools/actors/actor_tool_contract.js';
import { getActorsAsTools } from '../tools/actors/actor_tools_factory.js';
import { isRecord } from '../tools/api/apify_api_spec.js';
import type { ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';
import { resolveToolNamesFromInput } from '../utils/tools_loader.js';

/** Removed default Actors still served to clients that call them; 0.21.0 replaced them with `apify/web-search`. */
const REPLACED_DEFAULT_ACTORS: readonly string[] = [RAG_WEB_BROWSER];

/**
 * The Server Actor tool of a removed default Actor that `name` calls, in a session that serves every default tool, so
 * an explicit `?tools=`/`?actors=` selection gets no tool it did not ask for. The tool is not added to the session's
 * tool list. Throws a load failure other than not found, so it is not reported as an unknown tool.
 */
export async function loadReplacedDefaultTool(params: {
    name: string;
    tools: Map<string, ToolEntry>;
    apifyToken: string;
    requestOrigin: REQUEST_ORIGIN;
    mcpSessionId: string | undefined;
}): Promise<ToolEntry | undefined> {
    const { name, tools, apifyToken, requestOrigin, mcpSessionId } = params;
    const toolName = legacyToolNameToNew(name) ?? name;
    const actorName = REPLACED_DEFAULT_ACTORS.find((removed) => actorNameToToolName(removed) === toolName);
    if (!actorName || !servesDefaultTools(tools)) return undefined;

    const apifyClient = new ApifyClient({ token: apifyToken, requestOrigin });
    const loaded = await getActorsAsTools([actorName], apifyClient, { mcpSessionId });
    const [loadError] = loaded.errors;
    // An MCP-server Actor that loaded without some of its tools has both tools and an error.
    if (loaded.tools.length === 0 && loadError && loadError.kind !== ACTOR_LOAD_ERROR_KIND.NOT_FOUND) throw loadError;
    // An Actor served as an MCP server loads as tools with other names.
    const tool = loaded.tools.find((entry) => entry.name === toolName);
    if (tool) log.info('Served the replaced default tool', { toolName: name, mcpSessionId });
    return tool;
}

/** Whether the session serves every default tool. `report-problem` is left out: telemetry settings decide it. */
function servesDefaultTools(tools: Map<string, ToolEntry>): boolean {
    return [...resolveToolNamesFromInput({})].every((name) => name === HELPER_TOOLS.PROBLEM_REPORT || tools.has(name));
}

/** The server path that takes the same fields as the Actor's run input, sent as `GET` with that input as `query`. */
const SERVER_PATHS_FOR_RUN_INPUT: Readonly<Record<string, string>> = {
    [WEB_FETCH]: '/',
    [RAG_WEB_BROWSER]: '/search',
};

/**
 * Rewrites run input (neither `method` nor `path`, no object `query`, and some input besides `waitSecs`) to the
 * server request `{method: 'GET', path, query}`, with a note for the result. Returns a new object: `args` can be the
 * decoded arguments that telemetry reads.
 */
export function rewriteRunInputAsServerRequest(params: {
    tool: ToolEntry;
    args: Record<string, unknown>;
    argKeys: string;
    mcpSessionId: string | undefined;
}): { args: Record<string, unknown>; note: string } | undefined {
    const { tool, args } = params;
    if (tool.type !== TOOL_TYPE.ACTOR_SERVER) return undefined;
    const path = SERVER_PATHS_FOR_RUN_INPUT[tool.actorFullName];
    // An object `query` is the current input without `path`; the run input's `query` is a string.
    if (!path || 'method' in args || 'path' in args || isRecord(args.query)) return undefined;
    // `waitSecs` was the run tool's wait cap, not an Actor input.
    const { waitSecs: _waitSecs, ...query } = args;
    if (!Object.keys(query).length) return undefined;

    log.info('Rewrote pre-0.21 tool arguments', {
        toolName: tool.name,
        mcpSessionId: params.mcpSessionId,
        argKeys: params.argKeys,
    });
    const exampleCall = getActorToolPolicy(tool.actorFullName)?.serverTool?.exampleCall;
    return {
        args: { method: 'GET', path, query },
        note:
            `These arguments are run input, sent as GET ${path} with the arguments as query. This tool takes a ` +
            `server request {method, path, query}, for example: ${exampleCall}`,
    };
}

/** Appends the compatibility note (a replaced tool name, rewritten run input) to the result's `content`. */
export function addCompatibilityNote(
    result: Record<string, unknown>,
    note: string | undefined,
): Record<string, unknown> {
    if (!note) return result;
    return { ...result, content: [...((result.content as unknown[] | undefined) ?? []), { type: 'text', text: note }] };
}
