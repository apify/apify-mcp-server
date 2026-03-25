import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_HASH_LENGTH } from '../../src/mcp/const.js';
import { actorNameToToolName, legacyToolNameToNew } from '../../src/tools/utils.js';

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
            expect(actorNameToToolName(longName)).toBe(`${'a'.repeat(MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`);
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
