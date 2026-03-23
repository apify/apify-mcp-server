import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { actorNameToToolName } from '../../src/tools/utils.js';

describe('actors', () => {
    describe('actorNameToToolName', () => {
        it('should convert actor full name to actor-{name}-by-{author} format', () => {
            expect(actorNameToToolName('apify/web-scraper')).toBe('actor-web-scraper-by-apify');
            expect(actorNameToToolName('apify/rag-web-browser')).toBe('actor-rag-web-browser-by-apify');
            expect(actorNameToToolName('curious-coder/website-content-crawler')).toBe('actor-website-content-crawler-by-curious-coder');
        });

        it('should handle empty strings', () => {
            expect(actorNameToToolName('')).toBe('');
        });

        it('should handle strings without slashes', () => {
            expect(actorNameToToolName('actorname')).toBe('actorname');
            // Strings longer than 64 chars without a slash should be truncated
            const longName = 'a'.repeat(70);
            expect(actorNameToToolName(longName)).toBe('a'.repeat(64));
        });

        it('should handle tool names longer than 64 characters by truncating with a 4-char hash', () => {
            const longName = 'curious-coder/website-content-crawler-very-long-name-that-exceeds-limit';
            const result = actorNameToToolName(longName);
            expect(result.length).toBe(64);
            // Should end with a 4-char hash after a dash
            expect(result).toMatch(/-[0-9a-f]{4}$/);
            // Should start with 'actor-'
            expect(result.startsWith('actor-')).toBe(true);
            // Hash should be deterministic
            const hash = createHash('sha256').update(longName).digest('hex').slice(0, 4);
            expect(result.endsWith(`-${hash}`)).toBe(true);
        });

        it('should produce deterministic results', () => {
            const name = 'apify/rag-web-browser';
            expect(actorNameToToolName(name)).toBe(actorNameToToolName(name));
        });
    });
});
