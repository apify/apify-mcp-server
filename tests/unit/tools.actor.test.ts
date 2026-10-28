import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS, WEB_FETCH } from '../../src/const.js';
import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../../src/mcp/const.js';
import {
    actorNameToToolName,
    canRunActor,
    canRunAnyActor,
    getOwnServerRemedy,
    legacyToolNameToNew,
    resolveActorInterfaces,
    resolveActorToolMode,
} from '../../src/tools/actor_tool_naming.js';
import type { ActorInfo, ActorInputSchema } from '../../src/types.js';
import { ACTOR_TOOL_MODE } from '../../src/types.js';
import { only } from './helpers/tool_context.js';

describe('actors', () => {
    describe('actorNameToToolName', () => {
        it('converts actor full name to {username}--{actor-name} format', () => {
            expect(actorNameToToolName('apify/web-scraper')).toBe('apify--web-scraper');
            expect(actorNameToToolName('apify/rag-web-browser')).toBe('apify--rag-web-browser');
            expect(actorNameToToolName('compass/crawler-google-places')).toBe('compass--crawler-google-places');
        });

        it('handles strings without slashes by using hash truncation for long names', () => {
            expect(actorNameToToolName('actorname')).toBe('actorname');
            // Strings longer than 64 chars without a slash should use hash-based truncation
            const longName = 'a'.repeat(70);
            const hash = createHash('sha256').update(longName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
            expect(actorNameToToolName(longName)).toBe(
                `${'a'.repeat(MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`,
            );
        });

        it('does not invent an owner for a current-user Actor name', () => {
            expect(actorNameToToolName('~my-actor')).toBe('~my-actor');
        });

        it('handles tool names longer than 64 characters by truncating with a hash', () => {
            const longName = 'apify/website-content-crawler-very-long-name-that-exceeds-the-limit';
            const result = actorNameToToolName(longName);
            expect(result.length).toBe(64);
            // Should end with a hash after a dash
            expect(result).toMatch(/-[0-9a-f]{4}$/);
            // Should start with 'apify--'
            expect(result.startsWith('apify--')).toBe(true);
            // Hash should be deterministic
            const hash = createHash('sha256').update(longName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
            expect(result.endsWith(`-${hash}`)).toBe(true);
        });

        it('replaces dots with -dot- in usernames', () => {
            expect(actorNameToToolName('my.org/my-actor')).toBe('my-dot-org--my-actor');
        });

        it('handles empty string', () => {
            expect(actorNameToToolName('')).toBe('');
        });

        it('produces deterministic results', () => {
            const name = 'apify/rag-web-browser';
            expect(actorNameToToolName(name)).toBe(actorNameToToolName(name));
        });
    });

    describe('legacyToolNameToNew', () => {
        it('converts legacy -slash- format to new -- format', () => {
            expect(legacyToolNameToNew('apify-slash-rag-web-browser')).toBe('apify--rag-web-browser');
            expect(legacyToolNameToNew('compass-slash-crawler-google-places')).toBe('compass--crawler-google-places');
        });

        it('preserves -dot- encoding unchanged', () => {
            expect(legacyToolNameToNew('jiri-dot-spilka-slash-openrouter-x')).toBe('jiri-dot-spilka--openrouter-x');
        });

        it('returns null for names without -slash-', () => {
            expect(legacyToolNameToNew('apify--rag-web-browser')).toBeNull();
            expect(legacyToolNameToNew('search-actors')).toBeNull();
        });
    });
});

function makeActorInfo(opts: {
    isStandbyEnabled?: boolean;
    webServerMcpPath?: string | null;
    input?: unknown;
    hasWebServerSchema?: boolean;
    actorFullName?: string;
}): ActorInfo {
    return {
        webServerMcpPath: opts.webServerMcpPath ?? null,
        definition: {
            id: 'actor-id',
            actorFullName: opts.actorFullName ?? 'acme/actor',
            input: opts.input as ActorInputSchema | undefined,
            hasWebServerSchema: opts.hasWebServerSchema ?? false,
        },
        actor: opts.isStandbyEnabled ? { actorStandby: { isEnabled: true } } : {},
    } as unknown as ActorInfo;
}

const NON_EMPTY_INPUT = { type: 'object', properties: { url: { type: 'string' } } };

describe('interface availability and tool routing', () => {
    it.each([
        [
            'server interface off ignores a leftover MCP path and HTTP schema',
            { webServerMcpPath: '/mcp', hasWebServerSchema: true },
            { input: true, mcp: false, server: false },
            ACTOR_TOOL_MODE.RUN,
        ],
        [
            'server interface on, MCP path, HTTP schema',
            { isStandbyEnabled: true, webServerMcpPath: '/mcp', hasWebServerSchema: true },
            { input: false, mcp: true, server: true },
            ACTOR_TOOL_MODE.MCP,
        ],
        [
            'server interface on, no MCP path, input schema, HTTP schema',
            { isStandbyEnabled: true, hasWebServerSchema: true },
            { input: true, mcp: false, server: true },
            ACTOR_TOOL_MODE.RUN,
        ],
        [
            'server interface on, no MCP path, no input schema, HTTP schema',
            { isStandbyEnabled: true, input: undefined, hasWebServerSchema: true },
            { input: false, mcp: false, server: true },
            ACTOR_TOOL_MODE.SERVER_ACTOR_WITHOUT_MCP,
        ],
        [
            'input-interface Actor declaring an MCP path, with an HTTP schema',
            { isStandbyEnabled: true, webServerMcpPath: '/mcp', hasWebServerSchema: true, actorFullName: WEB_FETCH },
            { input: true, mcp: false, server: true },
            ACTOR_TOOL_MODE.RUN,
        ],
        // The input-interface override only drops the MCP interface; it does not waive the empty-schema rule.
        [
            'input-interface Actor with an empty input schema',
            { isStandbyEnabled: true, webServerMcpPath: '/mcp', actorFullName: WEB_FETCH, input: undefined },
            { input: false, mcp: false, server: false },
            ACTOR_TOOL_MODE.SERVER_ACTOR_WITHOUT_MCP,
        ],
    ] as const)('resolves %s', (_label, opts, interfaces, toolMode) => {
        const actorInfo = makeActorInfo({ input: NON_EMPTY_INPUT, ...opts });

        expect(resolveActorInterfaces(actorInfo)).toEqual(interfaces);
        expect(resolveActorToolMode(actorInfo)).toBe(toolMode);
    });
});

describe('what counts as an empty input schema', () => {
    // The edge cases behind the "input schema" column of the decision table; the table rows above
    // cover the interface combinations.
    it.each([
        ['standby disabled, empty input schema', { input: undefined }, ACTOR_TOOL_MODE.RUN],
        [
            'required without properties still counts as empty',
            { isStandbyEnabled: true, input: { type: 'object', properties: {}, required: ['url'] } },
            ACTOR_TOOL_MODE.SERVER_ACTOR_WITHOUT_MCP,
        ],
        [
            'non-object input carrying properties counts as non-empty',
            { isStandbyEnabled: true, input: { type: 'string', properties: { url: { type: 'string' } } } },
            ACTOR_TOOL_MODE.RUN,
        ],
    ] as const)('resolves %s to %s', (_label, opts, expected) => {
        expect(resolveActorToolMode(makeActorInfo(opts))).toBe(expected);
    });
});

describe('canRunActor()', () => {
    it('returns true when call-actor is loaded, regardless of the Actor', () => {
        expect(canRunActor('actor-id-1', [HELPER_TOOLS.ACTOR_CALL], new Set())).toBe(true);
    });

    it('returns true when only apify-api-write is loaded, regardless of the Actor', () => {
        expect(canRunActor('actor-id-1', [HELPER_TOOLS.API_WRITE], new Set())).toBe(true);
    });

    it('returns true when call-actor is absent but the Actor ID is in loadedActorIds', () => {
        expect(canRunActor('actor-id-1', [], new Set(['actor-id-1']))).toBe(true);
    });

    it('returns false when call-actor is absent and the Actor ID is not in loadedActorIds', () => {
        expect(canRunActor('actor-id-1', [], new Set(['other-actor-id']))).toBe(false);
        expect(canRunActor('actor-id-1', [], new Set())).toBe(false);
    });
});

describe('getOwnServerRemedy()', () => {
    it('names the Claude custom connector only for ?client=claude', () => {
        expect(getOwnServerRemedy('claude')).toContain('add it to Claude as a custom connector.');
        for (const clientParam of [undefined, 'cursor', 'claude-code']) {
            expect(getOwnServerRemedy(clientParam)).toContain('add it to your agent.');
        }
    });
});

describe('canRunAnyActor()', () => {
    it.each([HELPER_TOOLS.ACTOR_CALL, HELPER_TOOLS.ACTOR_CALL_WIDGET, HELPER_TOOLS.API_WRITE])(
        'returns true when only %s is loaded',
        (toolName) => {
            expect(canRunAnyActor(only(toolName).hasTool)).toBe(true);
        },
    );

    it('returns false when no tool can run an arbitrary Actor', () => {
        expect(canRunAnyActor(only(HELPER_TOOLS.STORE_SEARCH, HELPER_TOOLS.ACTOR_GET_DETAILS).hasTool)).toBe(false);
    });
});
