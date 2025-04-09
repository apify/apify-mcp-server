/**
 * Constants for the Actor.
 */
export const HEADER_READINESS_PROBE = 'x-apify-container-server-readiness-probe';

export const defaults = {
    actors: [
        'apify/instagram-scraper',
        'apify/rag-web-browser',
        'lukaskrivka/google-maps-with-contact-details',
    ],
    enableActorAutoLoading: false,
    maxMemoryMbytes: 4096,
};

export enum Routes {
    ROOT = '/',
    SSE = '/sse',
    MESSAGE = '/message',
}
