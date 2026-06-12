import type { ApifyClient } from '../apify_client.js';
import { CONSOLE_BASE_URL, CONSOLE_BASE_URL_STAGING, STAGING_MCP_HOSTNAME } from '../const.js';
import type { ConsoleLinkContext } from '../types.js';
import { getUserInfoCached } from './userid_cache.js';

/** Console origin for the current cluster: staging when on the staging MCP host, production otherwise. */
function getConsoleBaseUrl(): string {
    return process.env.HOSTNAME === STAGING_MCP_HOSTNAME ? CONSOLE_BASE_URL_STAGING : CONSOLE_BASE_URL;
}

/** Prefix of Apify Console UI (session) tokens, as opposed to `apify_api_...` API tokens. */
const UI_TOKEN_PREFIX = 'apify_ui_';

// Console links are personalized — models otherwise tend to "correct" them to
// the public apify.com URLs they know from training data.
export const VERBATIM_LINKS_NUDGE =
    'IMPORTANT: Present the URLs exactly as returned in this result, verbatim. Never construct Apify URLs yourself.';

/**
 * Resolves the Console link context for a request, or `undefined` when public
 * website links should be used.
 *
 * Policy (apify/apify-core#27286): UI tokens are issued only to Console sessions
 * (e.g. the Console AI chat), so they are a verifiable signal that the user is in
 * Console → Console links. All other sessions → public `apify.com` links.
 *
 * Non-UI tokens short-circuit without an API call. For UI tokens the cached
 * `users/me` lookup resolves the acting account; an organization-scoped token
 * resolves to the organization itself, which yields org-prefixed links.
 */
export async function getConsoleLinkContext(
    apifyToken: string | undefined,
    apifyClient: ApifyClient,
): Promise<ConsoleLinkContext | undefined> {
    if (!apifyToken?.startsWith(UI_TOKEN_PREFIX)) return undefined;
    const userInfo = await getUserInfoCached(apifyToken, apifyClient);
    return { organizationId: userInfo.isOrganization && userInfo.userId ? userInfo.userId : undefined };
}

/**
 * Builds `<consoleBaseUrl>[/organization/<orgId>]<path>`.
 * Accepts an undefined context (non-Console session) and returns undefined, so
 * call sites can pass the resolved context straight through without a ternary.
 */
function buildConsoleUrl(context: ConsoleLinkContext | undefined, path: string): string | undefined {
    if (!context) return undefined;
    const orgPrefix = context.organizationId ? `/organization/${context.organizationId}` : '';
    return `${getConsoleBaseUrl()}${orgPrefix}${path}`;
}

/** Builds the Console Actor detail URL: `<consoleBaseUrl>[/organization/<orgId>]/actors/<actorId>`. */
export function buildConsoleActorUrl(context: ConsoleLinkContext | undefined, actorId: string): string | undefined {
    return buildConsoleUrl(context, `/actors/${actorId}`);
}

/** Builds the Console run detail URL: `<consoleBaseUrl>[/organization/<orgId>]/actors/runs/<runId>`. */
export function buildConsoleRunUrl(context: ConsoleLinkContext | undefined, runId: string): string | undefined {
    return buildConsoleUrl(context, `/actors/runs/${runId}`);
}

/** Builds the Console dataset URL: `<consoleBaseUrl>[/organization/<orgId>]/storage/datasets/<datasetId>`. */
export function buildConsoleDatasetUrl(context: ConsoleLinkContext | undefined, datasetId: string): string | undefined {
    return buildConsoleUrl(context, `/storage/datasets/${datasetId}`);
}

/** Builds the Console key-value store URL: `<consoleBaseUrl>[/organization/<orgId>]/storage/key-value-stores/<storeId>`. */
export function buildConsoleKeyValueStoreUrl(
    context: ConsoleLinkContext | undefined,
    storeId: string,
): string | undefined {
    return buildConsoleUrl(context, `/storage/key-value-stores/${storeId}`);
}
