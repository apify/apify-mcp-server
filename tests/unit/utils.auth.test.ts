import { describe, expect, it } from 'vitest';

import { isApiTokenRequired } from '../../src/utils/auth.js';

const RETIRED_SELECTORS = ['add-actor', 'experimental', 'preview'] as const;

describe('isApiTokenRequired', () => {
    it('should require token if no tools are specified', () => {
        expect(isApiTokenRequired({})).toBe(true);
        expect(isApiTokenRequired({ toolCategoryKeys: [] })).toBe(true);
    });

    it('should NOT require token for only public tools', () => {
        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['search-actors'],
            }),
        ).toBe(false);

        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['search-apify-docs', 'fetch-apify-docs'],
            }),
        ).toBe(false);

        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['fetch-actor-details'],
            }),
        ).toBe(false);

        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['search-actors', 'fetch-actor-details'],
            }),
        ).toBe(false);
    });

    it('should require token if any private tool is included', () => {
        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['search-actors', 'call-actor'],
            }),
        ).toBe(true);
    });

    it('should require token if any non-public category is used', () => {
        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['actors'],
            }),
        ).toBe(true);
    });

    it('should require token if specifically requested actors subset', () => {
        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['search-actors'],
                actorList: ['apify/web-scraper'],
            }),
        ).toBe(true);
    });

    it.for(RETIRED_SELECTORS)(
        'requires a token for a retired-only selector "%s" (same as an empty list)',
        (selector) => {
            expect(isApiTokenRequired({ toolCategoryKeys: [selector] })).toBe(true);
        },
    );

    it('does not require a token for retired selectors alongside a public tool', () => {
        expect(isApiTokenRequired({ toolCategoryKeys: [...RETIRED_SELECTORS, 'search-actors'] })).toBe(false);
    });

    it('requires a token for retired selectors alongside a private tool', () => {
        expect(isApiTokenRequired({ toolCategoryKeys: [...RETIRED_SELECTORS, 'call-actor'] })).toBe(true);
    });

    it('should handle unknown keys as potentially unsafe (requiring token)', () => {
        expect(
            isApiTokenRequired({
                toolCategoryKeys: ['some-unknown-potential-actor-name'],
            }),
        ).toBe(true);
    });
});
