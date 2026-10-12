/** A path without its leading slash and `v2/` prefix, as `apify api` takes it: `/v2/actors` becomes `actors`. */
export function normalizeApiPath(path: string): string {
    return path.replace(/^\//, '').replace(/^v2\//i, '');
}

/**
 * Legacy names of top-level API resources, mapped to the name the spec lists. The API serves `acts`, which
 * apify-client and the CLI still send, as `actors`. A `Map`, so a name such as `constructor` never matches an
 * inherited object property.
 */
export const API_RESOURCE_ALIASES: ReadonlyMap<string, string> = new Map([['acts', 'actors']]);
