import { z } from 'zod';

import log from '@apify/log';

import { ALLOWED_DOC_DOMAINS, FAILURE_CATEGORY, HelperTools, TOOL_STATUS } from '../../const.js';
import { fetchApifyDocsCache } from '../../state.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { classifyFailureCategory } from '../../utils/tool_status.js';
import { fetchApifyDocsToolOutputSchema } from '../structured_output_schemas.js';

const fetchApifyDocsToolArgsSchema = z.object({
    url: z.string()
        .min(1)
        .describe(`URL of the Apify documentation page to fetch. This should be the full URL, including the protocol (e.g., https://docs.apify.com/).`),
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

const ALLOWED_DOC_HOSTS: ReadonlySet<string> = new Set(
    ALLOWED_DOC_DOMAINS.map((d) => new URL(d).hostname),
);

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
You can search for available documentation pages using the ${HelperTools.DOCS_SEARCH} tool.`;
}

export const fetchApifyDocsTool: ToolEntry = Object.freeze({
    type: 'internal',
    name: HelperTools.DOCS_FETCH,
    description: `Fetch the full content of an Apify or Crawlee documentation page by its URL.
Use this after finding a relevant page with the ${HelperTools.DOCS_SEARCH} tool.

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
            return buildMCPResponse({
                texts: [`Invalid URL: "${url}". \
Only documentation URLs from Apify and Crawlee are allowed \
(starting with ${ALLOWED_DOC_DOMAINS.map((d) => `"${d}"`).join(' or ')}). \
Please provide a valid documentation URL. \
You can find documentation URLs using the ${HelperTools.DOCS_SEARCH} tool.`],
                isError: true,
                telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INVALID_INPUT },
            });
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
                    logHttpError(error, 'Failed to fetch the documentation page', { url: mdUrl, statusText: response.statusText });
                    const isUserError = response.status >= 400 && response.status < 500;
                    return buildMCPResponse({
                        texts: [buildFetchErrorMessage(url, `HTTP Status: ${response.status} ${response.statusText}.`)],
                        isError: true,
                        telemetry: {
                            toolStatus: isUserError ? TOOL_STATUS.SOFT_FAIL : TOOL_STATUS.FAILED,
                            failureCategory: classifyFailureCategory(error),
                            failureHttpStatus: response.status,
                        },
                    });
                }
                markdown = await response.text();
                fetchApifyDocsCache.set(urlWithoutFragment, markdown);
            } catch (error) {
                logHttpError(error, 'Failed to fetch the documentation page', { url: mdUrl });
                return buildMCPResponse({
                    texts: [buildFetchErrorMessage(url, `Error: ${error instanceof Error ? error.message : String(error)}.`)],
                    isError: true,
                    telemetry: { toolStatus: TOOL_STATUS.SOFT_FAIL, failureCategory: FAILURE_CATEGORY.INTERNAL_ERROR },
                });
            }
        }

        return buildMCPResponse({ texts: [`Fetched content from ${url}:\n\n${markdown}`], structuredContent: { url, content: markdown } });
    },
} as const);
