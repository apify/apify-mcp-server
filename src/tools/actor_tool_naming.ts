import { createHash } from 'node:crypto';

import log from '@apify/log';

import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../mcp/const.js';
import type { ActorInfo } from '../types.js';

/*
 * Checks if the given ActorInfo represents an MCP server Actor.
 */
export function isActorInfoMcpServer(actorInfo: ActorInfo): boolean {
    return !!(actorInfo.webServerMcpPath && actorInfo.actor.actorStandby?.isEnabled);
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

export function actorNameToToolName(actorFullName: string): string {
    const slashIndex = actorFullName.indexOf('/');
    if (slashIndex === -1) {
        log.warning(`Actor name "${actorFullName}" does not contain a slash — expected format "username/actor-name"`);
    }

    const username = slashIndex !== -1 ? actorFullName.slice(0, slashIndex) : '';
    const actorName = slashIndex !== -1 ? actorFullName.slice(slashIndex + 1) : actorFullName;
    const safeUsername = username.replace(/\./g, '-dot-');
    const fullName = slashIndex !== -1 ? `${safeUsername}--${actorName}` : actorName;

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
