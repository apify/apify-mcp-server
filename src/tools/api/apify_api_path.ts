/** A path without its leading slash and `v2/` prefix, as `apify api` takes it: `/v2/actors` becomes `actors`. */
export function normalizeApiPath(path: string): string {
    return path.replace(/^\//, '').replace(/^v2\//i, '');
}
