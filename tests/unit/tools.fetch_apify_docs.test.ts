import { describe, expect, it } from 'vitest';

import { buildMarkdownUrl } from '../../src/tools/common/fetch_apify_docs.js';

describe('buildMarkdownUrl', () => {
    it.each([
        ['https://docs.apify.com', 'https://docs.apify.com/index.md'],
        ['https://docs.apify.com/', 'https://docs.apify.com/index.md'],
        ['https://crawlee.dev', 'https://crawlee.dev/index.md'],
        ['https://crawlee.dev/', 'https://crawlee.dev/index.md'],
        ['https://docs.apify.com/platform/actors/running', 'https://docs.apify.com/platform/actors/running.md'],
        ['https://docs.apify.com/platform/actors/running/', 'https://docs.apify.com/platform/actors/running.md'],
        ['https://docs.apify.com/academy', 'https://docs.apify.com/academy.md'],
        ['https://docs.apify.com/platform/actors/running#builds', 'https://docs.apify.com/platform/actors/running.md'],
    ])('%s → %s', (input, expected) => {
        expect(buildMarkdownUrl(input)).toBe(expected);
    });
});
