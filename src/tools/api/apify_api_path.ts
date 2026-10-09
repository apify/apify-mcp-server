/** A path without its leading slash and `v2/` prefix, as `apify api` takes it: `/v2/actors` becomes `actors`. */
export function normalizeApiPath(path: string): string {
    return path.replace(/^\//, '').replace(/^v2\//i, '');
}

/**
 * Legacy first path segments the API routes to the same handlers as another, keyed by the legacy one. The spec
 * lists only the other: apify-client and the CLI still send `acts`, which the API serves as `actors`. A `Map`,
 * so a segment such as `constructor` never matches an inherited object property.
 */
export const API_PATH_PREFIX_ALIASES: ReadonlyMap<string, string> = new Map([['acts', 'actors']]);
