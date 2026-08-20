import { createHash } from 'node:crypto';

import log from '@apify/log';

import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../mcp/const.js';
import type { ActorInfo } from '../types.js';
import { TOOL_TYPE } from '../types.js';

/**
 * The single rule for how an Actor is exposed as a tool. Tool loading and `call-actor` routing both
 * read it, so the two can never disagree.
 *
 * | standby  | `webServerMcpPath` | input schema | result                              |
 * |----------|--------------------|--------------|-------------------------------------|
 * | disabled | absent             | any          | `ACTOR` (run tool)                  |
 * | disabled | present            | any          | `ACTOR` — the leftover path is ignored |
 * | enabled  | present            | any          | `ACTOR_MCP` (proxied MCP tools only) |
 * | enabled  | absent             | non-empty    | `ACTOR` (run tool)                  |
 * | enabled  | absent             | empty        | `null`                              |
 *
 * `null` is not a fourth `TOOL_TYPE` member: it is the absence of a tool. A standby-only Actor with an
 * empty input schema has nothing to run and no MCP server to proxy, so it gets no tool at all.
 *
 * The input schema counts as empty when the definition has no `input`, `input.properties` is missing,
 * or `input.properties` has zero keys. Nothing else counts — a non-empty `required` with no properties
 * still reads as empty.
 */
export function resolveActorToolType(actorInfo: ActorInfo): typeof TOOL_TYPE.ACTOR | typeof TOOL_TYPE.ACTOR_MCP | null {
    if (!actorInfo.actor.actorStandby?.isEnabled) return TOOL_TYPE.ACTOR;
    if (actorInfo.webServerMcpPath) return TOOL_TYPE.ACTOR_MCP;
    return Object.keys(actorInfo.definition.input?.properties ?? {}).length > 0 ? TOOL_TYPE.ACTOR : null;
}

/**
 * Whether this Actor must be excluded from tool surfaces and rejected on
 * `call-actor` when the session uses a third-party payment provider (x402, Skyfire).
 * List-time filtering in `getActorsAsTools` and the call-time guard in
 * `checkPaymentProviderStandbyConflict` must use this — not MCP URL presence alone.
 */
export function isActorBlockedUnderPaymentProvider(actorInfo: ActorInfo): boolean {
    return !!actorInfo.actor.actorStandby?.isEnabled;
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
