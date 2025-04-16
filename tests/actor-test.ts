import { describe, expect, it } from 'vitest';

import { ACTOR_ENUM_MAX_LENGTH } from '../src/const.js';
import { actorNameToToolName, inferArrayItemType, shortenEnum } from '../src/tools/utils.js';

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

        it('infers array item type from editor', () => {
            const property = {
                type: 'array',
                editor: 'stringList',
                title: '',
                description: '',
                enum: [],
                default: '',
                prefill: '',
            };
            expect(inferArrayItemType(property)).toBe('string');
        });

        it('shorten enum list', () => {
            const enumList: string[] = [];
            const wordLength = 10;
            const wordCount = 30;

            for (let i = 0; i < wordCount; i++) {
                enumList.push('a'.repeat(wordLength));
            }

            const shortenedList = shortenEnum(enumList);

            expect(shortenedList?.length || 0).toBe(ACTOR_ENUM_MAX_LENGTH / wordLength);
        });
    });
});
