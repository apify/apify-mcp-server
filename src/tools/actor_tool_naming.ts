import { createHash } from 'node:crypto';

import log from '@apify/log';

import { HELPER_TOOLS } from '../const.js';
import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../mcp/const.js';
import type { ActorInfo } from '../types.js';
import { ACTOR_TOOL_MODE } from '../types.js';

/**
 * The single rule for how an Actor is exposed as a tool. Tool loading and `call-actor` routing both
 * read it, so the two can never disagree.
 *
 * | standby  | `webServerMcpPath` | input schema | result                |
 * |----------|--------------------|--------------|-----------------------|
 * | disabled | any (path ignored) | any          | `RUN`                 |
 * | enabled  | present            | any          | `MCP`                 |
 * | enabled  | absent             | non-empty    | `RUN`                 |
 * | enabled  | absent             | empty        | `STANDBY_WITHOUT_MCP` |
 *
 * The input schema counts as empty when the definition has no `input`, `input.properties` is missing,
 * or `input.properties` has zero keys. Nothing else counts — a non-empty `required` with no properties
 * still reads as empty.
 */
export function resolveActorToolMode(actorInfo: ActorInfo): ACTOR_TOOL_MODE {
    if (actorInfo.actor.actorStandby?.isEnabled !== true) return ACTOR_TOOL_MODE.RUN;
    if (actorInfo.webServerMcpPath) return ACTOR_TOOL_MODE.MCP;
    if (Object.keys(actorInfo.definition.input?.properties ?? {}).length === 0) {
        return ACTOR_TOOL_MODE.STANDBY_WITHOUT_MCP;
    }
    return ACTOR_TOOL_MODE.RUN;
}

/**
 * Whether this Actor must be excluded from tool surfaces and rejected on
 * `call-actor` when the session uses a third-party payment provider (x402, Skyfire).
 * List-time filtering in `getActorsAsTools` and the call-time guard in
 * `checkPaymentProviderStandbyConflict` must use this — not MCP URL presence alone.
 */
export function isActorBlockedUnderPaymentProvider(actor: Pick<ActorInfo['actor'], 'actorStandby'>): boolean {
    return actor.actorStandby?.isEnabled === true;
}

/** Splits an Actor full name; a missing slash yields a null username. */
export function parseActorFullName(actorFullName: string): { escapedUsername: string | null; actorName: string } {
    const slashIndex = actorFullName.indexOf('/');
    if (slashIndex === -1) {
        log.warning(`Actor name "${actorFullName}" does not contain a slash — expected format "username/actor-name"`);
        return { escapedUsername: null, actorName: actorFullName };
    }

    return {
        escapedUsername: actorFullName.slice(0, slashIndex).replace(/\./g, '-dot-'),
        actorName: actorFullName.slice(slashIndex + 1),
    };
}

export function actorNameToToolName(actorFullName: string): string {
    const { escapedUsername, actorName } = parseActorFullName(actorFullName);
    const fullName = escapedUsername === null ? actorName : `${escapedUsername}--${actorName}`;

    if (fullName.length <= MAX_TOOL_NAME_LENGTH) {
        return fullName;
    }

    // Truncate and add hash for uniqueness
    const hash = createHash('sha256').update(actorFullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
    return `${fullName.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`;
}

/**
 * Converts a legacy tool name (apify-slash-rag-web-browser) to the current format (apify--rag-web-browser).
 * Returns null if the name doesn't match the legacy pattern.
 */
export function legacyToolNameToNew(name: string): string | null {
    if (!name.includes('-slash-')) return null;
    return name.replace('-slash-', '--');
}

export function getToolSchemaID(actorName: string): string {
    return `https://apify.com/mcp/${actorNameToToolName(actorName)}/schema.json`;
}

/**
 * Whether this session can run this Actor: call-actor loaded, its own dedicated tool is, or (for an
 * Actor MCP server, `../mcp/proxy.ts`) at least one of its `{tool}--{originTool}`-prefixed sub-tools is.
 * Soft check — false negative only when hash-capping (`MAX_TOOL_NAME_LENGTH`) altered the prefix.
 */
export function canRunActor(actorFullName: string, loadedToolNames: readonly string[]): boolean {
    if (loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL)) return true;
    const toolName = actorNameToToolName(actorFullName);
    return loadedToolNames.some((name) => name === toolName || name.startsWith(`${toolName}--`));
}
