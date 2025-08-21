import { describe, expect, it } from 'vitest';

import { actorNameToToolName } from '../../src/tools/utils.js';

describe('actors', () => {
    describe('actorNameToToolName', () => {
        it('should replace slashes and dots with dash notation', () => {
            expect(actorNameToToolName('apify/web-scraper')).toBe('apify-slash-web-scraper');
            expect(actorNameToToolName('my.actor.name')).toBe('my-dot-actor-dot-name');
        });

        it('should handle empty strings', () => {
            expect(actorNameToToolName('')).toBe('');
        });

        it('should handle strings without slashes or dots', () => {
            expect(actorNameToToolName('actorname')).toBe('actorname');
        });

        it('should handle strings with multiple slashes and dots', () => {
            expect(actorNameToToolName('actor/name.with/multiple.parts')).toBe('actor-slash-name-dot-with-slash-multiple-dot-parts');
        });

        it('should handle tool names longer than 64 characters', () => {
            const longName = 'a'.repeat(70);
            const expected = 'a'.repeat(64);
            expect(actorNameToToolName(longName)).toBe(expected);
        });
    });
});
