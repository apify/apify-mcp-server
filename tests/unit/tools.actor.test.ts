import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../../src/mcp/const.js';
import { actorNameToToolName, legacyToolNameToNew, resolveActorToolType } from '../../src/tools/actor_tool_naming.js';
import type { ActorInfo, ActorInputSchema } from '../../src/types.js';
import { TOOL_TYPE } from '../../src/types.js';

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

describe('resolveActorToolType()', () => {
    it('returns ACTOR when standby is disabled and no MCP path is set', () => {
        expect(resolveActorToolType(makeActorInfo({ input: NON_EMPTY_INPUT }))).toBe(TOOL_TYPE.ACTOR);
    });

    it('returns ACTOR when standby is disabled despite a leftover MCP path', () => {
        expect(resolveActorToolType(makeActorInfo({ webServerMcpPath: '/mcp', input: NON_EMPTY_INPUT }))).toBe(
            TOOL_TYPE.ACTOR,
        );
    });

    it('returns ACTOR when standby is disabled and the input schema is empty', () => {
        expect(resolveActorToolType(makeActorInfo({}))).toBe(TOOL_TYPE.ACTOR);
    });

    it('returns ACTOR_MCP when standby is enabled and an MCP path is set', () => {
        expect(resolveActorToolType(makeActorInfo({ isStandbyEnabled: true, webServerMcpPath: '/mcp' }))).toBe(
            TOOL_TYPE.ACTOR_MCP,
        );
    });

    it('returns ACTOR when standby is enabled without an MCP path but the input schema is non-empty', () => {
        expect(resolveActorToolType(makeActorInfo({ isStandbyEnabled: true, input: NON_EMPTY_INPUT }))).toBe(
            TOOL_TYPE.ACTOR,
        );
    });

    it('returns null when standby is enabled without an MCP path and the input schema is empty', () => {
        expect(resolveActorToolType(makeActorInfo({ isStandbyEnabled: true }))).toBeNull();
    });

    describe('empty input schema', () => {
        it('treats a missing input as empty', () => {
            expect(resolveActorToolType(makeActorInfo({ isStandbyEnabled: true, input: undefined }))).toBeNull();
        });

        it('treats an input without properties as empty', () => {
            expect(
                resolveActorToolType(makeActorInfo({ isStandbyEnabled: true, input: { type: 'object' } })),
            ).toBeNull();
        });

        it('treats zero properties as empty', () => {
            expect(
                resolveActorToolType(
                    makeActorInfo({ isStandbyEnabled: true, input: { type: 'object', properties: {} } }),
                ),
            ).toBeNull();
        });

        it('treats a non-empty required list with no properties as empty', () => {
            expect(
                resolveActorToolType(
                    makeActorInfo({
                        isStandbyEnabled: true,
                        input: { type: 'object', properties: {}, required: ['url'] },
                    }),
                ),
            ).toBeNull();
        });

        it('treats a non-object input carrying properties as non-empty', () => {
            expect(
                resolveActorToolType(
                    makeActorInfo({
                        isStandbyEnabled: true,
                        input: { type: 'string', properties: { url: { type: 'string' } } },
                    }),
                ),
            ).toBe(TOOL_TYPE.ACTOR);
        });
    });
});
