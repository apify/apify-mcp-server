/** Apify resource IDs are exactly 17 alphanumeric characters. */
const APIFY_ID_REGEX = /^[a-zA-Z0-9]{17}$/;

/**
 * The API reads an unqualified id as an ID, so a bare resource name has to be prefixed with `~` to be
 * resolved against the authenticated user's own resources. Ids that already carry a username, in either
 * the `username/name` or `username~name` format, and ids that are already IDs, are returned unchanged.
 *
 * Applies to every Apify resource the API addresses by ID or name (Actors, tasks, schedules, ...),
 * which the API resolves the same way.
 */
export function toSafeResourceId(idOrName: string): string {
    const trimmed = idOrName.trim();
    if (trimmed.includes('/') || trimmed.includes('~')) return trimmed;
    return APIFY_ID_REGEX.test(trimmed) ? trimmed : `~${trimmed}`;
}

/** A bare 17-alnum value is shape-identical to an ID and to a legal resource name. */
export function isAmbiguousResourceId(idOrName: string): boolean {
    const trimmed = idOrName.trim();
    return !trimmed.includes('/') && !trimmed.includes('~') && APIFY_ID_REGEX.test(trimmed);
}

/**
 * Fetches a resource by ID, name, or `username/name` through `fetch`, which receives the API-safe id.
 * An ambiguous value cannot be resolved by inspection, so it is read as an ID first and, on a miss,
 * retried as the caller's own resource name.
 */
export async function getResourceByIdOrName<T>(
    idOrName: string,
    fetch: (safeId: string) => Promise<T | undefined>,
): Promise<T | undefined> {
    const resource = await fetch(toSafeResourceId(idOrName));
    if (resource || !isAmbiguousResourceId(idOrName)) return resource;
    return fetch(`~${idOrName.trim()}`);
}
