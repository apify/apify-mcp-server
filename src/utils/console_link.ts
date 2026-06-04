import { CONSOLE_BASE_URL } from '../const.js';
import type { ConsoleLinkContext } from '../types.js';
import type { CachedUserInfo } from './userid_cache.js';

/** Prefix of Apify Console UI (session) tokens, as opposed to `apify_api_...` API tokens. */
const UI_TOKEN_PREFIX = 'apify_ui_';

/** True when the request is authenticated with a Console UI (session) token. */
export function isConsoleUiToken(apifyToken: string | undefined): boolean {
    return Boolean(apifyToken?.startsWith(UI_TOKEN_PREFIX));
}

/**
 * Resolves the Console link context for a request, or `undefined` when public
 * website links should be used.
 *
 * Personalized Console links are minted only for sessions authenticated with a
 * Console UI token (`apify_ui_...`) — those are always Console-originated
 * (e.g. the Console AI chat). The account the token acts as is taken from the
 * already-cached `users/me` lookup: for an organization-scoped token that is
 * the organization itself, which yields org-prefixed links.
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
 * Builds the Apify Console Actor detail URL for the given context.
 *
 * Personal context: `<consoleBaseUrl>/actors/<actorId>`
 * Organization context: `<consoleBaseUrl>/organization/<orgId>/actors/<actorId>`
 *
 * `actorIdOrSlug` may be an Actor id or a `username~name` slug — Console
 * resolves both on its `/actors/:actorId` route.
 */
export function buildConsoleActorUrl(context: ConsoleLinkContext, actorIdOrSlug: string): string {
    const base = context.consoleBaseUrl.replace(/\/+$/, '');
    const orgPrefix = context.organizationId ? `/organization/${context.organizationId}` : '';
    return `${base}${orgPrefix}/actors/${actorIdOrSlug}`;
}
