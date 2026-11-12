import { InvalidRequestPathError } from '../errors.js';

/** Apify resource IDs are exactly 17 alphanumeric characters. */
const APIFY_ID_REGEX = /^[a-zA-Z0-9]{17}$/;

/** Characters of IDs, resource names (letters, digits, `-`), usernames (also `_` and `.`), and the `~` separator. */
const RESOURCE_ID_SEGMENT_REGEX = /^[\w.~-]+$/;

/**
 * Whether apify-client puts `id` into a request path as exactly one segment: an ID, a name, or a `username/name`,
 * `username~name`, `~name` or `/name` reference. apify-client turns the first `/` into `~` and adds nothing else.
 */
export function isValidResourceId(id: string): boolean {
    const segment = id.replace('/', '~');
    return RESOURCE_ID_SEGMENT_REGEX.test(segment) && segment !== '.' && segment !== '..';
}

/** Returns `id`, or throws `InvalidRequestPathError` when `isValidResourceId` rejects it. */
export function assertValidResourceId(id: string, resource: string): string {
    if (!isValidResourceId(id)) {
        throw new InvalidRequestPathError(
            `Invalid ${resource} ID or name "${id}": use an ID, a name, or "username/name"; these contain only letters, digits, "-", "_", "." and "~".`,
        );
    }
    return id;
}

/** Record keys the platform stores: `KEY_VALUE_STORE_KEY_REGEX` in `@apify/consts`. */
const RECORD_KEY_REGEX = /^[a-zA-Z0-9!\-_.'()]{1,256}$/;

/**
 * Returns `key`, or throws `InvalidRequestPathError` when it is not a key the platform stores, or is `.` or `..`, which
 * a URL parser resolves away. Every valid key is a path segment that needs no encoding.
 */
export function assertValidRecordKey(key: string): string {
    if (!RECORD_KEY_REGEX.test(key) || key === '.' || key === '..') {
        throw new InvalidRequestPathError(
            `Invalid record key "${key}": a key has 1 to 256 characters, each a letter, a digit or one of !-_.'().`,
        );
    }
    return key;
}

/**
 * The API reads an unqualified id as an ID, so a bare resource name has to be prefixed with `~` to be
 * resolved against the authenticated user's own resources. Ids that already carry a username, in either
 * the `username/name` or `username~name` format, and ids that are already IDs, are returned unchanged.
 * An invalid value is returned unchanged too, so the client's refusal names it as the caller gave it.
 *
 * Applies to every Apify resource the API addresses by ID or name (Actors, tasks, schedules, ...),
 * which the API resolves the same way.
 */
export function toSafeResourceId(idOrName: string): string {
    const trimmed = idOrName.trim();
    if (trimmed.includes('/') || trimmed.includes('~') || !isValidResourceId(trimmed)) return trimmed;
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
