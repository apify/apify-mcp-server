import { stripQuoteWrappers } from './generic.js';

/**
 * Where the `:toolName` of the removed `actorName:toolName` form starts: the first colon after the last slash, so a
 * URL's `scheme://` is not one. -1 when there is none. Index lookups rather than `/:[^/]*$/`, so the time stays
 * linear in the length of the name (see apify/apify-mcp-server-internal#973).
 */
export function getMcpToolNameSuffixIndex(actorName: string): number {
    return actorName.indexOf(':', actorName.lastIndexOf('/') + 1);
}

/**
 * Fixes Actor name strings (`username/name`) before cache + Apify API lookup.
 *
 * LLMs often wrap values in markdown quotes or smart quotes, insert spaces around `/`, and pad the name with `/`.
 * The Apify API treats those as distinct strings → avoidable 404 SOFT_FAIL. This only trims
 * and strips common wrappers / spacing / slash padding noise; valid names pass through unchanged.
 * It also drops the `:toolName` of the removed `actorName:toolName` form, since a name never contains a colon.
 */
export function fixActorNameInput(actorName: string): string {
    const normalized = normalizeActorNameInput(actorName);
    const suffixIndex = getMcpToolNameSuffixIndex(normalized);
    return suffixIndex === -1 ? normalized : normalized.slice(0, suffixIndex).trimEnd();
}

/** {@link fixActorNameInput} without dropping the `:toolName` suffix, so the legacy-syntax check sees the same name. */
export function normalizeActorNameInput(actorName: string): string {
    const s = stripQuoteWrappers(actorName)
        .replace(/\s+/g, ' ')
        .replace(/ ?\/ ?/g, '/');
    return (
        s
            .trim()
            // The lookbehind starts a trailing match only at the start of a slash run, so long runs stay linear.
            .replace(/^\/+|(?<!\/)\/+$/g, '')
    );
}
