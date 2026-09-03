import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HELPER_TOOLS } from '../../src/const.js';
import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../../src/mcp/const.js';
import {
    actorNameToToolName,
    canRunActor,
    legacyToolNameToNew,
    resolveActorToolMode,
} from '../../src/tools/actor_tool_naming.js';
import type { ActorInfo, ActorInputSchema } from '../../src/types.js';
import { ACTOR_TOOL_MODE } from '../../src/types.js';

describe('actors', () => {
    describe('actorNameToToolName', () => {
        it('should convert actor full name to {username}--{actor-name} format', () => {
            expect(actorNameToToolName('apify/web-scraper')).toBe('apify--web-scraper');
            expect(actorNameToToolName('apify/rag-web-browser')).toBe('apify--rag-web-browser');
            expect(actorNameToToolName('compass/crawler-google-places')).toBe('compass--crawler-google-places');
        });

        it('should handle strings without slashes by using hash truncation for long names', () => {
            expect(actorNameToToolName('actorname')).toBe('actorname');
            // Strings longer than 64 chars without a slash should use hash-based truncation
            const longName = 'a'.repeat(70);
            const hash = createHash('sha256').update(longName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
            expect(actorNameToToolName(longName)).toBe(
                `${'a'.repeat(MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`,
            );
        });

        it('should handle tool names longer than 64 characters by truncating with a hash', () => {
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

        it('should replace dots with -dot- in usernames', () => {
            expect(actorNameToToolName('my.org/my-actor')).toBe('my-dot-org--my-actor');
        });

        it('should handle empty string', () => {
            expect(actorNameToToolName('')).toBe('');
        });

        it('should produce deterministic results', () => {
            const name = 'apify/rag-web-browser';
            expect(actorNameToToolName(name)).toBe(actorNameToToolName(name));
        });
    });

    describe('legacyToolNameToNew', () => {
        it('should convert legacy -slash- format to new -- format', () => {
            expect(legacyToolNameToNew('apify-slash-rag-web-browser')).toBe('apify--rag-web-browser');
            expect(legacyToolNameToNew('compass-slash-crawler-google-places')).toBe('compass--crawler-google-places');
        });

        it('should preserve -dot- encoding unchanged', () => {
            expect(legacyToolNameToNew('jiri-dot-spilka-slash-openrouter-x')).toBe('jiri-dot-spilka--openrouter-x');
        });

        it('should return null for names without -slash-', () => {
            expect(legacyToolNameToNew('apify--rag-web-browser')).toBeNull();
            expect(legacyToolNameToNew('search-actors')).toBeNull();
        });
    });
});

function makeActorInfo(opts: {
    isStandbyEnabled?: boolean;
    webServerMcpPath?: string | null;
    input?: unknown;
}): ActorInfo {
    return {
        webServerMcpPath: opts.webServerMcpPath ?? null,
        definition: { id: 'actor-id', actorFullName: 'acme/actor', input: opts.input as ActorInputSchema | undefined },
        actor: opts.isStandbyEnabled ? { actorStandby: { isEnabled: true } } : {},
    } as unknown as ActorInfo;
}

const NON_EMPTY_INPUT = { type: 'object', properties: { url: { type: 'string' } } };

describe('resolveActorToolMode()', () => {
    // One row per cell of the decision table in `resolveActorToolMode`'s docstring, plus the
    // edge cases that define what counts as an empty input schema.
    it.each([
        ['standby disabled, no MCP path', {}, ACTOR_TOOL_MODE.RUN],
        ['standby disabled, leftover MCP path', { webServerMcpPath: '/mcp' }, ACTOR_TOOL_MODE.RUN],
        ['standby disabled, empty input schema', { input: undefined }, ACTOR_TOOL_MODE.RUN],
        ['standby enabled, MCP path', { isStandbyEnabled: true, webServerMcpPath: '/mcp' }, ACTOR_TOOL_MODE.MCP],
        ['standby enabled, no MCP path, non-empty input', { isStandbyEnabled: true }, ACTOR_TOOL_MODE.RUN],
        [
            'missing input counts as empty',
            { isStandbyEnabled: true, input: undefined },
            ACTOR_TOOL_MODE.STANDBY_WITHOUT_MCP,
        ],
        [
            'input without properties counts as empty',
            { isStandbyEnabled: true, input: { type: 'object' } },
            ACTOR_TOOL_MODE.STANDBY_WITHOUT_MCP,
        ],
        [
            'zero properties counts as empty',
            { isStandbyEnabled: true, input: { type: 'object', properties: {} } },
            ACTOR_TOOL_MODE.STANDBY_WITHOUT_MCP,
        ],
        [
            'required without properties still counts as empty',
            { isStandbyEnabled: true, input: { type: 'object', properties: {}, required: ['url'] } },
            ACTOR_TOOL_MODE.STANDBY_WITHOUT_MCP,
        ],
        [
            'non-object input carrying properties counts as non-empty',
            { isStandbyEnabled: true, input: { type: 'string', properties: { url: { type: 'string' } } } },
            ACTOR_TOOL_MODE.RUN,
        ],
    ] as const)('resolves %s to %s', (_label, opts, expected) => {
        expect(resolveActorToolMode(makeActorInfo({ input: NON_EMPTY_INPUT, ...opts }))).toBe(expected);
    });
});

describe('canRunActor()', () => {
    it('returns true when call-actor is loaded, regardless of the Actor', () => {
        expect(canRunActor('apify/rag-web-browser', [HELPER_TOOLS.ACTOR_CALL])).toBe(true);
    });

    it('returns true when call-actor is absent but the Actor has its own dedicated tool loaded', () => {
        expect(canRunActor('apify/rag-web-browser', [actorNameToToolName('apify/rag-web-browser')])).toBe(true);
    });

    it('returns false when call-actor is absent and no matching dedicated tool is loaded', () => {
        expect(canRunActor('apify/rag-web-browser', [actorNameToToolName('apify/web-scraper')])).toBe(false);
        expect(canRunActor('apify/rag-web-browser', [])).toBe(false);
    });
});
