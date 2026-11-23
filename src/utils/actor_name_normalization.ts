import { stripQuoteWrappers } from './generic.js';

/**
 * Finds the legacy `:toolName` suffix while skipping URL scheme colons.
 * Index lookups keep this linear (apify/apify-mcp-server-internal#973).
 */
export function getMcpToolNameSuffixIndex(actorName: string): number {
    return actorName.indexOf(':', actorName.lastIndexOf('/') + 1);
}

/** Normalizes names before lookup to avoid 404s from stray quotes, spaces, or legacy suffixes. */
export function fixActorNameInput(actorName: string): string {
    const normalized = normalizeActorNameInput(actorName);
    const suffixIndex = getMcpToolNameSuffixIndex(normalized);
    return suffixIndex === -1 ? normalized : normalized.slice(0, suffixIndex).trimEnd();
}

/** Keeps `:toolName` available for the legacy syntax check. */
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
