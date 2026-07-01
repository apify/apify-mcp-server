import { z } from 'zod';

import log from '@apify/log';

import { ALLOWED_DOC_DOMAINS, HELPER_TOOLS } from '../../const.js';
import { fetchApifyDocsCache } from '../../state.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { TOOL_TYPE } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { logHttpError } from '../../utils/logging.js';
import { respondOk, respondServerError, respondUserError } from '../../utils/mcp.js';
import { fetchApifyDocsToolOutputSchema } from '../structured_output_schemas.js';

const fetchApifyDocsToolArgsSchema = z.object({
    url: z
        .string()
        .min(1)
        .describe(
            `URL of the Apify documentation page to fetch. This should be the full URL, including the protocol (e.g., https://docs.apify.com/).`,
        ),
});

const fetchApifyDocsToolInputSchema = z.toJSONSchema(fetchApifyDocsToolArgsSchema) as ToolInputSchema;

/**
 * Apify/Crawlee docs serve Markdown at `{path}.md`. We append `.md` to the pathname,
 * not the full URL string — otherwise bare-host URLs like `https://docs.apify.com`
 * would become `docs.apify.com.md` (a DNS lookup, not a path).
 */
export function buildMarkdownUrl(url: string): string {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = path ? `${path}.md` : '/index.md';
    return parsed.toString();
}

const ALLOWED_DOC_HOSTS: ReadonlySet<string> = new Set(ALLOWED_DOC_DOMAINS.map((d) => new URL(d).hostname));

// `startsWith` on the raw URL is bypassable via `https://docs.apify.com.evil.com/`
// or `https://docs.apify.com@evil.com/` — parse and compare the hostname instead.
export function isAllowedDocsUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_DOC_HOSTS.has(parsed.hostname);
}

function buildFetchErrorMessage(url: string, detail: string): string {
    return `Failed to fetch the documentation page at "${url}". ${detail} \
Please verify the URL is correct and accessible. \
You can search for available documentation pages using the ${HELPER_TOOLS.DOCS_SEARCH} tool.`;
}

export const fetchApifyDocs: ToolEntry = Object.freeze({
    type: TOOL_TYPE.INTERNAL,
    name: HELPER_TOOLS.DOCS_FETCH,
    title: 'Fetch Apify docs',
    description: `Fetch the full content of an Apify or Crawlee documentation page by its URL.
Use this after finding a relevant page with the ${HELPER_TOOLS.DOCS_SEARCH} tool.

USAGE:
- Use when you need the complete content of a specific docs page for detailed answers.

USAGE EXAMPLES:
- user_input: Fetch https://docs.apify.com/platform/actors/running#builds
- user_input: Fetch https://docs.apify.com/academy
- user_input: Fetch https://crawlee.dev/docs/guides/basic-concepts`,
    inputSchema: fetchApifyDocsToolInputSchema,
    outputSchema: fetchApifyDocsToolOutputSchema,
    ajvValidate: compileSchema(fetchApifyDocsToolInputSchema),
    annotations: {
        title: 'Fetch Apify docs',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args } = toolArgs;

        const parsed = fetchApifyDocsToolArgsSchema.parse(args);
        const url = parsed.url.trim();

        // Allow URLs from Apify and Crawlee documentation
        const isAllowedDomain = isAllowedDocsUrl(url);

        if (!isAllowedDomain) {
            log.softFail(`[fetch-apify-docs] Invalid URL domain: ${url}`);
            return respondUserError(
                `Invalid URL: "${url}". \
Only documentation URLs from Apify and Crawlee are allowed \
(starting with ${ALLOWED_DOC_DOMAINS.map((d) => `"${d}"`).join(' or ')}). \
Please provide a valid documentation URL. \
You can find documentation URLs using the ${HELPER_TOOLS.DOCS_SEARCH} tool.`,
            );
        }

        // Cache by URL without fragment to avoid fetching the same page multiple times
        const urlWithoutFragment = url.split('#')[0];
        let markdown = fetchApifyDocsCache.get(urlWithoutFragment);

        if (!markdown) {
            const mdUrl = buildMarkdownUrl(urlWithoutFragment);
            try {
                const response = await fetch(mdUrl);
                if (!response.ok) {
                    const error = Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), {
                        statusCode: response.status,
                    });
                    logHttpError(error, 'Failed to fetch the documentation page', {
                        url: mdUrl,
                        statusText: response.statusText,
                    });
                    return respondServerError(
                        buildFetchErrorMessage(url, `HTTP Status: ${response.status} ${response.statusText}.`),
                        { error },
                    );
                }
                markdown = await response.text();
                fetchApifyDocsCache.set(urlWithoutFragment, markdown);
            } catch (error) {
                logHttpError(error, 'Failed to fetch the documentation page', { url: mdUrl });
                // A thrown fetch (network/DNS, no statusCode) is a server failure, so classify it FAILED + INTERNAL_ERROR.
                return respondServerError(
                    buildFetchErrorMessage(url, `Error: ${error instanceof Error ? error.message : String(error)}.`),
                    { error },
                );
            }
        }

        return respondOk(`Fetched content from ${url}:\n\n${markdown}`, {
            structuredContent: { url, content: markdown },
        });
    },
} as const);
