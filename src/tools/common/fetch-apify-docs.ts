import { z } from 'zod';

import log from '@apify/log';

import { ALLOWED_DOC_DOMAINS, HelperTools, TOOL_STATUS } from '../../const.js';
import { fetchApifyDocsCache } from '../../state.js';
import type { InternalToolArgs, ToolEntry, ToolInputSchema } from '../../types.js';
import { compileSchema } from '../../utils/ajv.js';
import { htmlToMarkdown } from '../../utils/html-to-md.js';
import { logHttpError } from '../../utils/logging.js';
import { buildMCPResponse } from '../../utils/mcp.js';
import { fetchApifyDocsToolOutputSchema } from '../structured-output-schemas.js';

const fetchApifyDocsToolArgsSchema = z.object({
    url: z.string()
        .min(1)
        .describe(`URL of the Apify documentation page to fetch. This should be the full URL, including the protocol (e.g., https://docs.apify.com/).`),
});

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
    inputSchema: z.toJSONSchema(fetchApifyDocsToolArgsSchema) as ToolInputSchema,
    outputSchema: fetchApifyDocsToolOutputSchema,
    ajvValidate: compileSchema(z.toJSONSchema(fetchApifyDocsToolArgsSchema)),
    annotations: {
        title: 'Fetch Apify docs',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    call: async (toolArgs: InternalToolArgs) => {
        const { args } = toolArgs;

        const parsed = fetchApifyDocsToolArgsSchema.parse(args);
        const url = parsed.url.trim();
        const urlWithoutFragment = url.split('#')[0];

        // Allow URLs from Apify and Crawlee documentation
        const isAllowedDomain = ALLOWED_DOC_DOMAINS.some((domain) => url.startsWith(domain));

        if (!isAllowedDomain) {
            log.softFail(`[fetch-apify-docs] Invalid URL domain: ${url}`);
            return buildMCPResponse({
                texts: [`Invalid URL: "${url}".
Only documentation URLs from Apify and Crawlee are allowed (starting with ${ALLOWED_DOC_DOMAINS.map((d) => `"${d}"`).join(' or ')}).
Please provide a valid documentation URL. You can find documentation URLs using the ${HelperTools.DOCS_SEARCH} tool.`],
                isError: true,
                toolStatus: TOOL_STATUS.SOFT_FAIL,
            });
        }

        // Cache URL without fragment to avoid fetching the same page multiple times
        let markdown = fetchApifyDocsCache.get(urlWithoutFragment);
        // If the content is not cached, fetch it from the URL
        if (!markdown) {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    const error = Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), {
                        statusCode: response.status,
                    });
                    logHttpError(error, 'Failed to fetch the documentation page', { url, statusText: response.statusText });
                    // HTTP 4xx = user error (soft_fail), 5xx = server error (will be caught by catch block)
                    const isUserError = response.status >= 400 && response.status < 500;
                    return buildMCPResponse({
                        texts: [`Failed to fetch the documentation page at "${url}".
HTTP Status: ${response.status} ${response.statusText}.
Please verify the URL is correct and accessible. You can search for available documentation pages using the ${HelperTools.DOCS_SEARCH} tool.`],
                        isError: true,
                        toolStatus: isUserError ? TOOL_STATUS.SOFT_FAIL : TOOL_STATUS.FAILED,
                    });
                }
                const html = await response.text();
                markdown = htmlToMarkdown(html);
                // Cache the processed Markdown content
                // Use the URL without fragment as the key to avoid caching same page with different fragments
                fetchApifyDocsCache.set(urlWithoutFragment, markdown);
            } catch (error) {
                logHttpError(error, 'Failed to fetch the documentation page', { url });
                // Network/fetch errors are typically user errors (bad URL, connectivity issues)
                return buildMCPResponse({
                    texts: [`Failed to fetch the documentation page at "${url}".
Error: ${error instanceof Error ? error.message : String(error)}.
Please verify the URL is correct and accessible. You can search for available documentation pages using the ${HelperTools.DOCS_SEARCH} tool.`],
                    isError: true,
                    toolStatus: TOOL_STATUS.SOFT_FAIL,
                });
            }
        }

        return buildMCPResponse({ texts: [`Fetched content from ${url}:\n\n${markdown}`], structuredContent: { url, content: markdown } });
    },
} as const);
