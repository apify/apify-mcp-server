import { createHash } from 'node:crypto';

import log from '@apify/log';

import { APIFY_MCP_URL, HELPER_TOOLS, INPUT_INTERFACE_ACTORS } from '../const.js';
import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../mcp/const.js';
import type { ActorInfo, ActorInterfaces, ToolDescriptionContext } from '../types.js';
import { ACTOR_TOOL_MODE } from '../types.js';

/**
 * The single rule for which interfaces an Actor has. Tool loading and `call-actor` routing both read the
 * tool slot `resolveActorToolMode` derives from it, so the two can never disagree.
 *
 * | server | MCP path | input schema | HTTP schema | `input` | `mcp` | `server` | tool slot                  |
 * |--------|----------|--------------|-------------|---------|-------|----------|----------------------------|
 * | off    | any      | any          | any         | true    | false | false    | `RUN`                      |
 * | on     | present  | any          | no / yes    | false   | true  | no / yes | `MCP`                      |
 * | on     | absent   | non-empty    | no / yes    | true    | false | no / yes | `RUN`                      |
 * | on     | absent   | empty        | no / yes    | false   | false | no / yes | `SERVER_ACTOR_WITHOUT_MCP` |
 *
 * "server" is the Actor's `actorStandby.isEnabled` (the API field is named standby). "MCP path" is
 * `webServerMcpPath`, read as absent for Actors in `INPUT_INTERFACE_ACTORS` (`../const.ts`), which are served
 * through the input interface although they declare it, unless their input schema is empty (including a
 * malformed one `pruneActorDefinition` drops); then they get no tool, like any other server Actor.
 * "HTTP schema" is `definition.hasWebServerSchema`.
 * An MCP-server Actor does not get `input` even with a non-empty input schema: Store data shows that
 * interface is unused on such Actors (decided 2026-10-19).
 * The input schema counts as empty when the definition has no `input`, `input.properties` is missing,
 * or `input.properties` has zero keys. Nothing else counts — a non-empty `required` with no properties
 * still reads as empty.
 */
export function resolveActorInterfaces({ actor, definition, webServerMcpPath }: ActorInfo): ActorInterfaces {
    if (actor.actorStandby?.isEnabled !== true) return { input: true, mcp: false, server: false };

    const mcp = Boolean(webServerMcpPath) && !INPUT_INTERFACE_ACTORS.has(definition.actorFullName);
    const hasInputProperties = Object.keys(definition.input?.properties ?? {}).length > 0;
    return { input: hasInputProperties && !mcp, mcp, server: definition.hasWebServerSchema };
}

/** The tool slot column of the table on {@link resolveActorInterfaces}: MCP tools, else a run tool, else none. */
export function resolveActorToolMode(actorInfo: ActorInfo): ACTOR_TOOL_MODE {
    return getActorToolModeFromInterfaces(resolveActorInterfaces(actorInfo));
}

/** {@link resolveActorToolMode} for an interface set the caller already resolved. */
export function getActorToolModeFromInterfaces({ input, mcp }: ActorInterfaces): ACTOR_TOOL_MODE {
    if (mcp) return ACTOR_TOOL_MODE.MCP;
    if (input) return ACTOR_TOOL_MODE.RUN;
    return ACTOR_TOOL_MODE.SERVER_ACTOR_WITHOUT_MCP;
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
    const normalizedActorFullName = actorFullName.replace(/^([^~]+)~/, '$1/');
    const { escapedUsername, actorName } = parseActorFullName(normalizedActorFullName);
    const fullName = escapedUsername === null ? actorName : `${escapedUsername}--${actorName}`;

    if (fullName.length <= MAX_TOOL_NAME_LENGTH) {
        return fullName;
    }

    // Truncate and add hash for uniqueness
    const hash = createHash('sha256').update(normalizedActorFullName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
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

/** `?client=claude` is the Claude connector URL; the only client whose add-a-server flow has a name. */
export function isClaudeClient(clientParam?: string): boolean {
    return clientParam === 'claude';
}

/** How to get an Actor this session cannot run. Tool results use the neutral wording; descriptions and instructions see `clientParam`. */
export function getOwnServerRemedy(clientParam?: string): string {
    const target = isClaudeClient(clientParam) ? 'Claude as a custom connector' : 'your agent';
    return `create your own Apify MCP server configuration at ${APIFY_MCP_URL} and add it to ${target}.`;
}

/** In the `search-actors` description when the session has no run path, and under search results when the session cannot run some of the Actors listed. */
export function getActorCallabilityCaveat(clientParam?: string): string {
    return `This session can run only Actors already exposed as dedicated tools. Other Actors found
here are informational and cannot be run in this configuration. To use one, ${getOwnServerRemedy(clientParam)}`;
}

/** Whether the session holds a tool that can run an arbitrary Actor. */
export function canRunAnyActor(hasTool: ToolDescriptionContext['hasTool']): boolean {
    return (
        hasTool(HELPER_TOOLS.ACTOR_CALL) || hasTool(HELPER_TOOLS.ACTOR_CALL_WIDGET) || hasTool(HELPER_TOOLS.API_WRITE)
    );
}

/** After an Actor's tip when the session cannot run the Actor the tip recommends. */
export const ACTOR_TIP_CAVEAT = `This session cannot run the Actor this tip recommends. To use it, ${getOwnServerRemedy()}`;

/** Whether this session can run this Actor (call-actor, or the Actor's own tool, loaded); soft check for a guidance hint, not a hard gate. */
export function canRunActor(
    actorId: string,
    loadedToolNames: readonly string[],
    loadedActorIds: ReadonlySet<string>,
): boolean {
    return loadedToolNames.includes(HELPER_TOOLS.ACTOR_CALL) || loadedActorIds.has(actorId);
}
