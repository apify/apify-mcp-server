import { describe, it, expect } from 'vitest';

import { actorNameToToolName, toolNameToActorName } from '../src/actors.js';

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
    });

    describe('toolNameToActorName', () => {
        it('should convert dash notation back to slashes and dots', () => {
            expect(toolNameToActorName('apify-slash-web-scraper')).toBe('apify/web-scraper');
            expect(toolNameToActorName('my-dot-actor-dot-name')).toBe('my.actor.name');
        });

        it('should handle empty strings', () => {
            expect(toolNameToActorName('')).toBe('');
        });

        it('should handle strings without dash notation', () => {
            expect(toolNameToActorName('actorname')).toBe('actorname');
        });

        it('should handle strings with multiple dash notations', () => {
            expect(toolNameToActorName('actor-slash-name-dot-with-slash-multiple-dot-parts')).toBe('actor/name.with/multiple.parts');
        });
    });
});
