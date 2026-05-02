import { describe, expect, it } from 'vitest';

import { buildMarkdownUrl, isAllowedDocsUrl } from '../../src/tools/common/fetch_apify_docs.js';

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

describe('isAllowedDocsUrl', () => {
    it.each([
        'https://docs.apify.com',
        'https://docs.apify.com/',
        'https://docs.apify.com/platform/actors/running',
        'https://docs.apify.com/platform/actors/running#builds',
        'https://crawlee.dev',
        'https://crawlee.dev/docs/quick-start',
    ])('allows %s', (url) => {
        expect(isAllowedDocsUrl(url)).toBe(true);
    });

    it.each([
        // Bypasses called out in GHSA-jwp7-wg77-3w9v
        'https://docs.apify.com.evil.com/payload',
        'https://docs.apify.com.evil.com:8080/path',
        'https://docs.apify.com@evil.com/payload',
        // Other rejections
        'https://crawlee.dev.evil.com/',
        'https://evil.com/docs.apify.com',
        'http://docs.apify.com/',
        'ftp://docs.apify.com/',
        // eslint-disable-next-line no-script-url
        'javascript:alert(1)',
        'not-a-url',
        '',
    ])('rejects %s', (url) => {
        expect(isAllowedDocsUrl(url)).toBe(false);
    });
});
