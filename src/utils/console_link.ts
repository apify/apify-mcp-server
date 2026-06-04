import { CONSOLE_BASE_URL } from '../const.js';
import type { ActorsMcpServer } from '../mcp/server.js';
import type { ConsoleLinkContext } from '../types.js';
import type { CachedUserInfo } from './userid_cache.js';

/**
 * MCP client name (`clientInfo.name` from the `initialize` request) of the
 * Apify Console AI chat. Must stay in sync with the chat backend in apify-core
 * (`ai_chat.service.ts`, `getApifyMcpClient` clientInfo).
 */
export const CONSOLE_CHAT_CLIENT_NAME = 'apify-console-ai-chat';

/** True when the MCP session was initialized by the Apify Console AI chat. */
export function isConsoleChatClient(apifyMcpServer: ActorsMcpServer): boolean {
    return apifyMcpServer.options.initializeRequestData?.params?.clientInfo?.name === CONSOLE_CHAT_CLIENT_NAME;
}

/**
 * Resolves the Console link context for a request, or `undefined` when public
 * website links should be used.
 *
 * Link policy (agreed in apify/apify-core#27286):
 * - Apify Console AI chat sessions (identified by the MCP client ID, see
 *   {@link CONSOLE_CHAT_CLIENT_NAME}) → ALWAYS Console links, scoped to the
 *   account the session's token acts as
 * - all other clients → public `apify.com` links for info that has a public
 *   page (Actor details); if links to Console-only info (runs, storages, ...)
 *   are ever added to tool outputs, those must be Console links for every
 *   authenticated session, since no public page exists
 *
 * The account the token acts as is taken from the already-cached `users/me`
 * lookup: for an organization-scoped token that is the organization itself,
 * which yields org-prefixed links.
 */
export function resolveConsoleLinkContext(
    apifyMcpServer: ActorsMcpServer,
    userInfo: CachedUserInfo,
): ConsoleLinkContext | undefined {
    if (!isConsoleChatClient(apifyMcpServer)) return undefined;
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
