/**
 * Accepts Actor run input on the web-fetch and rag-web-browser Server Actor tools. Before 0.21 these tools ran the
 * Actor and took its run input (`{url, formats, …}`, `{query, maxResults, …}`); now they send a server request
 * (`{method, path, query}`). Clients with a cached pre-0.21 tool list still send run input (apify/ai-team#346).
 *
 * To disable, empty `SERVER_PATHS_FOR_RUN_INPUT`. To remove once the "Rewrote pre-0.21 tool arguments" log stops,
 * delete this file and its calls in `tool_call_engine.ts`.
 */
import log from '@apify/log';

import { RAG_WEB_BROWSER, WEB_FETCH } from '../const.js';
import { getActorToolPolicy } from '../tools/actors/actor_tool_contract.js';
import type { ToolEntry } from '../types.js';
import { TOOL_TYPE } from '../types.js';

/** The server path that takes the same fields as the Actor's run input, sent as `GET` with that input as `query`. */
const SERVER_PATHS_FOR_RUN_INPUT: Readonly<Record<string, string>> = {
    [WEB_FETCH]: '/',
    [RAG_WEB_BROWSER]: '/search',
};

/**
 * Rewrites run input (neither `method` nor `path`, and some input besides `waitSecs`) to the server request
 * `{method: 'GET', path, query}`, with a note for the result. Returns a new object: `args` can be the decoded
 * arguments that telemetry reads.
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
    if (!path || 'method' in args || 'path' in args) return undefined;
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
            `These arguments are the pre-0.21 input of this tool. They were sent as GET ${path} with the ` +
            `arguments as query. The current input is {method, path, query}, for example: ${exampleCall}`,
    };
}

/** Appends the note from `rewriteRunInputAsServerRequest` to the result's `content`. */
export function addRunInputNote(result: Record<string, unknown>, note: string | undefined): Record<string, unknown> {
    if (!note) return result;
    return { ...result, content: [...((result.content as unknown[] | undefined) ?? []), { type: 'text', text: note }] };
}
