export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '0.1.0';

export const defaults = {
    actors: [
        'apify/facebook-posts-scraper',
        'apify/google-search-scraper',
        'apify/instagram-scraper',
        'apify/rag-web-browser',
        'compass/google-maps-extractor',
    ],
};

export enum Routes {
    ROOT = '/',
    SSE = '/sse',
    MESSAGE = '/message',
}
