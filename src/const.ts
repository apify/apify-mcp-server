export const SERVER_NAME = 'apify-mcp-server';
export const SERVER_VERSION = '0.1.0';

export const defaults = {
    actors: [
        'apify/instagram-scraper',
        'apify/rag-web-browser',
        'lukaskrivka/google-maps-with-contact-details',
    ],
};

export const ACTOR_OUTPUT_MAX_CHARS_PER_ITEM = 1_000;
export const ACTOR_OUTPUT_TRUNCATED_MESSAGE = `Output was truncated because it will not fit into context.`
    + `There is no reason to call this tool again!`;

export enum Routes {
    ROOT = '/',
    SSE = '/sse',
    MESSAGE = '/message',
}
