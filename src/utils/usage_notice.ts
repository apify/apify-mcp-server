import { createHash } from 'node:crypto';

import log from '@apify/log';

import { type ApifyClient, getApifyAPIBaseUrl, sendApifyApiRequest } from '../apify_client.js';
import { HELPER_TOOLS } from '../const.js';
import type { McpClientContext } from '../mcp/client_context.js';
import { TOOL_TYPE, type ToolEntry } from '../types.js';
import { getToolFullName } from './tools.js';
import { TTLLRUCache } from './ttl_lru.js';

// Warns the agent when the account nears its monthly usage limit, so it tells the user while they can still upgrade
// or raise the limit. The Apify API decides who gets the warning (an experiment) and returns its text.

/** Returns the notice for this account, or null. It uses up the notice it returns, so it is asked once the result is ready. */
const USAGE_NOTICE_PATH = '/unstable/users/me/usage-notice';

/** Tool types whose every call runs an Actor. */
const ACTOR_RUNNING_TOOL_TYPES = new Set<string>([TOOL_TYPE.ACTOR, TOOL_TYPE.ACTOR_MCP]);

/** Internal tools that run an Actor. */
const ACTOR_RUNNING_INTERNAL_TOOLS = new Set<string>([
    HELPER_TOOLS.ACTOR_CALL,
    HELPER_TOOLS.ACTOR_CALL_WIDGET,
    HELPER_TOOLS.ACTOR_MCP_TOOL_CALL,
]);

/** How many tokens' "no notice" answers are cached at once. */
const NO_NOTICE_CACHE_MAX_SIZE = 200;
/** How long a token that got no notice is not asked again. */
const NO_NOTICE_CACHE_TTL_SECS = 5 * 60;
/** How long a finished tool call waits for the notice; after that it returns without one. */
const USAGE_NOTICE_TIMEOUT_MS = 2_000;

export type UsageNoticeOptions = {
    mcpClientName: string;
};

/** What {@link appendUsageNotice} needs to ask for the notice after a tool call that runs an Actor. */
export type UsageCheck = UsageNoticeOptions & {
    apifyToken: string;
    apifyClient: ApifyClient;
    toolName: string;
    signal: AbortSignal;
};

const noNoticeCache = new TTLLRUCache<true>(NO_NOTICE_CACHE_MAX_SIZE, NO_NOTICE_CACHE_TTL_SECS);

/**
 * The usage notice options for one request. Undefined when telemetry is off: the API logs the experiment exposure and
 * an analytics event for every notice it decides.
 */
export function getUsageNoticeOptions(
    host: { telemetryEnabled: boolean },
    clientContext: McpClientContext | undefined,
): UsageNoticeOptions | undefined {
    if (!host.telemetryEnabled) return undefined;
    return { mcpClientName: clientContext?.clientInfo?.name ?? '' };
}

/**
 * The usage check for a tool call that runs an Actor: `call-actor`, an Actor tool or an Actor-MCP tool. Null when there
 * are no options (telemetry off), no token, or another tool, Actor server tools and `send-server-actor-request` included.
 */
export function prepareUsageCheck(params: {
    options: UsageNoticeOptions | undefined;
    tool: ToolEntry;
    apifyToken: string | undefined;
    apifyClient: ApifyClient;
    signal: AbortSignal;
}): UsageCheck | null {
    const { options, tool, apifyToken, apifyClient, signal } = params;
    if (!options || !apifyToken) return null;
    if (!ACTOR_RUNNING_TOOL_TYPES.has(tool.type) && !ACTOR_RUNNING_INTERNAL_TOOLS.has(tool.name)) return null;
    return { ...options, apifyToken, apifyClient, toolName: getToolFullName(tool), signal };
}

/** The notice text from the endpoint's `{ data: { notice } }` response, or null. */
function readNotice(response: { status: number; data: unknown }): string | null {
    if (response.status !== 200) return null;
    const notice = (response.data as { data?: { notice?: unknown } } | undefined)?.data?.notice;
    return typeof notice === 'string' && notice ? notice : null;
}

/**
 * Asks the API for the usage notice and appends it as the last content item. A "no notice" answer, including a refusal
 * such as a scoped token's 403, is cached per token for {@link NO_NOTICE_CACHE_TTL_SECS}. Any failure returns the
 * result unchanged.
 */
export async function appendUsageNotice(
    result: Record<string, unknown>,
    check: UsageCheck | null,
): Promise<Record<string, unknown>> {
    if (!check) return result;
    const content = (result.content as { type?: unknown }[] | undefined) ?? [];
    // Without a text item, the SDK adds non-object structured content as text, and an added notice would stop that.
    if (!content.some((item) => item.type === 'text')) return result;
    // A cancelled call's result reaches no one, so it must not use up the notice.
    if (check.signal.aborted) return result;
    const tokenHash = createHash('sha256').update(check.apifyToken).digest('hex');
    if (noNoticeCache.get(tokenHash)) return result;

    try {
        const response = await sendApifyApiRequest(check.apifyClient, {
            url: `${getApifyAPIBaseUrl()}${USAGE_NOTICE_PATH}`,
            method: 'POST',
            data: { toolName: check.toolName, mcpClientName: check.mcpClientName },
            signal: AbortSignal.timeout(USAGE_NOTICE_TIMEOUT_MS),
        });
        const notice = readNotice(response);
        if (!notice) {
            noNoticeCache.set(tokenHash, true);
            return result;
        }
        return { ...result, content: [...content, { type: 'text', text: notice }] };
    } catch (error) {
        log.softFail('Failed to get the usage notice', {
            errMessage: error instanceof Error ? error.message : String(error),
        });
        return result;
    }
}
