import { describe, expect, it } from 'vitest';

import { parseInputParamsFromUrl } from '../../src/mcp/utils.js';

describe('parseInputParamsFromUrl', () => {
    it('should parse Actors from URL query params (as tools)', () => {
        const url = 'https://mcp.apify.com?token=123&actors=apify/web-scraper';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/web-scraper']);
        expect(result.actors).toBeUndefined();
    });

    it('should parse multiple Actors from URL (as tools)', () => {
        const url = 'https://mcp.apify.com?actors=apify/instagram-scraper,lukaskrivka/google-maps';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/instagram-scraper', 'lukaskrivka/google-maps']);
        expect(result.actors).toBeUndefined();
    });

    it('should handle URL without query params', () => {
        const url = 'https://mcp.apify.com';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toBeUndefined();
    });

    it('should parse enableActorAutoLoading flag', () => {
        const url = 'https://mcp.apify.com?enableActorAutoLoading=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('should parse enableAddingActors flag', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('should parse enableAddingActors flag', () => {
        const url = 'https://mcp.apify.com?enableAddingActors=false';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(false);
    });

    it('should handle Actors as string parameter (as tools)', () => {
        const url = 'https://mcp.apify.com?actors=apify/rag-web-browser';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/rag-web-browser']);
        expect(result.actors).toBeUndefined();
    });
});
