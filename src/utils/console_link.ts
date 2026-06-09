import type { ApifyClient } from '../apify_client.js';
import { CONSOLE_BASE_URL } from '../const.js';
import type { ConsoleLinkContext } from '../types.js';
import { type CachedUserInfo, getUserInfoCached } from './userid_cache.js';

/** Prefix of Apify Console UI (session) tokens, as opposed to `apify_api_...` API tokens. */
const UI_TOKEN_PREFIX = 'apify_ui_';

/** True when the request is authenticated with a Console UI (session) token. */
export function isConsoleUiToken(apifyToken: string | undefined): boolean {
    return Boolean(apifyToken?.startsWith(UI_TOKEN_PREFIX));
}

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
 * For an organization-scoped token the `users/me` lookup resolves to the
 * organization itself, which yields org-prefixed links.
 */
export function resolveConsoleLinkContext(
    apifyToken: string | undefined,
    userInfo: CachedUserInfo,
): ConsoleLinkContext | undefined {
    if (!isConsoleUiToken(apifyToken)) return undefined;
    return {
        consoleBaseUrl: process.env.CONSOLE_BASE_URL || CONSOLE_BASE_URL,
        organizationId: userInfo.isOrganization && userInfo.userId ? userInfo.userId : undefined,
    };
}

/**
 * Resolves the Console link context straight from the request token: `undefined`
 * for non-UI tokens (no API call), otherwise backed by the cached `users/me` lookup.
 */
export async function getConsoleLinkContext(
    apifyToken: string | undefined,
    apifyClient: ApifyClient,
): Promise<ConsoleLinkContext | undefined> {
    if (!isConsoleUiToken(apifyToken)) return undefined;
    return resolveConsoleLinkContext(apifyToken, await getUserInfoCached(apifyToken, apifyClient));
}

/** Builds `<consoleBaseUrl>[/organization/<orgId>]<path>`. */
function buildConsoleUrl(context: ConsoleLinkContext, path: string): string {
    const base = context.consoleBaseUrl.replace(/\/+$/, '');
    const orgPrefix = context.organizationId ? `/organization/${context.organizationId}` : '';
    return `${base}${orgPrefix}${path}`;
}

/**
 * Builds the Console Actor detail URL: `<consoleBaseUrl>[/organization/<orgId>]/actors/<actorIdOrSlug>`.
 * `actorIdOrSlug` may be an Actor id or a `username~name` slug — Console resolves both.
 */
export function buildConsoleActorUrl(context: ConsoleLinkContext, actorIdOrSlug: string): string {
    return buildConsoleUrl(context, `/actors/${actorIdOrSlug}`);
}

/** Builds the Console run detail URL: `<consoleBaseUrl>[/organization/<orgId>]/actors/runs/<runId>`. */
export function buildConsoleRunUrl(context: ConsoleLinkContext, runId: string): string {
    return buildConsoleUrl(context, `/actors/runs/${runId}`);
}

/** Builds the Console dataset URL: `<consoleBaseUrl>[/organization/<orgId>]/storage/datasets/<datasetId>`. */
export function buildConsoleDatasetUrl(context: ConsoleLinkContext, datasetId: string): string {
    return buildConsoleUrl(context, `/storage/datasets/${datasetId}`);
}

/** Builds the Console key-value store URL: `<consoleBaseUrl>[/organization/<orgId>]/storage/key-value-stores/<storeId>`. */
export function buildConsoleKeyValueStoreUrl(context: ConsoleLinkContext, storeId: string): string {
    return buildConsoleUrl(context, `/storage/key-value-stores/${storeId}`);
}
