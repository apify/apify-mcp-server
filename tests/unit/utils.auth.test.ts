import { describe, expect, it } from 'vitest';

import { isApiTokenRequired } from '../../src/utils/auth.js';

describe('isApiTokenRequired', () => {
    it('should require token if no tools are specified', () => {
        expect(isApiTokenRequired({})).toBe(true);
        expect(isApiTokenRequired({ toolCategoryKeys: [] })).toBe(true);
    });

    it('should NOT require token for only public tools', () => {
        expect(isApiTokenRequired({
            toolCategoryKeys: ['search-actors'],
        })).toBe(false);

        expect(isApiTokenRequired({
            toolCategoryKeys: ['search-apify-docs', 'fetch-apify-docs'],
        })).toBe(false);
    });

    it('should require token if any private tool is included', () => {
        expect(isApiTokenRequired({
            toolCategoryKeys: ['search-actors', 'call-actor'],
        })).toBe(true);
    });

    it('should require token if any non-public category is used', () => {
        expect(isApiTokenRequired({
            toolCategoryKeys: ['actors'],
        })).toBe(true);
    });

    it('should require token if specifically requested actors subset', () => {
        expect(isApiTokenRequired({
            toolCategoryKeys: ['search-actors'],
            actorList: ['apify/web-scraper'],
        })).toBe(true);
    });

    it('should require token if enableAddingActors is true', () => {
        expect(isApiTokenRequired({
            toolCategoryKeys: ['search-actors'],
            enableAddingActors: true,
        })).toBe(true);
    });

    it('should handle unknown keys as potentially unsafe (requiring token)', () => {
        expect(isApiTokenRequired({
            toolCategoryKeys: ['some-unknown-potential-actor-name'],
        })).toBe(true);
    });
});
