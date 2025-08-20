import { describe, expect, it } from 'vitest';

import { parseInputParamsFromUrl } from '../../src/mcp/utils.js';

describe('parseInputParamsFromUrl', () => {
    it('should parse Actors from URL query params (as tools selectors)', () => {
        const url = 'https://actors-mcp-server.apify.actor?token=123&actors=apify/web-scraper';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/web-scraper']);
        expect(result.actors).toBeUndefined();
    });

    it('should parse multiple Actors from URL (as tools selectors)', () => {
        const url = 'https://actors-mcp-server.apify.actor?actors=apify/instagram-scraper,lukaskrivka/google-maps';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/instagram-scraper', 'lukaskrivka/google-maps']);
        expect(result.actors).toBeUndefined();
    });

    it('should handle URL without query params', () => {
        const url = 'https://actors-mcp-server.apify.actor';
        const result = parseInputParamsFromUrl(url);
        expect(result.actors).toBeUndefined();
    });

    it('should parse enableActorAutoLoading flag', () => {
        const url = 'https://actors-mcp-server.apify.actor?enableActorAutoLoading=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('should parse enableAddingActors flag', () => {
        const url = 'https://actors-mcp-server.apify.actor?enableAddingActors=true';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(true);
    });

    it('should parse enableAddingActors flag', () => {
        const url = 'https://actors-mcp-server.apify.actor?enableAddingActors=false';
        const result = parseInputParamsFromUrl(url);
        expect(result.enableAddingActors).toBe(false);
    });

    it('should handle Actors as string parameter (as tools selectors)', () => {
        const url = 'https://actors-mcp-server.apify.actor?actors=apify/rag-web-browser';
        const result = parseInputParamsFromUrl(url);
        expect(result.tools).toEqual(['apify/rag-web-browser']);
        expect(result.actors).toBeUndefined();
    });
});
