import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TOOL_NAME_HASH_LENGTH } from '../../src/mcp/const.js';
import { actorNameToToolName } from '../../src/tools/utils.js';

describe('actors', () => {
    describe('actorNameToToolName', () => {
        it('should convert actor full name to {username}--{actor-name} format', () => {
            expect(actorNameToToolName('apify/web-scraper')).toBe('apify--web-scraper');
            expect(actorNameToToolName('apify/rag-web-browser')).toBe('apify--rag-web-browser');
            expect(actorNameToToolName('compass/crawler-google-places')).toBe('compass--crawler-google-places');
        });

        it('should throw for actor names without a slash', () => {
            expect(() => actorNameToToolName('')).toThrow();
            expect(() => actorNameToToolName('actorname')).toThrow();
            expect(() => actorNameToToolName('a'.repeat(70))).toThrow();
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

        it('should produce deterministic results', () => {
            const name = 'apify/rag-web-browser';
            expect(actorNameToToolName(name)).toBe(actorNameToToolName(name));
        });
    });
});
