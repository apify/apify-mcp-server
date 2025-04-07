import { describe, it, expect } from 'vitest';

import { parseInputParamsFromUrl } from '../src/utils.js';

describe('parseInputParamsFromUrl', () => {
    it('should parse actors from URL query params', () => {
        const url = 'https://actors-mcp-server.apify.actor?token=123&actors=apify/web-scraper';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toEqual(['apify/web-scraper']);
    });

    it('should parse multiple actors from URL', () => {
        const url = 'https://actors-mcp-server.apify.actor?actors=apify/instagram-scraper,lukaskrivka/google-maps';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toEqual(['apify/instagram-scraper', 'lukaskrivka/google-maps']);
    });

    it('should handle URL without query params', () => {
        const url = 'https://actors-mcp-server.apify.actor';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toBeUndefined();
    });

    it('should parse enableActorAutoLoading flag', () => {
        const url = 'https://actors-mcp-server.apify.actor?enableActorAutoLoading=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableActorAutoLoading).toBe(true);
    });

    it('should handle actors as string parameter', () => {
        const url = 'https://actors-mcp-server.apify.actor?actors=apify/rag-web-browser';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toEqual(['apify/rag-web-browser']);
    });
});
